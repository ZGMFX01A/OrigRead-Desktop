import { randomUUID } from 'node:crypto'
import type { SecretStore } from '../security/secret-store'
import type { SyncDesktopRunResult, SyncDesktopStatus, SyncDiscoverySnapshot, SyncEndpointConfig, SyncEndpointInput, SyncPeerRegistration } from '../../shared/sync-control'
import type { SyncDiscoveredPeer } from '../../shared/sync-protocol'
import { SyncHttpEndpointSession } from './sync-http-session'
import { DesktopMdnsDiscoveryProvider } from './sync-discovery'
import { SyncStateRepository, type SyncEndpointConfigRecord } from './sync-state-repository'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncSessionCoordinator } from './sync-session-coordinator'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopGenesisSnapshotService, type DesktopGenesisCutoverResult } from './genesis-snapshot-service'

const TOKEN_PREFIX = 'origread.sync.endpoint.token.'

export class DesktopSyncService {
  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly identity: SyncIdentityRepository,
    private readonly sessions: SyncSessionCoordinator,
    private readonly keys: DesktopSyncDeviceSigningKeyStore,
    private readonly secrets: SecretStore,
    private readonly localAccountId: () => number,
    private readonly genesis: DesktopGenesisSnapshotService,
    private readonly beforeRun: (syncSpaceId: string) => void = () => {},
    private readonly isAccountSyncEligible: (localAccountId: number) => boolean = () => true
  ) {}

  status(): SyncDesktopStatus {
    const localAccountId = this.localAccountId()
    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    return {
      localAccountId,
      syncSpaceId: binding?.syncSpaceId ?? null,
      lifecycleState: binding?.lifecycleState ?? null,
      deviceId: device?.deviceId ?? null,
      coverage: binding ? this.state.getCoverage(binding.syncSpaceId) : null,
      endpoints: binding ? this.state.listEndpoints(binding.syncSpaceId).map(toEndpoint) : [],
      lastDiagnostics: binding ? this.state.listEndpoints(binding.syncSpaceId).flatMap((endpoint) => endpoint.lastError ? [endpoint.lastError] : []) : []
    }
  }

  activateGenesis(): DesktopGenesisCutoverResult {
    return this.genesis.run(this.requirePhaseAAccount())
  }

  configureEndpoint(input: SyncEndpointInput): SyncEndpointConfig {
    this.requirePhaseAAccount()
    const parsed = new URL(input.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Sync endpoint URL must use http or https')
    const now = Date.now()
    const endpointId = input.endpointId?.trim() || randomUUID()
    const existing = this.state.findEndpoint(endpointId)
    const record: SyncEndpointConfigRecord = {
      endpointId, syncSpaceId: input.syncSpaceId, kind: input.kind, url: parsed.toString(),
      displayName: input.displayName.trim().slice(0, 200) || parsed.host, enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now, updatedAt: now, lastError: null
    }
    this.state.upsertEndpoint(record)
    if (input.accessToken !== undefined) this.secrets.put(`${TOKEN_PREFIX}${endpointId}`, input.accessToken)
    return toEndpoint(record)
  }

  removeEndpoint(endpointId: string): void {
    this.state.deleteEndpoint(endpointId)
    this.secrets.delete(`${TOKEN_PREFIX}${endpointId}`)
  }

  registerPeer(value: SyncPeerRegistration): { fingerprint: string } {
    this.requirePhaseAAccount()
    const normalized = value.publicKeySpkiBase64.trim()
    if (!normalized) throw new Error('Peer public key is required for pairing')
    this.state.registerPeer({
      syncSpaceId: value.syncSpaceId, deviceId: value.deviceId.trim(), publicKeySpkiBase64: normalized,
      status: 'ACTIVE', authEpoch: value.authEpoch ?? 0, updatedAt: Date.now()
    })
    return { fingerprint: fingerprint(normalized) }
  }

  async run(endpointId: string): Promise<SyncDesktopRunResult> {
    const localAccountId = this.requirePhaseAAccount()
    const endpoint = this.state.findEndpoint(endpointId)
    if (!endpoint || !endpoint.enabled) throw new Error(`Sync endpoint ${endpointId} is not enabled`)
    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    if (!binding || !device) throw new Error('Activate a Sync Space before starting anti-entropy')
    if (endpoint.syncSpaceId !== binding.syncSpaceId) {
      throw new Error(
        `Sync endpoint belongs to ${endpoint.syncSpaceId}, but the active binding is ${binding.syncSpaceId}`
      )
    }
    this.beforeRun(binding.syncSpaceId)
    const session = new SyncHttpEndpointSession({
      baseUrl: endpoint.url,
      syncSpaceId: endpoint.syncSpaceId,
      deviceId: device.deviceId,
      accessToken: this.secrets.get(`${TOKEN_PREFIX}${endpoint.endpointId}`),
      signer: (material) => this.keys.signBase64(device.deviceId, material)
    })
    try {
      const result = await this.sessions.run(binding.syncSpaceId, session, {
        endpointId,
        localAccountId,
        allowStableGc: endpoint.kind === 'SERVER',
        resolvePeerKey: (space, peerDevice) => {
          const peer = this.state.findPeer(space, peerDevice)
          return peer ? { publicKeySpkiBase64: peer.publicKeySpkiBase64, status: peer.status, authEpoch: peer.authEpoch } : null
        }
      })
      this.state.upsertEndpoint({ ...endpoint, lastError: null, updatedAt: Date.now() })
      return { endpointId, ...result }
    } catch (error) {
      this.state.upsertEndpoint({ ...endpoint, lastError: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000), updatedAt: Date.now() })
      throw error
    } finally {
      await session.close()
    }
  }

  async discoverLan(timeoutMs = 1_500): Promise<SyncDiscoverySnapshot> {
    const provider = new DesktopMdnsDiscoveryProvider()
    return provider.discover(timeoutMs)
  }

  publicKeyFingerprint(deviceId?: string): string | null {
    const device = this.runtime.findDeviceIdentity()
    const id = deviceId ?? device?.deviceId
    if (!id) return null
    return fingerprint(this.keys.publicKeySpkiBase64(id))
  }

  private requirePhaseAAccount(): number {
    const localAccountId = this.localAccountId()
    if (!this.isAccountSyncEligible(localAccountId)) {
      throw new Error('R10 Phase A only supports Local Account')
    }
    return localAccountId
  }
}

function toEndpoint(value: SyncEndpointConfigRecord): SyncEndpointConfig {
  return {
    endpointId: value.endpointId, syncSpaceId: value.syncSpaceId, kind: value.kind, url: value.url,
    displayName: value.displayName, enabled: value.enabled, lastError: value.lastError
  }
}

function fingerprint(publicKeySpkiBase64: string): string {
  const digest = Buffer.from(publicKeySpkiBase64, 'base64').toString('hex').match(/.{1,2}/g)?.join(':') ?? ''
  return digest.slice(0, 47).toUpperCase()
}
