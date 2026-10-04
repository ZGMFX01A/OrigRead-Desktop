import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type { SecretStore } from '../security/secret-store'
import type {
  SyncDesktopRunResult,
  SyncDesktopStatus,
  SyncDiscoverySnapshot,
  SyncEndpointConfig,
  SyncEndpointInput,
  SyncPeerRegistration,
  SyncTrustedDeviceSummary,
  SyncNetworkDiagnostics
} from '../../shared/sync-control'
import type { SyncAuthProtocolObject, SyncDiscoveredPeer } from '../../shared/sync-protocol'
import { sha256Hex } from './sync-operation-canonicalizer'
import { authObjectId, authSigningDigest, authSigningMaterial } from './sync-auth-wire'
import { SyncHttpEndpointSession } from './sync-http-session'
import { DesktopMdnsDiscoveryProvider, DesktopMdnsAdvertisementProvider } from './sync-discovery'
import { SyncStateRepository, type SyncEndpointConfigRecord, type SyncTrustedDeviceRecord } from './sync-state-repository'
import { SyncRuntimeRepository, computeActiveGrant } from './sync-runtime-repository'
import { SyncEndpointUrl } from './sync-endpoint-url'
import { SyncSessionCoordinator } from './sync-session-coordinator'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopGenesisSnapshotService, type DesktopGenesisCutoverResult } from './genesis-snapshot-service'
import { DesktopSyncLanListener } from './desktop-sync-lan-listener'
import { DesktopPairingCoordinator, type ActivePairingSession } from './sync-pairing-coordinator'
import { SyncLanPeerTlsClient } from './sync-lan-tls'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import type { SyncApplyCoordinator } from './sync-apply-coordinator'
import type { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import type { DesktopSnapshotInstallService } from './desktop-snapshot-install-service'
import { DesktopSyncRunHistory, type SyncRunHistoryRecord } from './sync-run-history'
import { SyncLanReconnectScheduler } from './sync-lan-reconnect'
import { readLanRequested, writeLanRequested } from './sync-lan-preferences'

const TOKEN_PREFIX = 'origread.sync.endpoint.token.'
/** 正常积压使用短间隔继续，失败仍交给原有错误/重连退避。 */
const CONTINUATION_MS = 1_000
/** 独立于 LAN 开关及网络连接检查本地维护机会，实际工作每日一次。 */
const MAINTENANCE_POLL_MS = 60_000

export class DesktopSyncService {
  private lanListenerInstance: DesktopSyncLanListener | null = null
  private advertisementInstance: DesktopMdnsAdvertisementProvider | null = null
  private readonly pairingCoordinatorInstance: DesktopPairingCoordinator
  private readonly authLedgerInstance: DesktopAuthLedgerService
  private activeLanPort: number | null = null
  private activeLanTlsPort: number | null = null
  private activeDiscoveryId: string | null = null
  private advertisementStatus: { ok: boolean; error: string | null } = { ok: false, error: null }
  private desiredLanEnabled = false
  private lanSuspendedReason: string | null = null
  private lanLifecycleTimer: ReturnType<typeof setInterval> | null = null
  private lanLifecycleBusy = false
  private lanLifecycleTask: Promise<unknown> = Promise.resolve()
  private lastLanInterfaceSignature: string | null = null
  private readonly activeSessions = new Map<string, Set<SyncHttpEndpointSession>>()
  private readonly continuations = new Map<string, ReturnType<typeof setTimeout>>()
  private businessDataChangedListener?: (localAccountId: number) => void
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private readonly reconnect = new SyncLanReconnectScheduler({
    discover: async (signal) => { await this.discoverLan(1_500, signal) },
    sync: async (signal) => {
      const binding = this.runtime.findBinding(this.localAccountId())
      if (!binding) return
      const failures: unknown[] = []
      for (const endpoint of this.state.listEndpoints(binding.syncSpaceId)) {
        signal.throwIfAborted()
        if (!endpoint.enabled || !endpoint.endpointId.startsWith('lan:')) continue
        try { await this.run(endpoint.endpointId, signal) } catch (error) {
          // 一台离线设备不阻止其他在线设备收敛；仍向调度器暴露本轮失败以进入退避。
          failures.push(error)
        }
      }
      if (failures.length) throw new AggregateError(failures, 'LAN peer synchronization failed')
    },
    onError: (error) => console.error('LAN rediscovery/sync failed:', error)
  })

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
    private readonly isAccountSyncEligible: (localAccountId: number) => boolean = () => true,
    private readonly apply?: SyncApplyCoordinator,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
    private readonly snapshotInstaller?: DesktopSnapshotInstallService
  ) {
    this.desiredLanEnabled = readLanRequested(this.runtime.databaseHandle())
    this.authLedgerInstance = new DesktopAuthLedgerService(this.runtime, this.state, this.apply)
    this.maintenanceTimer = setInterval(() => {
      try {
        const binding = this.runtime.findBinding(this.localAccountId())
        if (binding) this.sessions.maintainLocal(binding.syncSpaceId)
      } catch (error) { console.error('Local Sync maintenance failed:', error) }
    }, MAINTENANCE_POLL_MS)
    this.maintenanceTimer.unref?.()
    this.pairingCoordinatorInstance = new DesktopPairingCoordinator(
      this.runtime,
      this.state,
      this.keys,
      this.authLedgerInstance,
      this.localAccountId,
      () => this.activeLanTlsPort ?? 0,
      (syncSpaceId, localAccountId, now) => {
        const report = this.genesis.backfillIdentitiesForSpace(syncSpaceId, localAccountId, now)
        if (report.conflicts.length > 0) {
          throw new Error(`Space join identity backfill found ${report.conflicts.length} canonical identity conflict(s)`)
        }
      }
    )
  }

  status(): SyncDesktopStatus {
    const localAccountId = this.localAccountId()
    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    return {
      localAccountId,
      syncSpaceId: binding?.syncSpaceId ?? null,
      lifecycleState: binding?.lifecycleState ?? null,
      snapshotInstalling: binding ? this.snapshotInstaller?.snapshotJobs?.isInstalling(binding.syncSpaceId) ?? false : false,
      deviceId: device?.deviceId ?? null,
      coverage: binding ? this.state.getCoverage(binding.syncSpaceId) : null,
      endpoints: binding ? this.state.listEndpoints(binding.syncSpaceId).map(toEndpoint) : [],
      lastDiagnostics: binding ? this.state.listEndpoints(binding.syncSpaceId).flatMap((endpoint) => endpoint.lastError ? [endpoint.lastError] : []) : [],
      isLanRequested: this.desiredLanEnabled,
      isLanEnabled: this.activeLanPort !== null,
      lanPort: this.activeLanPort,
      lanSuspendedReason: this.lanSuspendedReason
    }
  }

  activateGenesis(): Promise<DesktopGenesisCutoverResult> {
    return this.genesis.runPagedAsync({ localAccountId: this.requirePhaseAAccount() })
  }

  configureEndpoint(input: SyncEndpointInput): SyncEndpointConfig {
    this.requirePhaseAAccount()
    const parsed = new SyncEndpointUrl(input.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Sync endpoint URL must use http or https')
    if ((input.kind === 'LAN' || input.kind === 'MANUAL') && parsed.protocol === 'http:') {
      upgradeLegacyLanEndpointUrl(parsed)
    }
    const now = Date.now()
    const endpointId = input.endpointId?.trim() || randomUUID()
    const existing = this.state.findEndpoint(endpointId)
    const normalizedUrl = parsed.toString()
    if (
      existing &&
      (existing.syncSpaceId !== input.syncSpaceId || existing.url !== normalizedUrl || existing.kind !== input.kind)
    ) {
      this.state.deleteCursor(endpointId)
    }
    const record: SyncEndpointConfigRecord = {
      endpointId, syncSpaceId: input.syncSpaceId, kind: input.kind, url: normalizedUrl,
      displayName: input.displayName.trim().slice(0, 200) || parsed.host, enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now, updatedAt: now, lastError: null
    }
    this.state.upsertEndpoint(record)
    if (input.accessToken !== undefined) this.secrets.put(`${TOKEN_PREFIX}${endpointId}`, input.accessToken)
    return toEndpoint(record)
  }

  removeEndpoint(endpointId: string): void {
    for (const session of this.activeSessions.get(endpointId) ?? []) void session.close()
    this.state.deleteCursor(endpointId)
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

  async run(endpointId: string, signal?: AbortSignal): Promise<SyncDesktopRunResult> {
    signal?.throwIfAborted()
    const localAccountId = this.requirePhaseAAccount()
    let endpoint = this.state.findEndpoint(endpointId)
    if (!endpoint || !endpoint.enabled) throw new Error(`Sync endpoint ${endpointId} is not enabled`)
    if ((endpoint.kind === 'LAN' || endpoint.kind === 'MANUAL' || endpoint.endpointId.startsWith('lan:')) && endpoint.url.startsWith('http://')) {
      const secureUrl = new SyncEndpointUrl(endpoint.url)
      upgradeLegacyLanEndpointUrl(secureUrl)
      endpoint = { ...endpoint, url: secureUrl.toString(), updatedAt: Date.now() }
      this.state.upsertEndpoint(endpoint)
    }
    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    if (!binding || !device) throw new Error('Activate a Sync Space before starting anti-entropy')
    if (endpoint.syncSpaceId !== binding.syncSpaceId) {
      throw new Error(
        `Sync endpoint belongs to ${endpoint.syncSpaceId}, but the active binding is ${binding.syncSpaceId}`
      )
    }
    const history = new DesktopSyncRunHistory(this.runtime.databaseHandle())
    let runHistory: SyncRunHistoryRecord = history.start(
      binding.syncSpaceId,
      endpoint.endpointId,
      endpoint.kind,
      endpoint.endpointId.startsWith('lan:') ? endpoint.endpointId.slice(4) : null
    )
    let session: SyncHttpEndpointSession | null = null
    try {
      this.beforeRun(binding.syncSpaceId)
      let peerPublicKeySpkiBase64: string | undefined
      if ((endpoint.kind === 'LAN' || endpoint.kind === 'MANUAL') && !endpoint.endpointId.startsWith('lan:')) {
        throw new Error('AUTH_FAILED: LAN endpoint must identify a paired device')
      }
      if (endpoint.endpointId.startsWith('lan:')) {
        const peerDeviceId = endpoint.endpointId.slice(4)
        const peer = this.state.findPeer(endpoint.syncSpaceId, peerDeviceId)
        const trust = this.state.findTrustedDevice(endpoint.syncSpaceId, peerDeviceId)
        if (!peer || peer.status !== 'ACTIVE' || trust?.trustState !== 'TRUSTED' ||
          !computeActiveGrant(this.runtime.listAuthObjects(endpoint.syncSpaceId), peerDeviceId)) {
          throw new Error('AUTH_REVOKED: LAN peer has no active trust and member authorization')
        }
        peerPublicKeySpkiBase64 = peer?.publicKeySpkiBase64
      }
      session = new SyncHttpEndpointSession({
        baseUrl: endpoint.url,
        syncSpaceId: endpoint.syncSpaceId,
        deviceId: device.deviceId,
        accessToken: this.secrets.get(`${TOKEN_PREFIX}${endpoint.endpointId}`),
        signer: (material) => this.keys.signBase64(device.deviceId, material),
        peerPublicKeySpkiBase64,
        localBindAddress: endpoint.localBindAddress ?? undefined,
        signal,
        authorizeRequest: endpoint.endpointId.startsWith('lan:') ? () => {
          const peerId = endpoint!.endpointId.slice(4)
          if (this.state.findPeer(binding.syncSpaceId, peerId)?.status !== 'ACTIVE' ||
            this.state.findTrustedDevice(binding.syncSpaceId, peerId)?.trustState !== 'TRUSTED' ||
            !computeActiveGrant(this.runtime.listAuthObjects(binding.syncSpaceId), peerId)) {
            throw new Error('AUTH_REVOKED: LAN transport peer has been revoked')
          }
        } : undefined
      })
      const active = this.activeSessions.get(endpointId) ?? new Set<SyncHttpEndpointSession>()
      active.add(session)
      this.activeSessions.set(endpointId, active)
      const result = await this.sessions.run(binding.syncSpaceId, session, {
        endpointId,
        localAccountId,
        automaticMaintenance: true,
        onProgress: (progress) => {
          runHistory = history.progress(runHistory, progress)
        },
        resolvePeerKey: (space, peerDevice) => {
          const peer = this.state.findPeer(space, peerDevice)
          return peer ? { publicKeySpkiBase64: peer.publicKeySpkiBase64, status: peer.status, authEpoch: peer.authEpoch } : null
        }
      })
      runHistory = history.progress(runHistory, {
        stage: 'FINALIZING',
        pushedOperations: result.pushedOperationIds.length,
        pulledOperations: result.pulledOperationIds.length,
        appliedOperations: result.appliedOperationIds.length,
        rejectedOperations: result.rejectedOperationIds.length,
        blobBytesSent: result.blobBytesSent,
        blobBytesReceived: result.blobBytesReceived
      })
      runHistory = history.succeed(runHistory, result.status === 'MORE_WORK' ? 'MORE_WORK' : result.maintenanceStatus === 'AUTH_STABILITY_PENDING' ? 'AUTH_STABILITY_PENDING' : 'COMPLETED')
      const current = this.state.findEndpoint(endpointId)
      if (current) this.state.upsertEndpoint({ ...current, lastError: null, updatedAt: Date.now() })
      if (result.status === 'MORE_WORK' && !this.continuations.has(endpointId)) {
        const timer = setTimeout(() => {
          this.continuations.delete(endpointId)
          if (signal?.aborted || !this.state.findEndpoint(endpointId)?.enabled) return
          void this.run(endpointId, signal).catch(error => console.error('Sync continuation failed:', error))
        }, CONTINUATION_MS)
        timer.unref?.()
        this.continuations.set(endpointId, timer)
      }
      return { endpointId, ...result }
    } catch (error) {
      runHistory = history.fail(runHistory, error)
      // 撤销/删除可能发生在运行期间，不能用旧记录恢复端点或重新启用它。
      const current = this.state.findEndpoint(endpointId)
      if (current) this.state.upsertEndpoint({ ...current, lastError: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000), updatedAt: Date.now() })
      throw error
    } finally {
      await session?.close()
      if (session) this.activeSessions.get(endpointId)?.delete(session)
      if (this.activeSessions.get(endpointId)?.size === 0) this.activeSessions.delete(endpointId)
      // 后续网络步骤失败也可能已有业务事务提交，界面仍需读取真实已应用状态。
      this.businessDataChangedListener?.(localAccountId)
    }
  }

  /** 接入宿主界面通知；同步服务只报告发生变化的账户，不依赖 Electron。 */
  setBusinessDataChangedListener(listener: (localAccountId: number) => void): void {
    this.businessDataChangedListener = listener
  }

  listRunHistory(limit = 100): SyncRunHistoryRecord[] {
    const binding = this.runtime.findBinding(this.localAccountId())
    if (!binding) return []
    return new DesktopSyncRunHistory(this.runtime.databaseHandle()).list(binding.syncSpaceId, limit)
  }

  async discoverLan(timeoutMs = 1_500, signal?: AbortSignal): Promise<SyncDiscoverySnapshot> {
    const provider = new DesktopMdnsDiscoveryProvider()
    const discovered = await provider.discover(timeoutMs)
    // 匿名发现标识只用于过滤本机广播，不替代后续对端签名认证。
    const snapshot = { ...discovered, peers: discovered.peers.filter((peer) => peer.deviceId !== this.activeDiscoveryId) }
    signal?.throwIfAborted()

    // 遵循 C02 修复：使用长期公钥签名挑战认证对端真实身份，杜绝未认证 healthz 伪造劫持已信任设备地址
    const localAccountId = this.localAccountId()
    const binding = this.runtime.findBinding(localAccountId)
    if (binding && snapshot.peers.length > 0) {
      const trusted = this.state.listTrustedDevices(binding.syncSpaceId)
      let firstPeerError: string | null = null
      // 逐个认证候选，周期发现不能按不可信广播数量扩张连接并发。
      for (const peer of snapshot.peers) {
          signal?.throwIfAborted()
          let tlsPeer: SyncLanPeerTlsClient | null = null
          try {
            if (peer.protocol !== 'https') {
              throw new Error('Discovered peer does not advertise the required TLS transport; update the peer app before pairing')
            }
            if (peer.port < 1 || peer.port > 65_534) throw new Error('Discovered LAN bootstrap port cannot be paired with a TLS port')
            const syncUrl = formatSyncUrl(peer.host, peer.port + 1)
            tlsPeer = await SyncLanPeerTlsClient.connect(
              syncUrl,
              undefined,
              undefined,
              1_500,
              peer.localBindAddress
            )
            const matched = trusted.find((t) => t.deviceId === tlsPeer?.identity.deviceId)
            if (matched) {
              if (matched.trustState !== 'TRUSTED') throw new Error('LAN peer trust is revoked; pair again before syncing')
              if (matched.staticPublicKey !== tlsPeer.identity.publicKeySpkiBase64) {
                throw new Error('LAN peer identity key changed; pair this device again before syncing')
              }
            }
            const health = await tlsPeer.fetch(`${syncUrl}/healthz`, { signal: AbortSignal.timeout(1_500) })
            if (!health.ok) throw new Error(`TLS health check failed: HTTP ${health.status}`)
            await health.body?.cancel()

            if (matched) {
              signal?.throwIfAborted()
              const endpointId = `lan:${matched.deviceId}`
              const existing = this.state.findEndpoint(endpointId)
              if (
                !existing ||
                existing.url !== syncUrl ||
                existing.localBindAddress !== (peer.localBindAddress ?? null) ||
                existing.syncSpaceId !== matched.syncSpaceId
              ) {
                this.state.upsertEndpoint({
                  endpointId,
                  syncSpaceId: matched.syncSpaceId,
                  kind: 'LAN',
                  url: syncUrl,
                  displayName: peer.displayName,
                  enabled: existing?.enabled ?? true,
                  localBindAddress: peer.localBindAddress ?? null,
                  lastError: null,
                  createdAt: existing?.createdAt ?? Date.now(),
                  updatedAt: Date.now()
                })
              }
            }
          } catch (error) {
            if (!firstPeerError) firstPeerError = error instanceof Error ? error.message : String(error)
          } finally {
            tlsPeer?.close()
          }
      }
      if (firstPeerError && !snapshot.diagnostic) {
        snapshot.diagnostic = { code: 'TLS_PEER_UNAVAILABLE', message: firstPeerError, retryable: true, at: Date.now() }
      }
    }

    return snapshot
  }

  publicKeyFingerprint(deviceId?: string): string | null {
    const device = this.runtime.findDeviceIdentity()
    const id = deviceId ?? device?.deviceId
    if (!id) return null
    return fingerprint(this.keys.publicKeySpkiBase64(id))
  }

  async setLanSyncEnabled(enabled: boolean): Promise<{ enabled: boolean; port: number | null }> {
    return this.serializeLanLifecycle(() => this.updateLanSyncEnabled(enabled))
  }

  /** 用户开关与启动恢复按到达顺序执行，避免旧监听在关闭操作后才发布。 */
  private async updateLanSyncEnabled(enabled: boolean): Promise<{ enabled: boolean; port: number | null }> {
    writeLanRequested(this.runtime.databaseHandle(), enabled)
    this.desiredLanEnabled = enabled
    if (!enabled) {
      this.stopLanLifecycleMonitor()
      this.lanSuspendedReason = null
      try { await this.pauseLanSnapshots() }
      finally { await this.stopLanRuntime() }
      return { enabled: false, port: null }
    }
    const result = await this.startLanRuntime()
    this.startLanLifecycleMonitor()
    return result
  }

  async suspendLanForSystem(reason = 'SYSTEM_SUSPEND'): Promise<void> {
    return this.serializeLanLifecycle(async () => {
      if (!this.desiredLanEnabled) return
      this.lanSuspendedReason = reason
      await this.stopLanRuntime()
    })
  }

  /** 显式用户关闭通知拥有者和已受理远端作业；系统挂起只关闭连接。 */
  private async pauseLanSnapshots(): Promise<void> {
    const binding = this.runtime.findBinding(this.localAccountId())
    if (!binding) return
    const endpoints = this.state.listEndpoints(binding.syncSpaceId).filter(endpoint => endpoint.kind === 'LAN')
    this.genesis.snapshotOwners?.requestCancel(binding.syncSpaceId)
    this.snapshotInstaller?.snapshotJobs?.cancelForSpace(binding.syncSpaceId)
    for (const space of new Set(endpoints.map(endpoint => endpoint.syncSpaceId))) {
      this.genesis.snapshotOwners?.requestCancel(space)
      this.snapshotInstaller?.snapshotJobs?.cancelForSpace(space)
    }
    const results = await Promise.allSettled(endpoints.flatMap(endpoint =>
      [...(this.activeSessions.get(endpoint.endpointId) ?? [])].map(session => session.requestSnapshotPause())))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Remote snapshot cancellation was not acknowledged')
  }

  async resumeLanAfterSystem(): Promise<void> {
    return this.serializeLanLifecycle(async () => {
      if (!this.desiredLanEnabled) return
      this.lanSuspendedReason = null
      await this.startLanRuntime()
      this.startLanLifecycleMonitor()
    })
  }

  /** 队列只负责排序；上一项失败后仍可关闭，原任务的拒绝继续交给调用者处理。 */
  private serializeLanLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lanLifecycleTask.then(operation, operation)
    this.lanLifecycleTask = result
    return result
  }

  private async startLanRuntime(): Promise<{ enabled: boolean; port: number | null }> {
    if (!this.desiredLanEnabled || this.lanListenerInstance) {
      return { enabled: this.activeLanPort !== null, port: this.activeLanPort }
    }
    const localAccountId = this.requirePhaseAAccount()
    const binding = this.runtime.findBinding(localAccountId)
    const device = this.runtime.findDeviceIdentity()
    if (!binding || !device) throw new Error('Sync Space or device identity is not initialized')

    const selection = desktopLanInterfaceSelection()
    if (!selection.hasUsableLanAddress) {
      this.lanSuspendedReason = 'NO_LAN_INTERFACE'
      return { enabled: false, port: null }
    }

    const listener = new DesktopSyncLanListener(
      this.runtime,
      this.state,
      this.keys,
      this.authLedgerInstance,
      this.apply ?? ({} as any),
      this.pairingCoordinatorInstance,
      this.localBlobStore,
      { port: 0, host: '::', onBusinessDataChanged: (space) => {
        const binding = this.runtime.findBindingBySpace(space)
        if (binding) this.businessDataChangedListener?.(binding.localAccountId)
      } },
      this.genesis,
      this.snapshotInstaller,
      this.localAccountId
    )
    const { port } = await listener.listen()
    this.lanListenerInstance = listener
    this.activeLanPort = port
    this.activeLanTlsPort = listener.tlsPort

    const discoveryId = `desk-${randomUUID().replace(/-/g, '').slice(0, 12)}`
    this.activeDiscoveryId = discoveryId
    const advertisement = new DesktopMdnsAdvertisementProvider({
      port,
      deviceId: discoveryId,
      discoveryId,
      displayName: 'OrigRead Desktop',
      hostAddress: selection.ipv4,
      hostIpv6Address: selection.ipv6,
      protocol: 'https'
    })
    try {
      await advertisement.start()
      this.advertisementStatus = { ok: true, error: null }
    } catch (error) {
      this.advertisementStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.advertisementInstance = advertisement
    this.lastLanInterfaceSignature = selection.signature
    this.lanSuspendedReason = null
    this.reconnect.start()
    return { enabled: true, port }
  }

  private async stopLanRuntime(): Promise<void> {
    this.reconnect.stop()
    // 停止不仅取消下一轮，还关闭手动/自动 LAN 出站会话及正在读取的正文。
    for (const [endpointId, sessions] of this.activeSessions) {
      if (endpointId.startsWith('lan:')) for (const session of sessions) await session.close()
    }
    if (this.advertisementInstance) {
      await this.advertisementInstance.close()
      this.advertisementInstance = null
    }
    if (this.lanListenerInstance) {
      // 关闭失败必须返回调用方，不能清空实例并把仍在监听的服务显示成已关闭。
      await this.lanListenerInstance.close()
      this.lanListenerInstance = null
    }
    this.activeLanPort = null
    this.activeLanTlsPort = null
    this.activeDiscoveryId = null
    this.advertisementStatus = { ok: false, error: null }
  }

  private startLanLifecycleMonitor(): void {
    if (this.lanLifecycleTimer) return
    this.lanLifecycleTimer = setInterval(() => {
      void this.reconcileLanInterfaces().catch((error) => {
        // 网卡重建失败保留用户意图，并完整暴露原因以便下一轮排查。
        console.error('LAN interface reconciliation failed:', error)
      })
    }, 3_000)
    this.lanLifecycleTimer.unref?.()
  }

  private stopLanLifecycleMonitor(): void {
    if (!this.lanLifecycleTimer) return
    clearInterval(this.lanLifecycleTimer)
    this.lanLifecycleTimer = null
  }

  private async reconcileLanInterfaces(): Promise<void> {
    if (!this.desiredLanEnabled || this.lanLifecycleBusy || this.lanSuspendedReason === 'SYSTEM_SUSPEND') return
    this.lanLifecycleBusy = true
    try {
      await this.serializeLanLifecycle(() => this.refreshLanInterfaces())
    } finally {
      this.lanLifecycleBusy = false
    }
  }

  /** 进入队列后再检查最新开关和系统状态，过期的网卡检查不重新打开监听。 */
  private async refreshLanInterfaces(): Promise<void> {
    if (!this.desiredLanEnabled || this.lanSuspendedReason === 'SYSTEM_SUSPEND') return
    const selection = desktopLanInterfaceSelection()
    if (!selection.hasUsableLanAddress) {
      this.lanSuspendedReason = 'NO_LAN_INTERFACE'
      await this.stopLanRuntime()
      return
    }
    if (!this.lanListenerInstance || this.lastLanInterfaceSignature !== selection.signature) {
      await this.stopLanRuntime()
      this.lanSuspendedReason = null
      await this.startLanRuntime()
    }
  }

  getPairingCoordinator(): DesktopPairingCoordinator {
    return this.pairingCoordinatorInstance
  }

  async initiatePairing(targetHost: string, targetPort: number, localBindAddress?: string): Promise<ActivePairingSession> {
    this.requirePhaseAAccount()
    return this.pairingCoordinatorInstance.initiatePairing(
      targetHost,
      targetPort,
      'MATCH_OR_JOIN',
      localBindAddress
    )
  }

  async confirmPairingSession(sessionId: string): Promise<ActivePairingSession> {
    this.requirePhaseAAccount()
    return this.pairingCoordinatorInstance.confirmSession(sessionId)
  }

  async cancelPairingSession(sessionId: string): Promise<void> {
    return this.pairingCoordinatorInstance.cancelSession(sessionId)
  }

  listTrustedDevices(): SyncTrustedDeviceSummary[] {
    const localAccountId = this.localAccountId()
    const binding = this.runtime.findBinding(localAccountId)
    if (!binding) return []
    const devices = this.state.listTrustedDevices(binding.syncSpaceId)
    const history = this.runtime.listAuthObjects(binding.syncSpaceId)
    const ownerId = history.at(-1)?.ownerDeviceId

    return devices.map((dev) => ({
      id: dev.id,
      syncSpaceId: dev.syncSpaceId,
      deviceId: dev.deviceId,
      staticPublicKey: dev.staticPublicKey,
      fingerprint: dev.fingerprint,
      displayName: dev.displayName,
      platform: dev.platform,
      trustState: dev.trustState,
      pairedAt: dev.pairedAt,
      lastSeenAt: dev.lastSeenAt,
      authEpoch: dev.authEpoch,
      isOwner: dev.deviceId === ownerId
    }))
  }

  revokeTrustedDevice(deviceId: string): void {
    const localAccountId = this.requirePhaseAAccount()
    const binding = this.runtime.findBinding(localAccountId)
    const localDevice = this.runtime.findDeviceIdentity()
    if (!binding || !localDevice) throw new Error('Sync Space or device identity is not initialized')

    const history = this.runtime.listAuthObjects(binding.syncSpaceId)
    const head = history.at(-1)
    if (!head || head.ownerDeviceId !== localDevice.deviceId) {
      throw new Error('Only the current OWNER device may revoke member authorization')
    }

    // 写入符合 R10 AUTH 规范的 MEMBER_REVOKE 到 AUTH Ledger (修复 B10)
    const payloadJson = '{}'
    const payloadHash = sha256Hex(payloadJson)
    const nextSequence = (head.authSequence ?? 0) + 1
    const objectId = authObjectId(binding.syncSpaceId, head.authEpoch, 'MEMBER_REVOKE', localDevice.deviceId, payloadHash, nextSequence)

    const unsignedRevoke: SyncAuthProtocolObject = {
      protocolVersion: 1,
      authObjectId: objectId,
      syncSpaceId: binding.syncSpaceId,
      authEpoch: head.authEpoch,
      authSequence: nextSequence,
      objectType: 'MEMBER_REVOKE',
      authorDeviceId: localDevice.deviceId,
      ownerDeviceId: head.ownerDeviceId,
      targetDeviceId: deviceId,
      previousEpochFinalAcceptedPrefixByActorLane: {},
      revokeCutoffByActorLane: this.state.getCoverage(binding.syncSpaceId).retained,
      payloadJson,
      payloadHash,
      signingDigest: '',
      authorSignature: ''
    }

    const signingDigest = authSigningDigest(unsignedRevoke)
    const authorSignature = this.keys.signBase64(localDevice.deviceId, authSigningMaterial(unsignedRevoke))
    const revokeObject: SyncAuthProtocolObject = {
      ...unsignedRevoke,
      signingDigest,
      authorSignature
    }
    this.authLedgerInstance.append(binding.syncSpaceId, [revokeObject])

    // 更新本地 trusted_device 状态
    this.state.updateTrustedDeviceState(binding.syncSpaceId, deviceId, 'REVOKED', head.authEpoch, Date.now())
    this.state.registerPeer({
      syncSpaceId: binding.syncSpaceId,
      deviceId,
      publicKeySpkiBase64: this.state.findPeer(binding.syncSpaceId, deviceId)?.publicKeySpkiBase64 ?? '',
      status: 'REVOKED',
      authEpoch: head.authEpoch,
      updatedAt: Date.now()
    })
    // 本端负责停止向被撤销设备发送业务数据，不能依赖远端主动遵守撤销。
    const endpointId = `lan:${deviceId}`
    const endpoint = this.state.findEndpoint(endpointId)
    if (endpoint) this.state.upsertEndpoint({ ...endpoint, enabled: false, updatedAt: Date.now() })
    for (const session of this.activeSessions.get(endpointId) ?? []) void session.close()
  }

  /**
   * 手动连接指定的局域网对端地址
   * 1. 规范化 IPv4/IPv6 与端口 (B24)
   * 2. 探针 /healthz 获取设备身份并检测连通性 (B22)
   * 3. 若为新设备，自动触发配对与 SAS 握手 (B22)
   * 4. 若为已受信任设备，更新 endpoint 并执行增量同步
   */
  async connectManual(urlOrHost: string): Promise<SyncDesktopRunResult> {
    this.requirePhaseAAccount()
    let normalized = urlOrHost.trim()
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      if (normalized.startsWith('[')) {
        // 已有方括号，如 [2001:db8::1] 或 [2001:db8::1]:8787
        const closeIdx = normalized.indexOf(']')
        const portPart = normalized.slice(closeIdx + 1)
        normalized = portPart.startsWith(':') ? `https://${normalized}` : `https://${normalized}:8787`
      } else {
        const colons = normalized.split(':').length - 1
        if (colons > 1) {
          // 裸 IPv6 地址（包含多个冒号且未加方括号），如 2001:db8::1 或 fe80::1%eth0
          normalized = `https://[${normalized.replaceAll('%', '%25')}]:8787`
        } else if (colons === 1) {
          // 单个冒号，如 desktop:8787 或 192.168.1.10:8787
          normalized = `https://${normalized}`
        } else {
          // 无冒号，如 desktop 或 192.168.1.10
          normalized = `https://${normalized}:8787`
        }
      }
    }
    const parsed = new SyncEndpointUrl(normalized)
    if (parsed.protocol === 'http:') parsed.protocol = 'https:'
    if (parsed.protocol !== 'https:') throw new Error('Manual LAN peer must use HTTPS')
    const binding = this.runtime.findBinding(this.localAccountId())
    if (!binding) throw new Error('Active Sync Space binding is required')
    const trusted = this.state.listTrustedDevices(binding.syncSpaceId)

    const targetHost = parsed.socketHostname
    const targetPort = parsed.port ? parseInt(parsed.port, 10) : 8787
    if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65_534) {
      throw new Error('LAN bootstrap port must be between 1 and 65534')
    }
    const secureBaseUrl = formatSyncUrl(targetHost, targetPort + 1)
    const localBindAddress = inferManualLanBindAddress(targetHost)

    // 探测对端健康状态 (B22: 手动连接探测与诊断)
    let peerDeviceId: string | null = null
    let peerStaticKey: string | null = null
    let tlsPeer: SyncLanPeerTlsClient | null = null
    let knownPeer: SyncTrustedDeviceRecord | undefined
    try {
      tlsPeer = await SyncLanPeerTlsClient.connect(
        secureBaseUrl,
        undefined,
        undefined,
        3_000,
        localBindAddress
      )
      knownPeer = trusted.find((peer) => peer.deviceId === tlsPeer?.identity.deviceId)
      if (knownPeer?.trustState === 'TRUSTED' && knownPeer.staticPublicKey !== tlsPeer.identity.publicKeySpkiBase64) {
        throw new Error('LAN peer identity key changed; pair this device again before syncing')
      }
      const probeRes = await tlsPeer.fetch(`${secureBaseUrl}/healthz`, { signal: AbortSignal.timeout(3_000) })
      if (!probeRes.ok) {
        throw new Error(`Remote peer returned HTTP ${probeRes.status}`)
      }
      await probeRes.body?.cancel()
      peerDeviceId = tlsPeer.identity.deviceId
      peerStaticKey = tlsPeer.identity.publicKeySpkiBase64
    } catch (probeError) {
      throw new Error(`PEER_UNREACHABLE: Cannot connect to manual endpoint (${parsed.host}). Note: Manual connection cannot bypass AP isolation, firewall blocks, or VPN routing conflicts. Detail: ${probeError instanceof Error ? probeError.message : String(probeError)}`)
    } finally {
      tlsPeer?.close()
    }

    // 检查是否为已受信任设备 (B22)
    const trustedPeer = peerDeviceId && knownPeer?.trustState === 'TRUSTED' ? knownPeer : undefined
    const isTrusted = Boolean(trustedPeer && trustedPeer.staticPublicKey === peerStaticKey)

    if (!isTrusted) {
      // 未信任设备：触发 SAS 配对握手流程并通知用户
      const session = await this.pairingCoordinatorInstance.initiatePairing(
        targetHost,
        targetPort,
        'MATCH_OR_JOIN',
        localBindAddress
      )
      throw new Error(`PAIRING_REQUIRED: 目标设备 (${parsed.host}) 尚未配对。已自动向目标发起配对握手（会话ID: ${session.sessionId}，SAS验证码: ${session.sasCode}）。请在两端设备核对并确认 SAS 码后即可建立双向信任并同步。`)
    }

    const endpointId = peerDeviceId ? `lan:${peerDeviceId}` : `manual:${parsed.host}`
    const endpointConfig = this.configureEndpoint({
      endpointId,
      syncSpaceId: binding.syncSpaceId,
      kind: peerDeviceId ? 'LAN' : 'MANUAL',
      url: secureBaseUrl,
      displayName: `Manual (${parsed.host})`,
      enabled: true,
      localBindAddress
    })
    return this.run(endpointConfig.endpointId)
  }

  async diagnostics(): Promise<SyncNetworkDiagnostics> {
    const rawInterfaces = networkInterfaces()
    const list: SyncNetworkDiagnostics['interfaces'] = []
    const selection = desktopLanInterfaceSelection()
    const warnings: string[] = []

    for (const [name, addrs] of Object.entries(rawInterfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        list.push({
          name,
          address: addr.address,
          family: String(addr.family),
          internal: addr.internal
        })
      }
    }

    if (!selection.hasUsableLanAddress) {
      warnings.push('No usable physical LAN interface detected; VPN/TUN/virtual adapters are not treated as LAN reachability')
    }
    if (this.advertisementStatus.error) {
      warnings.push(`mDNS advertisement error: ${this.advertisementStatus.error}`)
    }
    if (process.platform === 'win32') {
      warnings.push('Windows Defender Firewall may block incoming mDNS (UDP 5353) or HTTP sync ports if network is Public')
    }

    return {
      interfaces: list,
      hasUsableLanAddress: selection.hasUsableLanAddress,
      multicastBindOk: this.advertisementStatus.ok,
      firewallSuspected:
        process.platform === 'win32' &&
        selection.hasUsableLanAddress &&
        !this.advertisementStatus.ok,
      warnings
    }
  }

  async close(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    for (const timer of this.continuations.values()) clearTimeout(timer)
    this.continuations.clear()
    return this.serializeLanLifecycle(async () => {
      this.desiredLanEnabled = false
      this.stopLanLifecycleMonitor()
      await this.stopLanRuntime()
    })
  }

  private requirePhaseAAccount(): number {
    const localAccountId = this.localAccountId()
    if (!this.isAccountSyncEligible(localAccountId)) {
      throw new Error('R10 Phase A only supports Local Account')
    }
    return localAccountId
  }
}

function desktopLanInterfaceSelection(): {
  hasUsableLanAddress: boolean
  ipv4?: string
  ipv6?: string
  signature: string
} {
  const candidates: Array<{ name: string; address: string; family: string; scopeid?: number; penalty: number }> = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue
      const family = String(addr.family)
      const isV4 = family === 'IPv4' || family === '4'
      const isV6 = family === 'IPv6' || family === '6'
      if (!isV4 && !isV6) continue
      const virtual = /^(tun|tap|vpn|wg|utun|tailscale|zerotier|vethernet|docker|br-|vmnet|virbr)/i.test(name)
      candidates.push({
        name,
        address: addr.address,
        family: isV4 ? 'IPv4' : 'IPv6',
        scopeid: isV6 ? (addr as typeof addr & { scopeid?: number }).scopeid : undefined,
        penalty: virtual ? 10 : 0
      })
    }
  }
  candidates.sort((a, b) =>
    a.penalty - b.penalty ||
    (a.family === 'IPv4' ? 0 : 1) - (b.family === 'IPv4' ? 0 : 1) ||
    a.name.localeCompare(b.name) ||
    a.address.localeCompare(b.address)
  )
  const usableCandidates = candidates.filter((entry) => entry.penalty === 0)
  const ipv4 = usableCandidates.find((entry) => entry.family === 'IPv4')
  const ipv6 = usableCandidates.find((entry) => entry.family === 'IPv6')
  const scopedIpv6 = ipv6 && ipv6.address.toLowerCase().startsWith('fe80:') && !ipv6.address.includes('%') && ipv6.scopeid
    ? `${ipv6.address}%${ipv6.scopeid}`
    : ipv6?.address
  return {
    hasUsableLanAddress: usableCandidates.length > 0,
    ipv4: ipv4?.address,
    ipv6: scopedIpv6,
    signature: usableCandidates
      .map((entry) => `${entry.name}|${entry.family}|${entry.address}|${entry.scopeid ?? ''}`)
      .sort()
      .join(';')
  }
}

function inferManualLanBindAddress(remoteHost: string): string | undefined {
  const normalizedHost = remoteHost.replace(/%25/gi, '%')
  const remoteV4 = ipv4ToInt(normalizedHost)
  const interfaces = networkInterfaces()
  if (remoteV4 != null) {
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (/^(tun|tap|vpn|wg|utun|tailscale|zerotier|vethernet|docker|br-|vmnet|virbr)/i.test(name)) continue
      for (const addr of addrs ?? []) {
        const family = String(addr.family)
        if (addr.internal || (family !== 'IPv4' && family !== '4')) continue
        const local = ipv4ToInt(addr.address)
        const mask = ipv4ToInt(addr.netmask)
        if (local != null && mask != null && (local & mask) === (remoteV4 & mask)) {
          return addr.address
        }
      }
    }
    return undefined
  }

  const zoneIndex = normalizedHost.lastIndexOf('%')
  if (zoneIndex <= 0 || !normalizedHost.slice(0, zoneIndex).toLowerCase().startsWith('fe80:')) {
    return undefined
  }
  const zone = normalizedHost.slice(zoneIndex + 1)
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (/^(tun|tap|vpn|wg|utun|tailscale|zerotier|vethernet|docker|br-|vmnet|virbr)/i.test(name)) continue
    for (const addr of addrs ?? []) {
      const family = String(addr.family)
      if (addr.internal || (family !== 'IPv6' && family !== '6')) continue
      const scopeid = Number((addr as typeof addr & { scopeid?: number }).scopeid ?? 0)
      if (name !== zone && String(scopeid) !== zone) continue
      if (!addr.address.toLowerCase().startsWith('fe80:')) continue
      return addr.address.includes('%') || scopeid <= 0 ? addr.address : `${addr.address}%${scopeid}`
    }
  }
  return undefined
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    result = ((result << 8) | n) >>> 0
  }
  return result
}

function toEndpoint(value: SyncEndpointConfigRecord): SyncEndpointConfig {
  return {
    endpointId: value.endpointId, syncSpaceId: value.syncSpaceId, kind: value.kind, url: value.url,
    displayName: value.displayName, enabled: value.enabled,
    localBindAddress: value.localBindAddress ?? null,
    lastError: value.lastError
  }
}

function fingerprint(publicKeySpkiBase64: string): string {
  const digest = Buffer.from(publicKeySpkiBase64, 'base64').toString('hex').match(/.{1,2}/g)?.join(':') ?? ''
  return digest.slice(0, 47).toUpperCase()
}

function upgradeLegacyLanEndpointUrl(url: URL): void {
  const bootstrapPort = Number(url.port || '80')
  if (!Number.isSafeInteger(bootstrapPort) || bootstrapPort < 1 || bootstrapPort > 65_534) {
    throw new Error('Legacy LAN endpoint has no valid adjacent TLS port')
  }
  url.protocol = 'https:'
  url.port = String(bootstrapPort + 1)
}

/**
 * 格式化局域网同步服务基础 URL，规范处理 IPv6 方括号与端口 (B24)
 * @param host 主机名、IPv4 或 IPv6 地址
 * @param port 目标服务端口
 */
export function formatSyncUrl(host: string, port: number): string {
  const trimmed = host.trim()
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `https://[${trimmed}]:${port}`
  }
  return `https://${trimmed}:${port}`
}
