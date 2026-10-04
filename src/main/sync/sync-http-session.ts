import { parseSyncJson } from './sync-strict-json'
import { pollSnapshotJob } from './sync-snapshot-job-poll'
import type { SnapshotJobStatus } from './sync-snapshot-jobs'
import { pushHttpOperationBatches } from './sync-http-operation-batches'
import type {
  SyncBlobChunk,
  SyncBlobPersistedAck,
  SyncBlobStatus,
  SyncBlobUploadReservation,
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
  SyncSnapshotShardWire,
  SyncSnapshotStreamManifestWire,
  SyncStateVectorResponse,
  SyncCursor
} from '../../shared/sync-protocol'
import { syncRequestHeaders, type SyncHttpEndpointOptions } from './sync-http-request'
export type { SyncHttpEndpointOptions } from './sync-http-request'
import { SyncLanPeerTlsClient } from './sync-lan-tls'
import { SyncEndpointUrl } from './sync-endpoint-url'
import { responseWithDeadline } from './sync-response-deadline'
import { SYNC_COMPATIBILITY_VERSION } from '../../shared/sync-protocol'
import { requireSyncCompatibility } from './sync-compatibility'
import type { SyncPagedSnapshotManifest, SyncSnapshotBytePage, SyncSnapshotPageStatus } from '../../shared/sync-paged-snapshot'

/** HTTP(S) transport for R12/R13. The server remains business-opaque; all merge happens locally. */
export class SyncHttpEndpointSession implements SyncEndpointSession {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private lanTlsPeer: SyncLanPeerTlsClient | null = null
  private lanTlsPeerPromise: Promise<SyncLanPeerTlsClient> | null = null
  private closed = false
  /** 只有明确协商成功才采用 202 后台提交，旧 peer 保留原同步完成语义。 */
  private snapshotCommitJobsV1 = false
  private snapshotPauseRequested = false
  private readonly snapshotSubmissions = new Map<string, Promise<SnapshotJobStatus>>()
  private snapshotCancellation: Promise<void> | undefined
  private readonly requests = new Set<AbortController>()
  private readonly cancel = (): void => { void this.close() }

  constructor(private readonly options: SyncHttpEndpointOptions) {
    const parsed = new SyncEndpointUrl(options.baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Sync endpoint must use http or https')
    if (options.peerPublicKeySpkiBase64 && parsed.protocol !== 'https:') {
      throw new Error('Paired LAN sync endpoints must use authenticated HTTPS')
    }
    this.baseUrl = parsed.toString().replace(/\/$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
    options.signal?.addEventListener('abort', this.cancel, { once: true })
    if (options.signal?.aborted) this.cancel()
  }

  async negotiateProtocolAndCapabilities(): Promise<SyncSessionNegotiation> {
    const result = await this.request<SyncSessionNegotiation>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/session`, {
      method: 'POST', body: JSON.stringify({ deviceId: this.options.deviceId, protocolVersions: [1], syncCompatibilityVersion: SYNC_COMPATIBILITY_VERSION })
    })
    if (this.options.peerPublicKeySpkiBase64) requireSyncCompatibility(result.capabilities.syncCompatibilityVersion)
    this.snapshotCommitJobsV1 = result.capabilities.snapshotCommitJobsV1 === true
    return result
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
    return pushHttpOperationBatches({ operations: batch,
      send: body => this.request<SyncOperationBatchResult>(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/operations`, { method: 'POST', body }) })
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

  async getLatestSnapshotStreamManifest(
    requirement?: { class?: SyncSnapshotBundleWire['snapshotClass']; lanes?: string[] }
  ): Promise<SyncSnapshotStreamManifestWire | null> {
    const params = new URLSearchParams()
    if (requirement?.class) params.set('class', requirement.class)
    if (requirement?.lanes) params.set('lanes', requirement.lanes.join(','))
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return this.request<SyncSnapshotStreamManifestWire | null>(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/latest/stream${suffix}`
    )
  }

  async fetchSnapshotStreamShard(sourceSnapshotBundleId: string, lane: string): Promise<SyncSnapshotShardWire> {
    return this.request<SyncSnapshotShardWire>(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(sourceSnapshotBundleId)}/shards/${encodeURIComponent(lane)}`
    )
  }

  async pushSnapshotStreamManifest(manifest: SyncSnapshotStreamManifestWire): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(manifest.snapshotBundleId)}/stream/manifest`,
      { method: 'PUT', body: JSON.stringify(manifest) }
    )
  }

  async pushSnapshotStreamShard(snapshotBundleId: string, shard: SyncSnapshotShardWire): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshotBundleId)}/stream/shards/${encodeURIComponent(shard.replicationLaneId)}`,
      { method: 'PUT', body: JSON.stringify(shard) }
    )
  }

  async commitSnapshotStream(snapshotBundleId: string): Promise<void> {
    await this.request(
      `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshotBundleId)}/stream/commit`,
      { method: 'POST', body: '{}' }
    )
  }

  /** LAN 获取轻量分页清单，应用版本已在 session 握手中独立检查。 */
  async getLatestPagedSnapshot(requirement?: { class?: SyncSnapshotBundleWire['snapshotClass']; lanes?: string[] }): Promise<SyncPagedSnapshotManifest | null> {
    const params = new URLSearchParams()
    if (requirement?.class) params.set('class', requirement.class)
    if (requirement?.lanes) params.set('lanes', requirement.lanes.join(','))
    return this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/latest/pages?${params}`)
  }

  /** 每次只读取一个固定字节页，跨页记录由接收端持久索引恢复。 */
  async fetchSnapshotPage(input: { snapshotBundleId: string; lane: string; pageIndex: number }): Promise<SyncSnapshotBytePage> {
    return this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(input.snapshotBundleId)}/pages/${encodeURIComponent(input.lane)}/${input.pageIndex}`)
  }

  /** 先提交作者签名清单，让接收端绑定固定视图和页面索引。 */
  async pushPagedSnapshotManifest(manifest: SyncPagedSnapshotManifest): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(manifest.snapshotBundleId)}/pages/manifest`,
      { method: 'PUT', body: JSON.stringify(manifest) })
  }

  /** 页面只由快照专用区域持有，不借用普通 Blob 预约和配额。 */
  async pushSnapshotPage(input: { snapshotBundleId: string; page: SyncSnapshotBytePage }): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(input.snapshotBundleId)}/pages/${encodeURIComponent(input.page.replicationLaneId)}/${input.page.pageIndex}`,
      { method: 'PUT', body: JSON.stringify(input.page) })
  }

  /** 所有摘要与跨页关联验证成功后，接收端才进入正式 rebase 安装事务。 */
  async commitPagedSnapshot(snapshotBundleId: string): Promise<void> {
    if (this.snapshotPauseRequested) throw new Error('SNAPSHOT_JOB_PAUSED: user stopped Sync before submission')
    const path = `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshotBundleId)}/pages`
    if (!this.snapshotCommitJobsV1) {
      await this.request(`${path}/commit`, { method: 'POST', body: '{}' })
      return
    }
    const receipt = this.request<SnapshotJobStatus>(`${path}/commit?jobs=v1`, { method: 'POST', body: '{}' })
    this.snapshotSubmissions.set(snapshotBundleId, receipt)
    const initial = await receipt
    if (this.snapshotPauseRequested) await this.requestSnapshotPause()
    await pollSnapshotJob({ initial, signal: this.options.signal,
      status: () => this.request<SnapshotJobStatus>(`${path}/job-status`) })
    this.snapshotSubmissions.delete(snapshotBundleId)
  }

  /** 用户明确关闭同步时，先用原认证会话请求远端取消；普通断网只停止等待。 */
  async requestSnapshotPause(): Promise<void> {
    this.snapshotPauseRequested = true
    this.snapshotCancellation ??= this.cancelAcceptedSnapshots()
    await this.snapshotCancellation
  }

  /** 受理响应未返回时等待真实身份；不能先关闭传输再宣告远端已经取消。 */
  private async cancelAcceptedSnapshots(): Promise<void> {
    for (const [bundle, submission] of this.snapshotSubmissions) {
      const base = `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(bundle)}/pages`
      const result = await Promise.allSettled([submission])
      // POST 响应丢失时，取消必须查询真实受理身份；查询失败明确报告，不能假装未受理。
      const identity = result[0]!.status === 'fulfilled' ? result[0]!.value : await this.request<SnapshotJobStatus>(`${base}/job-status`)
      const path = `/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(bundle)}/pages/job-cancel`
      const status = await this.request<SnapshotJobStatus>(path, { method: 'POST', body: '{}' })
      if (status.generation !== identity.generation || status.rootHash !== identity.rootHash) throw new Error('SNAPSHOT_JOB_CONFLICT: cancelled executor identity changed')
    }
  }

  /** 续传只采用与当前 root 对应的已持久化页，客户端校验序号后跳过相同页。 */
  async getSnapshotPageStatus(snapshotBundleId: string): Promise<SyncSnapshotPageStatus> {
    return this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/snapshots/${encodeURIComponent(snapshotBundleId)}/pages/status`)
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

  /** 引用预约先于首次 status/PUT，接收端可在字节落盘前执行 lane 授权。 */
  async reserveBlobUpload(reservation: SyncBlobUploadReservation): Promise<void> {
    await this.request(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/blobs/${reservation.manifest.hash}/reserve`, {
      method: 'POST', body: JSON.stringify(reservation)
    })
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
    const response = await this.raw(`/v1/spaces/${encodeURIComponent(this.options.syncSpaceId)}/blobs/${encodeURIComponent(chunk.hash)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-sync-offset': String(chunk.offset),
        'x-sync-total-bytes': String(chunk.totalBytes),
        'x-sync-final': String(chunk.isFinal),
        'x-sync-restart': String(chunk.restart === true)
      },
      body: Buffer.from(chunk.bytes) as unknown as string
    })
    if (!chunk.isFinal) {
      if (response.status !== 204) {
        throw new Error(`Non-final Blob chunk must return HTTP 204, got ${response.status}`)
      }
      await response.body?.cancel()
      return null
    }
    if (response.status === 204) throw new Error('Final Blob chunk requires BlobPersistedAck')
    const ack = await response.json() as SyncBlobPersistedAck
    if (
      ack.syncSpaceId !== this.options.syncSpaceId ||
      ack.hash !== chunk.hash ||
      ack.totalBytes !== chunk.totalBytes ||
      !ack.replicaId?.trim() ||
      !Number.isSafeInteger(ack.persistedAt) ||
      ack.persistedAt <= 0
    ) {
      throw new Error('BlobPersistedAck does not match the uploaded Blob')
    }
    return ack
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

  async close(): Promise<void> {
    try { await this.snapshotCancellation }
    finally { this.closeTransport() }
  }

  /** 显式取消回执已经结束后才释放 TLS 及在途请求，普通断开仍立即关闭传输。 */
  private closeTransport(): void {
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.cancel)
    for (const controller of this.requests) controller.abort(new Error('Sync session closed'))
    this.requests.clear()
    this.lanTlsPeer?.close()
    this.lanTlsPeer = null
    this.lanTlsPeerPromise = null
  }

  private async request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init)
    if (response.status === 204) return undefined as T
    return parseSyncJson<T>(await response.text())
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.closed) throw new Error('Sync session is closed')
    this.options.authorizeRequest?.()
    const controller = new AbortController()
    this.requests.add(controller)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = syncRequestHeaders(this.options, { path, init })
      const requestInit = { ...init, headers, signal: controller.signal }
      const peer = this.options.peerPublicKeySpkiBase64 ? await this.getLanTlsPeer() : null
      this.options.authorizeRequest?.()
      const received = peer
        ? await peer.fetch(`${this.baseUrl}${path}`, requestInit)
        : await fetch(`${this.baseUrl}${path}`, requestInit)
      const response = responseWithDeadline({ response: received, controller, timer, onComplete: () => this.requests.delete(controller) })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Sync endpoint ${response.status}: ${body.slice(0, 500)}`)
      }
      // 响应头到达并不代表传输完成，正文消费结束后才清理 deadline。
      return response
    } catch (error) {
      clearTimeout(timer)
      this.requests.delete(controller)
      throw error
    }
  }

  private async getLanTlsPeer(): Promise<SyncLanPeerTlsClient> {
    if (this.lanTlsPeer) return this.lanTlsPeer
    if (!this.lanTlsPeerPromise) {
      this.lanTlsPeerPromise = SyncLanPeerTlsClient.connect(
        this.baseUrl,
        this.options.peerPublicKeySpkiBase64,
        undefined,
        this.timeoutMs,
        this.options.localBindAddress
      )
    }
    try {
      this.lanTlsPeer = await this.lanTlsPeerPromise
      if (this.closed) {
        this.lanTlsPeer.close()
        this.lanTlsPeer = null
        throw new Error('Sync session closed during TLS bootstrap')
      }
      return this.lanTlsPeer
    } catch (error) {
      this.lanTlsPeerPromise = null
      throw error
    }
  }
}
