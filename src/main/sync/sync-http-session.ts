import type {
  SyncBlobChunk,
  SyncBlobPersistedAck,
  SyncBlobStatus,
  SyncAuthLedgerPage,
  SyncAuthProtocolObject,
  SyncCoverage,
  SyncEndpointSession,
  SyncOperationBatchResult,
  SyncOperationEnvelope,
  SyncOperationsPage,
  SyncRange,
  SyncSessionNegotiation,
  SyncSnapshotBundleWire,
  SyncStateVectorResponse,
  SyncCursor
} from '../../shared/sync-protocol'
import { randomUUID } from 'node:crypto'
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  canonicalSigningMaterial,
  sha256Hex
} from './sync-http-auth'

export interface SyncHttpEndpointOptions {
  baseUrl: string
  syncSpaceId: string
  deviceId: string
  accessToken?: string
  timeoutMs?: number
  signer?: (material: string) => string
}

/** HTTP(S) transport for R12/R13. The server remains business-opaque; all merge happens locally. */
export class SyncHttpEndpointSession implements SyncEndpointSession {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(private readonly options: SyncHttpEndpointOptions) {
    const parsed = new URL(options.baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Sync endpoint must use http or https')
    this.baseUrl = parsed.toString().replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async negotiateProtocolAndCapabilities(): Promise<SyncSessionNegotiation> {
    return this.request<SyncSessionNegotiation>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/session`, { method: 'POST', body: JSON.stringify({ deviceId: this.options.deviceId, protocolVersions: [1] }) })
  }

  async getAuthLedger(): Promise<SyncAuthLedgerPage> {
    return this.request<SyncAuthLedgerPage>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/auth/ledger`)
  }

  async pushAuthObjects(objects: SyncAuthProtocolObject[]): Promise<SyncAuthLedgerPage> {
    return this.request<SyncAuthLedgerPage>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/auth/ledger`, {
      method: 'POST',
      body: JSON.stringify({ objects })
    })
  }

  async getRemoteStateVector(): Promise<SyncStateVectorResponse> {
    return this.request<SyncStateVectorResponse>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/state`)
  }

  async requestOperations(ranges: SyncRange[], cursor?: SyncCursor | null): Promise<SyncOperationsPage> {
    const params = new URLSearchParams({ ranges: JSON.stringify(ranges) })
    if (cursor) params.set('cursor', JSON.stringify(cursor))
    return this.request<SyncOperationsPage>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/operations?${params.toString()}`)
  }

  async pushOperations(batch: SyncOperationEnvelope[]): Promise<SyncOperationBatchResult> {
    return this.request<SyncOperationBatchResult>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/operations`, { method: 'POST', body: JSON.stringify({ operations: batch }) })
  }

  async getLatestSnapshot(requirement?: { class?: SyncSnapshotBundleWire['snapshotClass']; lanes?: string[] }): Promise<SyncSnapshotBundleWire | null> {
    const params = new URLSearchParams()
    if (requirement?.class) params.set('class', requirement.class)
    if (requirement?.lanes) params.set('lanes', requirement.lanes.join(','))
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return this.request<SyncSnapshotBundleWire | null>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/latest${suffix}`)
  }

  async pushSnapshot(snapshot: SyncSnapshotBundleWire): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshot.snapshotBundleId)}`, { method: 'PUT', body: JSON.stringify(snapshot) })
  }

  async acceptRecoverySnapshot(snapshotBundleId: string, acceptance: SyncAuthProtocolObject): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshotBundleId)}/accept`,
      { method: 'POST', body: JSON.stringify({ acceptance }) }
    )
  }

  async getBlobStatus(hash: string): Promise<SyncBlobStatus | null> {
    return this.request<SyncBlobStatus | null>(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/blobs/${encodeURIComponent(hash)}/status`
    )
  }

  async fetchBlob(hash: string, range?: { offset: number; length?: number }): Promise<SyncBlobChunk> {
    const headers: Record<string, string> = {}
    if (range) headers.Range = `bytes=${range.offset}-${range.length == null ? '' : range.offset + range.length - 1}`
    const response = await this.raw(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/blobs/${encodeURIComponent(hash)}`, { headers })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const offset = Number(response.headers.get('x-sync-offset') ?? range?.offset ?? 0)
    const totalBytes = Number(response.headers.get('x-sync-total-bytes') ?? bytes.length + offset)
    return { hash, offset, totalBytes, bytes, isFinal: offset + bytes.length >= totalBytes }
  }

  async pushBlob(chunk: SyncBlobChunk): Promise<SyncBlobPersistedAck | null> {
    return (await this.request<SyncBlobPersistedAck | null>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/blobs/${encodeURIComponent(chunk.hash)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-sync-offset': String(chunk.offset),
        'x-sync-total-bytes': String(chunk.totalBytes),
        'x-sync-final': String(chunk.isFinal),
        'x-sync-restart': String(chunk.restart === true)
      },
      body: Buffer.from(chunk.bytes) as unknown as string
    })) ?? null
  }

  async acknowledgeReceived(received: SyncCoverage, rejectedDigests?: string[]): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/coverage/received`, { method: 'POST', body: JSON.stringify({ received, rejectedDigests: rejectedDigests ?? [] }) })
  }

  async reportAppliedCoverage(applied: SyncCoverage): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/coverage/applied`, { method: 'POST', body: JSON.stringify({ applied }) })
  }

  async reportRetainedCoverage(retained: SyncCoverage): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/coverage/retained`, { method: 'POST', body: JSON.stringify({ retained }) })
  }

  async close(): Promise<void> { return undefined }

  private async request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    headers.set('x-sync-device-id', this.options.deviceId)
    if (this.options.accessToken) headers.set('authorization', `Bearer ${this.options.accessToken}`)

    if (this.options.signer) {
      const timestamp = String(Date.now())
      const nonce = randomUUID()
      let bodyData: Buffer | string = ''
      if (typeof init.body === 'string') {
        bodyData = init.body
      } else if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        bodyData = Buffer.from(init.body)
      }
      const bodySha256 = sha256Hex(bodyData)
      const method = (init.method ?? 'GET').toUpperCase()
      const material = canonicalSigningMaterial(method, path, timestamp, nonce, bodySha256)
      const signature = this.options.signer(material)

      headers.set(HEADER_TIMESTAMP, timestamp)
      headers.set(HEADER_NONCE, nonce)
      headers.set(HEADER_SIGNATURE, signature)
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Sync endpoint ${response.status}: ${body.slice(0, 500)}`)
      }
      return response
    } finally {
      clearTimeout(timer)
    }
  }
}
