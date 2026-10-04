import { parseSyncJson } from './sync-strict-json'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { handlePagedSnapshotRoute } from './sync-paged-snapshot-routes'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify, X509Certificate } from 'node:crypto'
import { existsSync, statSync, appendFileSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { sendBlobFile } from './sync-blob-fetch-response'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import selfsigned from 'selfsigned'
import type {
  SyncAuthProtocolObject,
  SyncCoverage,
  SyncOperationEnvelope,
  SyncRange,
  SyncSnapshotBundleWire,
  SyncSnapshotShardWire,
  SyncSnapshotStreamManifestWire
} from '../../shared/sync-protocol'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncBlobUploadReservation } from '../../shared/sync-protocol'
import { requireBlobReservation, saveBlobReservation } from './sync-blob-upload-reservation'
import { toSyncOperationEnvelope, SYNC_COMPATIBILITY_VERSION } from '../../shared/sync-protocol'
import { SYNC_COMPATIBILITY_HEADER, requireSyncCompatibility, requireSyncCompatibilityHeader } from './sync-compatibility'
import { canonicalSigningMaterial } from './sync-http-auth'
import { SyncLocalLanePolicy } from './sync-local-lane-policy'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository } from './sync-state-repository'
import type { SyncApplyCoordinator } from './sync-apply-coordinator'
import type { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import type { DesktopAuthLedgerService } from './sync-auth-ledger'
import type { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { DesktopPairingCoordinator } from './sync-pairing-coordinator'
import { computeActiveGrant } from './sync-runtime-repository'
import type { DesktopGenesisSnapshotService } from './genesis-snapshot-service'
import type { DesktopSnapshotInstallService } from './desktop-snapshot-install-service'
import {
  SNAPSHOT_HASH_SCHEMA_VERSION,
  snapshotShardContentHash
} from './sync-snapshot-wire'

function hashBufferHex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function mergeMonotonicCoverage(previous: SyncCoverage, incoming: SyncCoverage): SyncCoverage {
  const merged: SyncCoverage = {}
  for (const source of [previous, incoming]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error('INVALID_COVERAGE')
    }
    for (const [lane, actors] of Object.entries(source)) {
      if (!lane.trim() || !actors || typeof actors !== 'object' || Array.isArray(actors)) {
        throw new Error('INVALID_COVERAGE')
      }
      for (const [actor, prefix] of Object.entries(actors)) {
        if (!actor.trim() || !Number.isSafeInteger(prefix) || prefix < 0) {
          throw new Error('INVALID_COVERAGE')
        }
        merged[lane] ??= {}
        merged[lane]![actor] = Math.max(merged[lane]![actor] ?? 0, prefix)
      }
    }
  }
  return merged
}

const MAX_CLOCK_SKEW_MS = 120_000
const MAX_DEFAULT_BODY_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_BODY_BYTES = 64 * 1024 * 1024
const MAX_BLOB_CHUNK_BODY_BYTES = 2 * 1024 * 1024
const MAX_PAIRING_BODY_BYTES = 256 * 1024
const MAX_UNREFERENCED_BLOB_BYTES = 256 * 1024 * 1024
const MAX_STAGED_BLOB_BYTES_PER_PEER = 512 * 1024 * 1024
const MAX_STAGED_BLOB_BYTES_TOTAL = 1024 * 1024 * 1024
const SNAPSHOT_STREAM_STAGE_TTL_MS = 24 * 60 * 60 * 1000
const STAGED_BLOB_TTL_MS = 24 * 60 * 60 * 1000
const HEADER_DEVICE_ID = 'x-sync-device-id'
const HEADER_TIMESTAMP = 'x-sync-timestamp'
const HEADER_NONCE = 'x-sync-nonce'
const HEADER_SIGNATURE = 'x-sync-signature'

export interface DesktopSyncLanListenerOptions {
  host: string
  port: number
  /** 接收端事务提交后通知宿主，保持被动同步的界面可见。 */
  onBusinessDataChanged?: (syncSpaceId: string) => void
}

class NonceReplayCache {
  private readonly entries = new Map<string, number>()

  checkAndRecord(nonceKey: string, now: number, ttlMs = 300_000): boolean {
    for (const [k, exp] of this.entries) {
      if (exp <= now) this.entries.delete(k)
    }
    if (this.entries.has(nonceKey)) return false
    this.entries.set(nonceKey, now + ttlMs)
    return true
  }
}

/**
 * 桌面端 HTTP Socket 监听服务。
 *
 * 遵循 R11 规范与整改要求：
 * 1. 完整返回 SyncPeerCapabilities 能力集（B14）；
 * 2. 读取本地 Lane 策略并严格执行 operations/blob 过滤与拦截（B15）；
 * 3. 校验操作所属 Sync Space 空间隔离（B16）；
 * 4. Blob 空间与 Lane 隔离校验（B17）；
 * 5. 实现分块暂存、断点续传与整体验签落盘持久化（B19）；
 * 6. 统一 sendJson 在 status=200 且 body=null 时输出 "null"，杜绝 EOFException（B20）；
 * 7. 补齐快照查询路由 /v1/spaces/:spaceId/snapshots/latest（B21）；
 * 8. Blob Range 请求采用流式按需读取，优化内存（B25）；
 * 9. 支持 Coverage 接收上报持久化（U10）。
 */
export class DesktopSyncLanListener {
  private bootstrapServer: ReturnType<typeof createHttpServer> | null = null
  private tlsServer: ReturnType<typeof createHttpsServer> | null = null
  private readonly nonceCache = new NonceReplayCache()
  // 活跃 Blob 响应单独登记；监听关闭时即使客户端反压也能主动终止 pipeline。
  private readonly blobResponses = new Set<ServerResponse>()
  private tlsCertificateDerBase64: string | null = null
  private tlsPrivateKeyPem: string | null = null
  private tlsCertificatePem: string | null = null
  private activeBootstrapPort: number | null = null
  private activeTlsPort: number | null = null

  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly keys: DesktopSyncDeviceSigningKeyStore,
    private readonly authLedger: DesktopAuthLedgerService,
    private readonly apply: SyncApplyCoordinator,
    private readonly pairing: DesktopPairingCoordinator,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
    private readonly options: DesktopSyncLanListenerOptions = { port: 0, host: '0.0.0.0' },
    private readonly genesis?: DesktopGenesisSnapshotService,
    private readonly snapshotInstaller?: DesktopSnapshotInstallService,
    private readonly localAccountId: () => number = () => 1
  ) {}

  get bootstrapPort(): number {
    return this.activeBootstrapPort ?? 0
  }

  get tlsPort(): number {
    return this.activeTlsPort ?? 0
  }

  private createRequestHandler() {
    return (req: IncomingMessage, res: ServerResponse): void => {
      this.handle(req, res).catch((err) => {
        console.error('Unhandled LAN listener error:', err)
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: String(err) })
        }
      })
    }
  }

  /**
   * 暴露当前监听端支持的能力声明（修复 B14：声明全部基础核心 Lane 与扩展能力）
   */
  get capabilities() {
    return {
      syncCompatibilityVersion: SYNC_COMPATIBILITY_VERSION,
      protocolVersion: 1,
      protocolVersions: [1],
      replicationLanes: ['CORE_META', 'AUTH', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY'],
      supportedReplicationLanes: ['CORE_META', 'AUTH', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY'],
      snapshotClasses: ['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'],
      blobTransfer: true,
      maxOperationBatch: 500,
      maxBlobChunkBytes: 1048576,
      supportsRangeResume: true,
      streamingSnapshots: true,
      pagedSnapshots: true,
      snapshotCommitJobsV1: this.snapshotInstaller?.snapshotJobs != null,
      blobRangeRequests: true,
      authStabilityCheckpoints: true,
      blobUploadReservations: true
    }
  }

  async listen(): Promise<{ host: string; port: number }> {
    return this.start()
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.bootstrapServer?.listening && this.activeBootstrapPort != null) {
      return { host: this.options.host, port: this.activeBootstrapPort }
    }
    await this.prepareTlsIdentity()
    this.warmUpTrustedPeers()
    return this.listenPortPair()
  }

  async close(): Promise<void> {
    for (const response of this.blobResponses) {
      response.destroy(new Error('LAN_DISABLED: Listener closed during Blob transfer'))
    }
    await Promise.all([
      this.closeServer(this.bootstrapServer),
      this.closeServer(this.tlsServer)
    ])
    this.bootstrapServer = null
    this.tlsServer = null
    this.activeBootstrapPort = null
    this.activeTlsPort = null
  }

  private async prepareTlsIdentity(): Promise<void> {
    const localDevice = this.runtime.findDeviceIdentity()
    if (!localDevice) throw new Error('Sync Device Identity is not initialized; LAN TLS cannot start')
    const keyPair = this.keys.lanTlsKeyPairPem(localDevice.deviceId)
    const validFrom = new Date(Date.now() - 60_000)
    const validTo = new Date(Date.now())
    validTo.setFullYear(validTo.getFullYear() + 5)
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'OrigRead LAN Sync Device' }],
      {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: validFrom,
        notAfterDate: validTo,
        keyPair: { privateKey: keyPair.privateKeyPem, publicKey: keyPair.publicKeyPem },
        extensions: [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: [{ type: 6, value: `urn:origread:device:${localDevice.deviceId}` }] }
        ]
      }
    )
    const certificate = new X509Certificate(generated.cert)
    if (certificate.subject !== certificate.issuer || !certificate.verify(certificate.publicKey)) {
      throw new Error('Failed to create a self-signed LAN TLS certificate')
    }
    const certKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
    const deviceKey = Buffer.from(this.keys.publicKeySpkiBase64(localDevice.deviceId), 'base64')
    if (!certKey.equals(deviceKey)) throw new Error('LAN TLS certificate key does not match the persistent device identity')
    this.tlsCertificateDerBase64 = certificate.raw.toString('base64')
    this.tlsPrivateKeyPem = keyPair.privateKeyPem
    this.tlsCertificatePem = generated.cert
  }

  private async listenPortPair(): Promise<{ host: string; port: number }> {
    if (!Number.isSafeInteger(this.options.port) || this.options.port < 0 || this.options.port > 65_534) {
      throw new Error('LAN bootstrap port must be between 0 and 65534')
    }
    let lastError: unknown
    const attempts = this.options.port === 0 ? 32 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const bootstrap = createHttpServer(this.createRequestHandler())
      let bootstrapPort = 0
      try {
        bootstrapPort = await this.listenServer(bootstrap, this.options.port, this.options.host)
      } catch (error) {
        lastError = error
        await this.closeServer(bootstrap)
        if (this.options.port !== 0) break
        continue
      }
      if (bootstrapPort > 65_534) {
        lastError = new Error('Allocated LAN bootstrap port cannot be paired with an adjacent TLS port')
        await this.closeServer(bootstrap)
        continue
      }
      const key = this.tlsPrivateKeyPem
      const cert = this.tlsCertificatePem
      if (!key || !cert) {
        await this.closeServer(bootstrap)
        throw new Error('LAN TLS identity is not ready')
      }
      const secure = createHttpsServer({ key, cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, this.createRequestHandler())
      try {
        const securePort = await this.listenServer(secure, bootstrapPort + 1, this.options.host)
        this.bootstrapServer = bootstrap
        this.tlsServer = secure
        this.activeBootstrapPort = bootstrapPort
        this.activeTlsPort = securePort
        return { host: this.options.host, port: bootstrapPort }
      } catch (error) {
        lastError = error
        await Promise.all([this.closeServer(bootstrap), this.closeServer(secure)])
        if (this.options.port !== 0) break
      }
    }
    throw new Error(`Could not bind adjacent LAN bootstrap/TLS ports: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private listenServer(server: ReturnType<typeof createHttpServer>, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('LAN listener failed to bind'))
        resolve(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  private closeServer(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer> | null): Promise<void> {
    if (!server || !server.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private warmUpTrustedPeers(): void {
    try {
      const row = (this.runtime as any).database.prepare(
        "SELECT sync_space_id FROM sync_local_space_binding WHERE lifecycle_state='ACTIVE' LIMIT 1"
      ).get() as { sync_space_id: string } | undefined
      if (!row) return
      const trusted = this.state.listTrustedDevices(row.sync_space_id)
      for (const dev of trusted) {
        if (dev.trustState === 'TRUSTED') {
          this.state.registerPeer({
            syncSpaceId: dev.syncSpaceId,
            deviceId: dev.deviceId,
            publicKeySpkiBase64: dev.staticPublicKey,
            status: 'ACTIVE',
            authEpoch: dev.authEpoch,
            updatedAt: dev.lastSeenAt
          })
        }
      }
    } catch {
      // best-effort warm up
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rawTarget = request.url ?? '/'
      const url = new URL(rawTarget, `http://${request.headers.host ?? 'localhost'}`)
      const clientIp = request.socket.remoteAddress?.replace(/^::ffff:/, '') || '127.0.0.1'
      const clientPort = request.socket.remotePort || 0

      const isTls = (request.socket as TLSSocket).encrypted === true
      if (!isTls && !(request.method === 'POST' && url.pathname === '/v1/auth/challenge' && !url.search)) {
        return this.sendJson(response, 426, {
          error: 'UPGRADE_REQUIRED',
          message: 'LAN pairing and synchronization require the authenticated HTTPS endpoint'
        })
      }

      // 1. 健康检查与认证探测免常规拦截（B32, C02）
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return this.sendJson(response, 200, {
          ok: true,
          protocol: 'origread-sync-v1'
        })
      }

      // 1.1 长期公钥数字签名挑战应答路由（修复 C02：杜绝仅凭自报 deviceId 伪造并劫持受信任地址）
      if (url.pathname === '/v1/auth/challenge') {
        if (request.method !== 'POST' || url.search) {
          return this.sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use POST with a JSON challenge body' })
        }
        const challengeRequest = parseJson(await readBody(request))
        const challengeNonce = challengeRequest.nonce
        if (typeof challengeNonce !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(challengeNonce)) {
          return this.sendJson(response, 400, { error: 'BAD_REQUEST', message: 'Invalid challenge nonce' })
        }
        const localDevice = this.runtime.findDeviceIdentity()
        if (!localDevice) {
          return this.sendJson(response, 500, { error: 'INTERNAL_ERROR', message: 'Device identity not found' })
        }
        if (!this.tlsCertificateDerBase64) {
          return this.sendJson(response, 503, { error: 'TLS_IDENTITY_UNAVAILABLE', message: 'LAN TLS identity is not ready' })
        }
        const timestamp = Date.now()
        const material = `CHALLENGE_RESPONSE:${localDevice.deviceId}:${challengeNonce}:${timestamp}`
        const signature = this.keys.signBase64(localDevice.deviceId, material)
        const publicKeySpkiBase64 = this.keys.publicKeySpkiBase64(localDevice.deviceId)
        return this.sendJson(response, 200, {
          deviceId: localDevice.deviceId,
          timestamp,
          nonce: challengeNonce,
          signature,
          publicKeySpkiBase64,
          tlsCertificateDerBase64: this.tlsCertificateDerBase64
        })
      }

      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

      // 2. 配对握手路由免常规签名拦截（内部由 pairing coordinator 进行握手验签与 SAS 校验）
      if (segments[0] === 'v1' && segments[1] === 'pairing') {
        return await this.handlePairing(request, response, segments, clientIp, clientPort)
      }

      // 3. 常规业务路由校验：/v1/spaces/:spaceId/*
      if (segments[0] !== 'v1' || segments[1] !== 'spaces' || !segments[2]) {
        return this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Unknown endpoint' })
      }
      const syncSpaceId = segments[2]
      // 在读取正文和执行业务路由前拒绝不兼容客户端，不能绕过握手直接读写。
      requireSyncCompatibilityHeader(request.headers[SYNC_COMPATIBILITY_HEADER])
      const bodyBuffer = await readBody(
        request,
        requestBodyLimit(request.method ?? 'GET', url.pathname)
      )

      // 校验请求发送方身份、时钟偏差、Nonce 防重放与数字签名
      this.requirePeerAuthorization(request, syncSpaceId, rawTarget, bodyBuffer)

      const remoteDeviceId = String(request.headers[HEADER_DEVICE_ID])
      const localDevice = this.runtime.findDeviceIdentity()
      const localDeviceId = localDevice?.deviceId ?? 'desktop-device'

      // Session 协商（修复 B14：返回完整 SyncPeerCapabilities，包含所有必需 core lanes）
      if (segments[3] === 'session' && request.method === 'POST') {
        requireSyncCompatibility(parseJson(bodyBuffer).syncCompatibilityVersion)
        return this.sendJson(response, 200, {
          syncSpaceId,
          localDeviceId: remoteDeviceId,
          remoteDeviceId: localDeviceId,
          capabilities: this.capabilities
        })
      }

      // State 状态向量（修复 B15, C16：读取本地真实 Lane 策略，过滤 PAUSED 与 LOCAL_PURGE）
      if (segments[3] === 'state' && request.method === 'GET') {
        const coverage = this.state.getCoverage(syncSpaceId)
        const localPolicy = new SyncLocalLanePolicy((this.runtime as any).databaseHandle?.() ?? (this.runtime as any).database).read(syncSpaceId)
        const policyByLane: Record<string, string> = {
          CORE_META: 'ENABLED',
          AUTH: 'ENABLED',
          LIBRARY: 'ENABLED',
          ARTICLE_STATE: 'ENABLED',
          CONFIG: 'ENABLED',
          AI_HISTORY: 'ENABLED',
          ...localPolicy
        }
        return this.sendJson(response, 200, {
          coverage,
          policyByLane
        })
      }

      // Operations 拉取与推送（修复 B15, B16, C08, C16, B37）
      if (segments[3] === 'operations') {
        const localPolicy = new SyncLocalLanePolicy((this.runtime as any).databaseHandle?.() ?? (this.runtime as any).database).read(syncSpaceId)
        if (request.method === 'GET') {
          const ranges = parseRanges(url.searchParams.get('ranges'))
          const operations: Record<string, SyncOperationEnvelope> = {}
          for (const range of ranges) {
            // 策略过滤（B15, C16）：被 PAUSED, LOCAL_PURGE 或 UNSUPPORTED 的 lane 跳过
            const p = localPolicy[range.replicationLaneId]
            if (p === 'PAUSED' || p === 'LOCAL_PURGE' || p === 'UNSUPPORTED') {
              continue
            }
            const rows = this.runtime.listRelayRange(
              syncSpaceId,
              range.actorIncarnationId,
              range.replicationLaneId,
              range.fromSequence,
              range.toSequence,
              500 - Object.keys(operations).length
            )
            for (const row of rows) {
              operations[row.operationId] = toSyncOperationEnvelope(row)
            }
            if (Object.keys(operations).length >= 500) break
          }
          return this.sendJson(response, 200, {
            operations: Object.values(operations),
            coverage: this.state.getCoverage(syncSpaceId)
          })
        }
        if (request.method === 'POST') {
          const body = parseJson(bodyBuffer) as { operations?: SyncOperationEnvelope[] }
          const envelopes = Array.isArray(body.operations) ? body.operations : []

          // 批次上限强制限制（B37）：超过 500 条直接拒绝
          if (envelopes.length > 500) {
            return this.sendJson(response, 413, {
              error: 'PAYLOAD_TOO_LARGE',
              message: `Operation batch exceeds maximum allowed limit of 500 (received: ${envelopes.length})`
            })
          }

          const validEnvelopes: SyncOperationEnvelope[] = []
          const earlyRejected: Array<{ operationId: string | null; code: string; message: string }> = []

          for (const env of envelopes) {
            // 空间校验（B16）：操作的 syncSpaceId 必须与当前路径完全一致
            if (env.syncSpaceId !== syncSpaceId) {
              earlyRejected.push({
                operationId: env.operationId ?? null,
                code: 'SPACE_MISMATCH',
                message: 'Operation Sync Space does not match endpoint'
              })
              continue
            }
            // 策略校验（B15, C16）：被本地 PAUSED 或 LOCAL_PURGE 的 lane 拒绝写入
            const p = localPolicy[env.replicationLaneId]
            if (p === 'PAUSED' || p === 'LOCAL_PURGE' || p === 'UNSUPPORTED') {
              earlyRejected.push({
                operationId: env.operationId ?? null,
                code: 'PAUSED_LANE',
                message: `Replication lane ${env.replicationLaneId} is not enabled`
              })
              continue
            }
            validEnvelopes.push(env)
          }

          const report = this.apply.ingest(validEnvelopes, {
            resolvePeerKey: (space, peerDev) => {
              const peer = this.state.findPeer(space, peerDev)
              return peer ? { publicKeySpkiBase64: peer.publicKeySpkiBase64, status: peer.status, authEpoch: peer.authEpoch } : null
            }
          })

          // LAN push is also an inbound materialization boundary. Durable ingest alone would leave
          // accepted operations PENDING until this device happened to initiate a later sync run.
          // Drain everything that is currently applicable now; dependency/auth-gated operations
          // remain PENDING and will be retried by the normal session path.
          for (let pass = 0; pass < 20; pass++) {
            const applied = this.apply.applyPending(syncSpaceId, 500, Date.now(), localPolicy)
            if (applied.appliedOperationIds.length > 0) this.options.onBusinessDataChanged?.(syncSpaceId)
            if (applied.failedOperationIds.length > 0) {
              throw new Error(`Sync business application failed: ${applied.failedOperationIds.join(',')}`)
            }
            if (applied.appliedOperationIds.length === 0) break
          }

          return this.sendJson(response, 200, {
            acceptedOperationIds: report.acceptedOperationIds,
            duplicateOperationIds: report.duplicateOperationIds,
            rejected: [...earlyRejected, ...report.rejected],
            coverage: this.state.getCoverage(syncSpaceId)
          })
        }
      }

      // 分页路由复用上方已完成的 TLS、请求签名、Space 和 lane 授权。
      if (segments[3] === 'snapshots' && segments[5] === 'pages') {
        if (!this.genesis || !this.snapshotInstaller) throw new Error('SNAPSHOT_UNAVAILABLE: paged Snapshot services are not configured')
        const paged = handlePagedSnapshotRoute({ runtime: this.runtime, state: this.state, genesis: this.genesis,
          installer: this.snapshotInstaller, localAccountId: this.localAccountId,
          policy: space => new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(space) },
          { method: request.method ?? '', segments, url, body: bodyBuffer, syncSpaceId, remoteDeviceId })
        if (paged) {
          if (paged.status === 200 && segments[6] === 'commit') this.options.onBusinessDataChanged?.(syncSpaceId)
          return this.sendJson(response, paged.status, paged.body)
        }
      }

      // LAN 兼容号 2 仅支持分页快照；OWNER acceptance 是独立授权接口。
      if (segments[3] === 'snapshots' && segments[5] !== 'accept') {
        return this.sendJson(response, 409, { error: 'SNAPSHOT_INCOMPATIBLE', message: 'LAN requires paged Snapshot routes' })
      }

      // AUTH Ledger 读写
      if (segments[3] === 'auth' && segments[4] === 'ledger') {
        if (request.method === 'GET') {
          const objects = this.runtime.listAuthObjects(syncSpaceId)
          const currentEpoch = objects.at(-1)?.authEpoch ?? 0
          const currentOwner = objects.at(-1)?.ownerDeviceId ?? null
          return this.sendJson(response, 200, {
            objects,
            authEpoch: currentEpoch,
            ownerDeviceId: currentOwner
          })
        }
        if (request.method === 'POST') {
          const body = parseJson(bodyBuffer) as { objects?: SyncAuthProtocolObject[]; object?: SyncAuthProtocolObject }
          const objects = Array.isArray(body.objects) ? body.objects : body.object ? [body.object] : []
          this.authLedger.append(syncSpaceId, objects)
          const updated = this.runtime.listAuthObjects(syncSpaceId)
          return this.sendJson(response, 200, {
            objects: updated,
            authEpoch: updated.at(-1)?.authEpoch ?? 0,
            ownerDeviceId: updated.at(-1)?.ownerDeviceId ?? null
          })
        }
      }

      // 快照查询与上传恢复路由（修复 B15, B21, C09, C10, C16）
      if (segments[3] === 'snapshots') {
        const localPolicy = new SyncLocalLanePolicy((this.runtime as any).databaseHandle?.() ?? (this.runtime as any).database).read(syncSpaceId)

        // GET /v1/spaces/:spaceId/snapshots/latest/stream
        if (segments[4] === 'latest' && segments[5] === 'stream' && request.method === 'GET') {
          const requestedClass = url.searchParams.get('class')
          if (
            requestedClass != null &&
            !['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'].includes(requestedClass)
          ) {
            return this.sendJson(response, 400, {
              error: 'REQUEST_ERROR',
              message: 'Unknown Snapshot class'
            })
          }
          const bundle = this.runtime.findLatestExportableSnapshotBundle(
            syncSpaceId,
            requestedClass as 'WORKING' | 'GC_BASELINE' | 'BOOTSTRAP_RECOVERY' | undefined
          )
          if (!bundle) return this.sendJson(response, 200, null)
          if (!this.genesis) {
            return this.sendJson(response, 503, {
              error: 'SNAPSHOT_UNAVAILABLE',
              message: 'Canonical Snapshot exporter is not configured'
            })
          }
          const descriptors = this.runtime.listSnapshotShardDescriptors(bundle.snapshotBundleId)
          const requestedLanes = url.searchParams.get('lanes')?.split(',').map((s) => s.trim()).filter(Boolean)
          const effectiveLanes = descriptors.filter((descriptor) => {
            const p = localPolicy[descriptor.replicationLaneId]
            if (p === 'PAUSED' || p === 'LOCAL_PURGE' || p === 'UNSUPPORTED') return false
            if (requestedLanes?.length && !requestedLanes.includes(descriptor.replicationLaneId)) return false
            return true
          }).map((descriptor) => descriptor.replicationLaneId)
          if (!effectiveLanes.includes('CORE_META') || !effectiveLanes.includes('AUTH')) {
            return this.sendJson(response, 200, null)
          }
          const effectiveLaneSet = new Set<string>(effectiveLanes)
          if (requestedLanes?.some((lane) => !effectiveLaneSet.has(lane))) {
            return this.sendJson(response, 200, null)
          }
          return this.sendJson(
            response,
            200,
            this.genesis.exportStreamManifest(
              bundle.snapshotBundleId,
              new Set(effectiveLanes) as ReadonlySet<SyncReplicationLane>
            )
          )
        }

        // GET /v1/spaces/:spaceId/snapshots/:sourceBundleId/shards/:lane
        if (segments[5] === 'shards' && segments[6] && request.method === 'GET') {
          if (!this.genesis) {
            return this.sendJson(response, 503, {
              error: 'SNAPSHOT_UNAVAILABLE',
              message: 'Canonical Snapshot exporter is not configured'
            })
          }
          const sourceBundleId = segments[4]!
          const lane = segments[6]!
          const bundle = this.runtime.findSnapshotBundle(sourceBundleId)
          if (!bundle || bundle.syncSpaceId !== syncSpaceId || !this.runtime.findGenesisSession(bundle.genesisSessionId)) {
            return this.sendJson(response, 404, {
              error: 'NOT_FOUND',
              message: 'Snapshot source bundle is not exportable from this Sync Space'
            })
          }
          const lanePolicy = localPolicy[lane]
          if (lanePolicy === 'PAUSED' || lanePolicy === 'LOCAL_PURGE' || lanePolicy === 'UNSUPPORTED') {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Requested Snapshot lane is disabled by local policy'
            })
          }
          try {
            return this.sendJson(response, 200, this.genesis.exportStreamShard(sourceBundleId, lane))
          } catch (error) {
            return this.sendJson(response, 404, {
              error: 'NOT_FOUND',
              message: error instanceof Error ? error.message : String(error)
            })
          }
        }

        // GET /v1/spaces/:spaceId/snapshots/latest (修复 C09: 严格快照类别、合法基线与规范 JCS 签名)
        if (segments[4] === 'latest' && request.method === 'GET') {
          const requestedClass = url.searchParams.get('class')
          if (
            requestedClass != null &&
            !['WORKING', 'GC_BASELINE', 'BOOTSTRAP_RECOVERY'].includes(requestedClass)
          ) {
            return this.sendJson(response, 400, {
              error: 'REQUEST_ERROR',
              message: 'Unknown Snapshot class'
            })
          }
          const bundle = this.runtime.findLatestExportableSnapshotBundle(
            syncSpaceId,
            requestedClass as 'WORKING' | 'GC_BASELINE' | 'BOOTSTRAP_RECOVERY' | undefined
          )
          if (!bundle) {
            return this.sendJson(response, 200, null)
          }

          if (!this.genesis) {
            return this.sendJson(response, 503, { error: 'SNAPSHOT_UNAVAILABLE', message: 'Canonical Snapshot exporter is not configured' })
          }
          const shards = this.runtime.listSnapshotShards(bundle.snapshotBundleId)
          const requestedLanes = url.searchParams.get('lanes')?.split(',').map((s) => s.trim()).filter(Boolean)
          const effectiveLanes = shards.filter((shard) => {
            const p = localPolicy[shard.replicationLaneId]
            if (p === 'PAUSED' || p === 'LOCAL_PURGE' || p === 'UNSUPPORTED') {
              return false
            }
            if (requestedLanes && requestedLanes.length > 0 && !requestedLanes.includes(shard.replicationLaneId)) {
              return false
            }
            return true
          }).map((shard) => shard.replicationLaneId)
          if (!effectiveLanes.includes('CORE_META') || !effectiveLanes.includes('AUTH')) {
            return this.sendJson(response, 200, null)
          }
          const effectiveLaneSet = new Set<string>(effectiveLanes)
          if (requestedLanes?.some((lane) => !effectiveLaneSet.has(lane))) {
            return this.sendJson(response, 200, null)
          }
          const bundleWire = this.genesis.exportWire(
            bundle.snapshotBundleId,
            new Set(effectiveLanes) as ReadonlySet<SyncReplicationLane>
          )
          return this.sendJson(response, 200, bundleWire)
        }

        // PUT /v1/spaces/:spaceId/snapshots/:bundleId/stream/manifest
        if (segments[5] === 'stream' && segments[6] === 'manifest' && request.method === 'PUT') {
          const manifest = parseJson(bodyBuffer) as unknown as SyncSnapshotStreamManifestWire
          const snapshotBundleId = segments[4]!
          if (
            !manifest ||
            manifest.syncSpaceId !== syncSpaceId ||
            manifest.snapshotBundleId !== snapshotBundleId ||
            !manifest.sourceSnapshotBundleId?.trim() ||
            manifest.hashSchemaVersion !== SNAPSHOT_HASH_SCHEMA_VERSION
          ) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Invalid Snapshot stream manifest'
            })
          }
          const lanes = manifest.shardDescriptors?.map((descriptor) => descriptor.replicationLaneId) ?? []
          if (
            lanes.length === 0 ||
            new Set(lanes).size !== lanes.length ||
            !lanes.includes('CORE_META') ||
            !lanes.includes('AUTH')
          ) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream manifest has invalid shard descriptors'
            })
          }
          const localPolicy = new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId)
          if (lanes.some((lane) => ['PAUSED', 'LOCAL_PURGE', 'UNSUPPORTED'].includes(localPolicy[lane] ?? 'ENABLED'))) {
            return this.sendJson(response, 403, {
              error: 'LANE_POLICY_BLOCKED',
              message: 'Snapshot stream contains a paused, purged, or unsupported replication lane'
            })
          }
          const authorDeviceId = manifest.authorDeviceId?.trim()
          const author = authorDeviceId ? this.state.findPeer(syncSpaceId, authorDeviceId) : null
          if (!author || author.status !== 'ACTIVE') {
            return this.sendJson(response, 403, {
              error: 'AUTH_FAILED',
              message: 'Snapshot stream author is not an active trusted peer'
            })
          }
          const authHistory = this.runtime.listAuthObjects(syncSpaceId)
          if (authHistory.length > 0 && !computeActiveGrant(authHistory, authorDeviceId!)) {
            return this.sendJson(response, 403, {
              error: 'AUTH_REVOKED',
              message: 'Snapshot stream author has no active authorization'
            })
          }
          const manifestJson = canonicalJson(JSON.stringify(manifest))
          const now = Date.now()
          this.runtime.deleteExpiredSnapshotStreamStages(now - SNAPSHOT_STREAM_STAGE_TTL_MS)
          const existing = this.runtime.findSnapshotStreamStage(syncSpaceId, snapshotBundleId)
          if (existing) {
            if (existing.transportPeerDeviceId !== remoteDeviceId) {
              return this.sendJson(response, 409, {
                error: 'SNAPSHOT_INCOMPATIBLE',
                message: 'Snapshot stream is already owned by another transport peer'
              })
            }
            if (canonicalJson(existing.manifestJson) !== manifestJson) {
              return this.sendJson(response, 409, {
                error: 'SNAPSHOT_INCOMPATIBLE',
                message: 'Snapshot stream manifest changed after staging began'
              })
            }
          }
          this.runtime.upsertSnapshotStreamStage({
            syncSpaceId,
            snapshotBundleId,
            sourceSnapshotBundleId: manifest.sourceSnapshotBundleId,
            transportPeerDeviceId: remoteDeviceId,
            manifestJson,
            state: 'RECEIVING',
            createdAt: existing?.createdAt ?? now,
            updatedAt: now
          })
          return this.sendJson(response, 200, {
            accepted: true,
            snapshotBundleId,
            expectedShards: manifest.shardDescriptors.length
          })
        }

        // PUT /v1/spaces/:spaceId/snapshots/:bundleId/stream/shards/:lane
        if (segments[5] === 'stream' && segments[6] === 'shards' && segments[7] && request.method === 'PUT') {
          const snapshotBundleId = segments[4]!
          const lane = segments[7]!
          const stage = this.runtime.findSnapshotStreamStage(syncSpaceId, snapshotBundleId)
          if (!stage) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream manifest must be staged before shards'
            })
          }
          if (stage.transportPeerDeviceId !== remoteDeviceId) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream shard came from a different transport peer'
            })
          }
          if (stage.state !== 'RECEIVING') {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream is not accepting shard writes'
            })
          }
          const manifest = JSON.parse(stage.manifestJson) as SyncSnapshotStreamManifestWire
          const descriptor = manifest.shardDescriptors.find((item) => item.replicationLaneId === lane)
          if (!descriptor) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream shard lane is absent from the signed manifest'
            })
          }
          const shardPolicy = new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId)
          if (['PAUSED', 'LOCAL_PURGE', 'UNSUPPORTED'].includes(shardPolicy[lane] ?? 'ENABLED')) {
            return this.sendJson(response, 403, {
              error: 'LANE_POLICY_BLOCKED',
              message: 'Snapshot stream shard lane is no longer enabled'
            })
          }
          const shard = parseJson(bodyBuffer) as unknown as SyncSnapshotShardWire
          if (
            !shard ||
            shard.replicationLaneId !== lane ||
            shard.contentHash !== descriptor.contentHash ||
            shard.frontierJson !== descriptor.frontierJson
          ) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_CORRUPTED',
              message: 'Snapshot stream shard does not match its signed descriptor'
            })
          }
          let calculatedHash: string
          try {
            calculatedHash = snapshotShardContentHash(shard, manifest.hashSchemaVersion)
          } catch (error) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_CORRUPTED',
              message: error instanceof Error ? error.message : String(error)
            })
          }
          if (calculatedHash !== shard.contentHash) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_CORRUPTED',
              message: 'Snapshot stream shard contentHash is invalid'
            })
          }
          const now = Date.now()
          this.runtime.upsertSnapshotStreamShard({
            syncSpaceId,
            snapshotBundleId,
            replicationLaneId: lane,
            contentHash: shard.contentHash,
            shardJson: JSON.stringify(shard),
            updatedAt: now
          })
          this.runtime.upsertSnapshotStreamStage({
            ...stage,
            updatedAt: now
          })
          return this.sendJson(response, 200, {
            accepted: true,
            snapshotBundleId,
            replicationLaneId: lane
          })
        }

        // POST /v1/spaces/:spaceId/snapshots/:bundleId/stream/commit
        if (segments[5] === 'stream' && segments[6] === 'commit' && request.method === 'POST') {
          const snapshotBundleId = segments[4]!
          const stage = this.runtime.findSnapshotStreamStage(syncSpaceId, snapshotBundleId)
          if (!stage) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream manifest must be staged before commit'
            })
          }
          if (stage.transportPeerDeviceId !== remoteDeviceId) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream commit came from a different transport peer'
            })
          }
          if (stage.state !== 'RECEIVING') {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream commit is already in progress'
            })
          }
          if (!this.snapshotInstaller) {
            return this.sendJson(response, 503, {
              error: 'SNAPSHOT_INSTALL_UNAVAILABLE',
              message: 'Snapshot installer is not configured'
            })
          }

          const manifest = JSON.parse(stage.manifestJson) as SyncSnapshotStreamManifestWire
          if (manifest.syncSpaceId !== syncSpaceId || manifest.snapshotBundleId !== snapshotBundleId) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream stage identity does not match commit endpoint'
            })
          }
          const commitPolicy = new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId)
          if (manifest.shardDescriptors.some((descriptor) =>
            ['PAUSED', 'LOCAL_PURGE', 'UNSUPPORTED'].includes(commitPolicy[descriptor.replicationLaneId] ?? 'ENABLED')
          )) {
            return this.sendJson(response, 403, {
              error: 'LANE_POLICY_BLOCKED',
              message: 'Snapshot stream contains a lane that is no longer enabled'
            })
          }
          if (this.runtime.countSnapshotStreamShards(syncSpaceId, snapshotBundleId) !== manifest.shardDescriptors.length) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Snapshot stream is incomplete'
            })
          }

          const authorDeviceId = manifest.authorDeviceId?.trim()
          const author = authorDeviceId ? this.state.findPeer(syncSpaceId, authorDeviceId) : null
          if (!author || author.status !== 'ACTIVE') {
            return this.sendJson(response, 403, {
              error: 'AUTH_FAILED',
              message: 'Snapshot stream author is not an active trusted peer'
            })
          }
          const authHistory = this.runtime.listAuthObjects(syncSpaceId)
          if (authHistory.length > 0 && !computeActiveGrant(authHistory, authorDeviceId!)) {
            return this.sendJson(response, 403, {
              error: 'AUTH_REVOKED',
              message: 'Snapshot stream author was revoked before commit'
            })
          }
          const descriptorsByLane = new Map(
            manifest.shardDescriptors.map((descriptor) => [descriptor.replicationLaneId, descriptor])
          )
          const shardLoader = (lane: string): SyncSnapshotShardWire => {
            const descriptor = descriptorsByLane.get(lane)
            if (!descriptor) throw new Error('SNAPSHOT_CORRUPTED: descriptor is missing for lane ' + lane)
            const staged = this.runtime.findSnapshotStreamShard(syncSpaceId, snapshotBundleId, lane)
            if (!staged || staged.contentHash !== descriptor.contentHash) {
              throw new Error('SNAPSHOT_CORRUPTED: staged shard is missing or changed for lane ' + lane)
            }
            return JSON.parse(staged.shardJson) as SyncSnapshotShardWire
          }

          const committingStage = { ...stage, state: 'COMMITTING', updatedAt: Date.now() }
          this.runtime.upsertSnapshotStreamStage(committingStage)
          try {
            const result = this.snapshotInstaller.installStream(
              this.localAccountId(),
              manifest,
              shardLoader,
              Date.now(),
              new Set(manifest.shardDescriptors.map((descriptor) => descriptor.replicationLaneId))
            )
            this.runtime.deleteSnapshotStreamStage(syncSpaceId, snapshotBundleId)
            return this.sendJson(response, 200, {
              accepted: true,
              snapshotBundleId: result.snapshotBundleId,
              materializedEntities: result.materializedEntities,
              lifecycleState: 'STAGING'
            })
          } catch (error) {
            this.runtime.upsertSnapshotStreamStage({
              ...committingStage,
              state: 'RECEIVING',
              updatedAt: Date.now()
            })
            return this.sendJson(response, 500, {
              error: 'SNAPSHOT_INSTALL_FAILED',
              message: error instanceof Error ? error.message : String(error)
            })
          }
        }

        // POST /v1/spaces/:spaceId/snapshots/:bundleId/accept (修复 C10: 快照恢复确认接收路由)
        if (segments[5] === 'accept' && request.method === 'POST') {
          const body = parseJson(bodyBuffer) as { acceptance?: SyncAuthProtocolObject }
          const acceptance = body.acceptance
          if (!acceptance) {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Recovery acceptance is required'
            })
          }
          const snapshotBundleId = segments[4]!
          const bundle = this.runtime.findSnapshotBundle(snapshotBundleId)
          if (!bundle || bundle.syncSpaceId !== syncSpaceId || bundle.snapshotClass !== 'BOOTSTRAP_RECOVERY') {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'BOOTSTRAP_RECOVERY Snapshot candidate was not found in this Sync Space'
            })
          }
          if (acceptance.syncSpaceId !== syncSpaceId || acceptance.objectType !== 'AUTH_STABILITY_CHECKPOINT') {
            return this.sendJson(response, 400, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Recovery acceptance must be an AUTH stability checkpoint for this Sync Space'
            })
          }
          if (bundle.authStabilityCheckpointId !== acceptance.authObjectId) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'Recovery Snapshot references a different AUTH checkpoint'
            })
          }
          const acceptancePayload = JSON.parse(acceptance.payloadJson) as Record<string, unknown>
          if (acceptancePayload.acceptedSnapshotBundleId !== snapshotBundleId) {
            return this.sendJson(response, 409, {
              error: 'SNAPSHOT_INCOMPATIBLE',
              message: 'OWNER acceptance does not name this Snapshot candidate'
            })
          }
          const ledger = this.runtime.listAuthObjects(syncSpaceId)
          const currentOwner = ledger.at(-1)?.ownerDeviceId
          if (!currentOwner || acceptance.authorDeviceId !== currentOwner || acceptance.ownerDeviceId !== currentOwner) {
            return this.sendJson(response, 403, {
              error: 'AUTH_FAILED',
              message: 'Recovery acceptance is not issued by the current OWNER'
            })
          }
          const existing = ledger.find((entry) => entry.authObjectId === acceptance.authObjectId)
          if (existing) {
            if (canonicalJson(JSON.stringify(existing)) !== canonicalJson(JSON.stringify(acceptance)) ||
                [...ledger].reverse().find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')?.authObjectId !== acceptance.authObjectId) {
              return this.sendJson(response, 409, {
                error: 'SNAPSHOT_INCOMPATIBLE',
                message: 'Recovery acceptance is stale or collides with different AUTH content'
              })
            }
          } else {
            this.authLedger.append(syncSpaceId, [acceptance])
            const latestCheckpoint = [...this.runtime.listAuthObjects(syncSpaceId)].reverse()
              .find((entry) => entry.objectType === 'AUTH_STABILITY_CHECKPOINT')
            if (latestCheckpoint?.authObjectId !== acceptance.authObjectId) {
              return this.sendJson(response, 409, {
                error: 'SNAPSHOT_INCOMPATIBLE',
                message: 'Recovery acceptance did not become the current AUTH checkpoint'
              })
            }
          }
          return this.sendJson(response, 200, {
            accepted: true,
            snapshotBundleId,
            authStabilityCheckpointId: acceptance.authObjectId
          })
        }

        // 快照上传与安装恢复路由：支持 PUT 与 POST (修复 C10)
        if (request.method === 'POST' || request.method === 'PUT') {
          const snapshotWire = parseJson(bodyBuffer) as unknown as SyncSnapshotBundleWire
          if (!snapshotWire || snapshotWire.syncSpaceId !== syncSpaceId || snapshotWire.snapshotBundleId !== segments[4]) {
            return this.sendJson(response, 400, { error: 'REQUEST_ERROR', message: 'Invalid snapshot payload or space mismatch' })
          }
          if (!this.snapshotInstaller) {
            return this.sendJson(response, 503, { error: 'SNAPSHOT_INSTALL_UNAVAILABLE', message: 'Snapshot installer is not configured' })
          }
          const snapshotLanes = new Set(snapshotWire.shards.map((shard) => shard.replicationLaneId))
          const localPolicy = new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId)
          if ([...snapshotLanes].some((lane) =>
            ['PAUSED', 'LOCAL_PURGE', 'UNSUPPORTED'].includes(localPolicy[lane] ?? 'ENABLED')
          )) {
            return this.sendJson(response, 403, {
              error: 'LANE_POLICY_BLOCKED',
              message: 'Snapshot contains a paused, purged, or unsupported replication lane'
            })
          }
          try {
            const result = this.snapshotInstaller.install(
              this.localAccountId(),
              snapshotWire,
              Date.now(),
              snapshotLanes
            )
            return this.sendJson(response, 200, {
              accepted: true,
              snapshotBundleId: result.snapshotBundleId,
              materializedEntities: result.materializedEntities,
              lifecycleState: 'STAGING'
            })
          } catch (installErr) {
            return this.sendJson(response, 500, { error: 'SNAPSHOT_INSTALL_FAILED', message: String(installErr) })
          }
        }
      }

      // Coverage 接收与持久化记录（修复 B31, C17）：严格按 HTTP 认证的 peerDeviceId 保存 Received/Applied/Retained
      if (segments[3] === 'coverage' && request.method === 'POST') {
        const body = parseJson(bodyBuffer) as {
          received?: SyncCoverage
          applied?: SyncCoverage
          retained?: SyncCoverage
          coverage?: SyncCoverage
        }
        // Progress ownership is derived only from the authenticated request header/signature.
        // Never accept a self-reported peer identity from the JSON body.
        if (!remoteDeviceId) {
          return this.sendJson(response, 401, {
            error: 'AUTH_FAILED',
            message: 'Authenticated peer identity is required for coverage reporting'
          })
        }
        const peerDeviceId = remoteDeviceId
        let incomingReceived: SyncCoverage
        let incomingApplied: SyncCoverage
        let incomingRetained: SyncCoverage
        let incomingGeneric: SyncCoverage
        try {
          incomingReceived = mergeMonotonicCoverage({}, (body.received ?? (segments[4] === 'received' ? body.coverage : undefined) ?? {}) as SyncCoverage)
          incomingApplied = mergeMonotonicCoverage({}, (body.applied ?? (segments[4] === 'applied' ? body.coverage : undefined) ?? {}) as SyncCoverage)
          incomingRetained = mergeMonotonicCoverage({}, (body.retained ?? (segments[4] === 'retained' ? body.coverage : undefined) ?? {}) as SyncCoverage)
          incomingGeneric = mergeMonotonicCoverage({}, (body.coverage ?? incomingReceived) as SyncCoverage)
        } catch (error) {
          return this.sendJson(response, 400, {
            error: 'INVALID_COVERAGE',
            message: error instanceof Error ? error.message : String(error)
          })
        }
        try {
          const db = (this.runtime as any).databaseHandle?.() ?? (this.runtime as any).database
          const previous = db.prepare(
            'SELECT received_json,applied_json,retained_json,coverage_json FROM sync_peer_coverage_report WHERE sync_space_id=? AND peer_device_id=? LIMIT 1'
          ).get(syncSpaceId, peerDeviceId) as {
            received_json?: string
            applied_json?: string
            retained_json?: string
            coverage_json?: string
          } | undefined
          const decode = (raw: string | undefined): SyncCoverage => {
            if (!raw) return {}
            return mergeMonotonicCoverage({}, JSON.parse(raw) as SyncCoverage)
          }
          const received = mergeMonotonicCoverage(decode(previous?.received_json), incomingReceived)
          const applied = mergeMonotonicCoverage(decode(previous?.applied_json), incomingApplied)
          const retained = mergeMonotonicCoverage(decode(previous?.retained_json), incomingRetained)
          const genericCoverage = mergeMonotonicCoverage(
            decode(previous?.coverage_json),
            incomingGeneric
          )
          db.prepare(`
            INSERT INTO sync_peer_coverage_report (sync_space_id, peer_device_id, received_json, applied_json, retained_json, coverage_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sync_space_id, peer_device_id) DO UPDATE SET
              received_json = excluded.received_json,
              applied_json = excluded.applied_json,
              retained_json = excluded.retained_json,
              coverage_json = excluded.coverage_json,
              updated_at = excluded.updated_at
          `).run(
            syncSpaceId,
            peerDeviceId,
            JSON.stringify(received),
            JSON.stringify(applied),
            JSON.stringify(retained),
            JSON.stringify(genericCoverage),
            Date.now()
          )
        } catch (error) {
          return this.sendJson(response, 500, {
            error: 'COVERAGE_PERSIST_FAILED',
            message: error instanceof Error ? error.message : String(error)
          })
        }
        return this.sendJson(response, 204, null)
      }

      // Blob 路由（修复 B17, B19, B20, B25, B34）
      if (segments[3] === 'blobs' && segments[4]) {
        const hash = segments[4].toLowerCase()
        // 严格防路径穿越校验（B34）：仅允许 64 位纯十六进制 SHA-256 哈希
        if (!/^[0-9a-f]{64}$/.test(hash)) {
          return this.sendJson(response, 400, {
            error: 'INVALID_HASH',
            message: 'Blob hash must be a 64-character lowercase hex SHA-256 string'
          })
        }
        if (segments[5] === 'status' && request.method === 'GET') {
          return this.handleBlobStatus(response, syncSpaceId, hash, localDeviceId, remoteDeviceId)
        }
        if (segments[5] === 'reserve' && request.method === 'POST') {
          if (!this.localBlobStore) throw new Error('BLOB_STORE_UNAVAILABLE')
          const value = parseJson(bodyBuffer) as unknown as SyncBlobUploadReservation
          if (value.manifest?.hash !== hash) throw new Error('INVALID_BLOB_RESERVATION')
          const now = Date.now()
          const error = this.enforceStagingBudget(syncSpaceId, hash, remoteDeviceId, value.manifest.totalBytes, now)
          if (error) return this.sendJson(response, 507, { error: 'BLOB_STAGING_LIMIT', message: error })
          saveBlobReservation({ root: this.localBlobStore.getRoot(), space: syncSpaceId, peer: remoteDeviceId,
            value, policy: new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId) })
          const stage = join(this.localBlobStore.getRoot(), `${hash}.stage`)
          if (!existsSync(stage)) writeFileSync(stage, JSON.stringify({
            peerDeviceId: remoteDeviceId, syncSpaceId, totalBytes: value.manifest.totalBytes, createdAt: now
          }))
          return this.sendJson(response, 204, null)
        }
        if (request.method === 'GET') {
          return this.handleBlobFetch(request, response, syncSpaceId, hash)
        }
        if (request.method === 'PUT' || request.method === 'POST') {
          return this.handleBlobPush(request, response, syncSpaceId, hash, localDeviceId, bodyBuffer, remoteDeviceId)
        }
      }

      this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Unknown endpoint' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const incompatible = message.startsWith('SYNC_VERSION_MISMATCH:')
      const status = incompatible ? 409 : message.includes('AUTH') ? 401 : message.includes('expired') ? 401 : 400
      this.sendJson(response, status, { error: incompatible ? 'SYNC_VERSION_MISMATCH' : 'REQUEST_ERROR', message })
    }
  }

  private async handlePairing(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    clientIp: string,
    clientPort: number
  ): Promise<void> {
    const action = segments[2]
    if (request.method === 'POST' && action === 'start') {
      const bodyBuffer = await readBody(request, MAX_PAIRING_BODY_BYTES)
      const req = parseJson(bodyBuffer) as any
      const resp = this.pairing.handleStartRequest(req, clientIp, clientPort)
      return this.sendJson(response, 200, resp)
    }
    if (request.method === 'POST' && action === 'confirm') {
      const bodyBuffer = await readBody(request, MAX_PAIRING_BODY_BYTES)
      const req = parseJson(bodyBuffer) as any
      const resp = await this.pairing.handleConfirmRequest(req)
      return this.sendJson(response, 200, resp)
    }
    if (request.method === 'POST' && action === 'cancel') {
      const bodyBuffer = await readBody(request, MAX_PAIRING_BODY_BYTES)
      const req = parseJson(bodyBuffer) as any
      // 取消请求必须经过签名鉴权校验（B13）
      this.pairing.handleCancelRequest(req)
      return this.sendJson(response, 204, null)
    }
    if (request.method === 'GET' && action === 'status') {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      // 修复 B28：状态接口仅返回受控公开 DTO，绝不暴露私钥或会话 key
      const publicDto = this.pairing.getSessionPublicDto(sessionId)
      if (publicDto) return this.sendJson(response, 200, publicDto)
      return this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Pairing session not found' })
    }
    this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Unknown pairing endpoint' })
  }

  /**
   * 修复 B20, B17, B35, B19, C12, C13, C15：
   * 1. 针对缺失分块返回 JSON null（字符串 "null"）；
   * 2. 0 字节合法空 Blob 状态一致性；
   * 3. 校验磁盘文件完整性，损坏文件不宣称 complete；
   * 4. 优先从 .meta 持久化信息中读取文件真实原始 totalBytes (C12)；
   * 5. 允许同空间受信任 Peer 预授权查询待上传状态 (C13)。
   */
  private handleBlobStatus(
    response: ServerResponse,
    syncSpaceId: string,
    hash: string,
    localDeviceId: string,
    remoteDeviceId?: string
  ): void {
    if (!this.localBlobStore) {
      return this.sendJson(response, 200, null)
    }
    // 空间与 Lane 策略校验（B17, C13：允许合法对端查询待上传状态）
    this.verifyBlobSpaceAndLane(syncSpaceId, hash, true, remoteDeviceId)
    const db = this.runtime.databaseHandle()
    const referenced = db.prepare(
      'SELECT 1 AS present FROM sync_blob_reference WHERE sync_space_id=? AND hash=? LIMIT 1'
    ).get(syncSpaceId, hash)
    if (!referenced) {
      const stagePath = join(this.localBlobStore.getRoot(), `${hash}.stage`)
      if (!existsSync(stagePath)) {
        return this.sendJson(response, 403, {
          error: 'AUTH_FORBIDDEN',
          message: 'Unreferenced Blob status is only available to its staging peer'
        })
      }
      let marker: { peerDeviceId?: string; syncSpaceId?: string; totalBytes?: number; createdAt?: number }
      try {
        marker = JSON.parse(readFileSync(stagePath, 'utf8'))
      } catch {
        return this.sendJson(response, 409, { error: 'BLOB_STAGE_CORRUPTED' })
      }
      if (!remoteDeviceId || marker.peerDeviceId !== remoteDeviceId || marker.syncSpaceId !== syncSpaceId) {
        return this.sendJson(response, 403, {
          error: 'AUTH_FORBIDDEN',
          message: 'Unreferenced Blob staging belongs to another peer'
        })
      }
    }

    const blobPath = this.localBlobStore.getBlobPath(hash)
    if (blobPath && existsSync(blobPath)) {
      const stat = statSync(blobPath)
      // 0 字节合法空 Blob 支持 (C15)
      const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      if (stat.size === 0 && hash === EMPTY_SHA256) {
        return this.sendJson(response, 200, {
          hash,
          totalBytes: 0,
          receivedBytes: 0,
          receivedPrefixSha256: EMPTY_SHA256,
          complete: true,
          replicaId: localDeviceId,
          persistedAt: Math.floor(stat.mtimeMs)
        })
      }
      // 校验文件内容完整性（B35, C15）：如果存在损坏，绝不报告 complete=true
      if (!this.localBlobStore.verifyFile(hash, blobPath, true)) {
        return this.sendJson(response, 200, {
          hash,
          totalBytes: stat.size,
          receivedBytes: 0,
          receivedPrefixSha256: '',
          complete: false,
          corrupted: true,
          replicaId: localDeviceId,
          persistedAt: Math.floor(stat.mtimeMs)
        })
      }
      return this.sendJson(response, 200, {
        hash,
        totalBytes: stat.size,
        receivedBytes: stat.size,
        receivedPrefixSha256: hash,
        complete: true,
        replicaId: localDeviceId,
        persistedAt: Math.floor(stat.mtimeMs)
      })
    }
    // 检查分块暂存文件（B19, C12）
    const partPath = join(this.localBlobStore.getRoot(), `${hash}.part`)
    const metaPath = join(this.localBlobStore.getRoot(), `${hash}.meta`)
    if (existsSync(partPath)) {
      const stat = statSync(partPath)
      const prefixHash = this.localBlobStore.hashFile(partPath)

      // 优先从持久化的 .meta 中读取真实文件原始总长度 (C12)
      let expectedTotal = stat.size
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          if (meta.totalBytes) expectedTotal = Number(meta.totalBytes)
        } catch {}
      }

      return this.sendJson(response, 200, {
        hash,
        totalBytes: Math.max(expectedTotal, stat.size),
        receivedBytes: stat.size,
        receivedPrefixSha256: prefixHash,
        complete: false,
        replicaId: localDeviceId,
        persistedAt: Math.floor(stat.mtimeMs)
      })
    }
    return this.sendJson(response, 200, null)
  }

  /**
   * 修复 B17 空间与 Lane 策略校验，修复 B25 流式按需读取 Range 避免全量内存加载。
   */
  private handleBlobFetch(request: IncomingMessage, response: ServerResponse, syncSpaceId: string, hash: string): void {
    if (!this.localBlobStore) {
      return this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Blob store not configured' })
    }
    this.verifyBlobSpaceAndLane(syncSpaceId, hash, false)

    const blobPath = this.localBlobStore.getBlobPath(hash)
    if (!blobPath || !existsSync(blobPath)) {
      return this.sendJson(response, 404, { error: 'NOT_FOUND', message: 'Blob not found' })
    }
    if (!this.localBlobStore.verifyFile(hash, blobPath, !request.headers.range || request.headers.range.startsWith('bytes=0-'))) {
      this.localBlobStore.remove(hash)
      return this.sendJson(response, 409, { error: 'BLOB_CORRUPTED', message: 'Local Blob failed SHA-256 verification' })
    }

    const deviceId = String(request.headers[HEADER_DEVICE_ID])
    const peer = this.requireActivePeer(syncSpaceId, deviceId)
    this.blobResponses.add(response)
    response.once('close', () => this.blobResponses.delete(response))
    sendBlobFile({ request, response, blobPath,
      authorize: () => {
        if (!this.tlsServer?.listening) throw new Error('LAN_DISABLED: Blob transfer listener is closed')
        const binding = this.runtime.findBinding(this.localAccountId())
        if (binding?.syncSpaceId !== syncSpaceId) throw new Error('SPACE_CHANGED: Blob transfer account binding changed')
        const current = this.requireActivePeer(syncSpaceId, deviceId)
        if (current.publicKeySpkiBase64 !== peer.publicKeySpkiBase64) throw new Error('AUTH_FAILED: Peer key changed during Blob transfer')
        this.verifyBlobSpaceAndLane(syncSpaceId, hash, false)
      },
      onFailure: error => console.error('LAN Blob transfer stopped:', error.message)
    })
  }

  /**
   * 修复 B17 空间/Lane 隔离，修复 B19, C11, C12 分块暂存与整体验签持久化落盘。
   */
  private handleBlobPush(
    request: IncomingMessage,
    response: ServerResponse,
    syncSpaceId: string,
    hash: string,
    localDeviceId: string,
    bodyBuffer: Buffer,
    remoteDeviceId?: string
  ): void {
    if (!this.localBlobStore) {
      return this.sendJson(response, 503, { error: 'BLOB_STORE_UNAVAILABLE' })
    }
    this.verifyBlobSpaceAndLane(syncSpaceId, hash, true, remoteDeviceId)

    const offset = Number(request.headers['x-sync-offset'] ?? 0)
    const totalBytes = Number(request.headers['x-sync-total-bytes'] ?? bodyBuffer.length)
    const isFinal = String(request.headers['x-sync-final'] ?? 'false') === 'true'
    const now = Date.now()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalBytes) || totalBytes < 0 ||
        offset + bodyBuffer.length > totalBytes) {
      return this.sendJson(response, 400, { error: 'INVALID_CHUNK', message: 'Invalid Blob chunk bounds' })
    }

    const partPath = join(this.localBlobStore.getRoot(), `${hash}.part`)
    const metaPath = join(this.localBlobStore.getRoot(), `${hash}.meta`)
    const stagePath = join(this.localBlobStore.getRoot(), `${hash}.stage`)
    const references = this.runtime.databaseHandle().prepare(
      'SELECT 1 AS present FROM sync_blob_reference WHERE sync_space_id=? AND hash=? LIMIT 1'
    ).get(syncSpaceId, hash)
    if (!references) {
      let stageCreatedAt = now
      requireBlobReservation({ root: this.localBlobStore.getRoot(), space: syncSpaceId,
        peer: remoteDeviceId ?? '', hash, totalBytes, policy: new SyncLocalLanePolicy(this.runtime.databaseHandle()).read(syncSpaceId) })
      if (existsSync(stagePath)) {
        let marker: { peerDeviceId?: string; syncSpaceId?: string; totalBytes?: number; createdAt?: number }
        try {
          marker = JSON.parse(readFileSync(stagePath, 'utf8'))
        } catch {
          rmSync(stagePath, { force: true })
          rmSync(partPath, { force: true })
          rmSync(metaPath, { force: true })
          if (offset !== 0) {
            return this.sendJson(response, 409, {
              error: 'BLOB_STAGE_CORRUPTED',
              message: 'Blob staging metadata is corrupted; restart from offset 0'
            })
          }
          marker = {}
        }
        if (Object.keys(marker).length > 0) {
          if (
            marker.peerDeviceId !== (remoteDeviceId ?? '') ||
            marker.syncSpaceId !== syncSpaceId ||
            marker.totalBytes !== totalBytes
          ) {
            return this.sendJson(response, 409, {
              error: 'BLOB_STAGE_CONFLICT',
              message: 'Blob staging reservation belongs to another peer, space, or declared size'
            })
          }
          if (!Number.isSafeInteger(marker.createdAt) || Number(marker.createdAt) <= 0) {
            return this.sendJson(response, 409, { error: 'BLOB_STAGE_CORRUPTED' })
          }
          stageCreatedAt = Number(marker.createdAt)
        }
      }
      const stagingError = this.enforceStagingBudget(syncSpaceId, hash, remoteDeviceId ?? '', totalBytes, now)
      if (stagingError) {
        return this.sendJson(response, 507, { error: 'BLOB_STAGING_LIMIT', message: stagingError })
      }
      if (!existsSync(stagePath)) {
        writeFileSync(stagePath, JSON.stringify({
          peerDeviceId: remoteDeviceId ?? '',
          syncSpaceId,
          totalBytes,
          createdAt: stageCreatedAt
        }))
      }
    } else if (existsSync(stagePath)) {
      rmSync(stagePath, { force: true })
    }

    // 单块直接上传且为最终块的快速路径。Final 必须覆盖完整 declared Blob。
    if (isFinal && offset === 0 && bodyBuffer.length === totalBytes) {
      const digest = hashBufferHex(bodyBuffer)
      if (digest !== hash) {
        return this.sendJson(response, 400, { error: 'CHECKSUM_MISMATCH', message: 'Payload hash does not match' })
      }
      this.localBlobStore.putVerified(hash, new Uint8Array(bodyBuffer))
      if (existsSync(partPath)) rmSync(partPath, { force: true })
      if (existsSync(metaPath)) rmSync(metaPath, { force: true })
      this.state.recordPersistedAck({ syncSpaceId, hash, replicaId: localDeviceId, totalBytes: totalBytes, persistedAt: now,
        storageGeneration: this.localBlobStore.storageGeneration, custodyState: 'HOLDING' })
      return this.sendJson(response, 200, {
        syncSpaceId,
        hash,
        replicaId: localDeviceId,
        totalBytes,
        complete: true,
        durable: true,
        protocolVersion: 1,
        storageGeneration: this.localBlobStore.storageGeneration,
        custodyState: 'HOLDING',
        persistedAt: now
      })
    }
    if (isFinal && offset === 0 && bodyBuffer.length !== totalBytes) {
      return this.sendJson(response, 400, {
        error: 'INVALID_CHUNK',
        message: 'Final Blob chunk does not cover the declared total size'
      })
    }

    // 多分块暂存处理（B19, C11, C12）
    if (offset === 0) {
      writeFileSync(partPath, bodyBuffer)
      writeFileSync(metaPath, JSON.stringify({ totalBytes, hash, peerId: remoteDeviceId, createdAt: now }))
    } else {
      if (!existsSync(partPath)) {
        return this.sendJson(response, 409, { error: 'CHUNK_ORDER_MISMATCH', message: 'Missing initial chunk' })
      }
      const currentSize = statSync(partPath).size
      if (currentSize !== offset) {
        return this.sendJson(response, 409, {
          error: 'CHUNK_ORDER_MISMATCH',
          message: `Chunk offset ${offset} does not match current size ${currentSize}`
        })
      }
      appendFileSync(partPath, bodyBuffer)
    }

    if (isFinal) {
      const stagedBytes = statSync(partPath).size
      if (stagedBytes !== totalBytes) {
        return this.sendJson(response, 400, {
          error: 'INVALID_CHUNK',
          message: `Final Blob size ${stagedBytes} does not match declared total ${totalBytes}`
        })
      }
      const digest = this.localBlobStore.hashFile(partPath)
      if (digest !== hash) {
        rmSync(partPath, { force: true })
        if (existsSync(metaPath)) rmSync(metaPath, { force: true })
        return this.sendJson(response, 400, { error: 'CHECKSUM_MISMATCH', message: 'Combined hash does not match' })
      }
      const installedBytes = this.localBlobStore.installVerifiedFile(hash, partPath)
      if (existsSync(metaPath)) rmSync(metaPath, { force: true })
      this.state.recordPersistedAck({ syncSpaceId, hash, replicaId: localDeviceId, totalBytes: installedBytes, persistedAt: now,
        storageGeneration: this.localBlobStore.storageGeneration, custodyState: 'HOLDING' })
      return this.sendJson(response, 200, {
        syncSpaceId,
        hash,
        replicaId: localDeviceId,
        totalBytes: installedBytes,
        complete: true,
        durable: true,
        protocolVersion: 1,
        storageGeneration: this.localBlobStore.storageGeneration,
        custodyState: 'HOLDING',
        persistedAt: now
      })
    }

    // A non-final chunk has no durable ACK semantics. Progress is recovered through /status.
    response.writeHead(204)
    response.end()
    return
  }

  private enforceStagingBudget(
    syncSpaceId: string,
    hash: string,
    peerDeviceId: string,
    totalBytes: number,
    now: number
  ): string | null {
    if (totalBytes > MAX_UNREFERENCED_BLOB_BYTES) {
      return 'Unreferenced Blob exceeds the staging size limit'
    }
    if (!this.localBlobStore) return 'Blob store is unavailable'
    const root = this.localBlobStore.getRoot()
    const db = this.runtime.databaseHandle()
    let totalStaged = 0
    let peerStaged = 0
    for (const file of readdirSync(root)) {
      if (!file.endsWith('.stage')) continue
      const stagedHash = file.slice(0, -'.stage'.length)
      const markerPath = join(root, file)
      let marker: { peerDeviceId?: string; syncSpaceId?: string; totalBytes?: number; createdAt?: number }
      try {
        marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      } catch {
        rmSync(markerPath, { force: true })
        continue
      }
      if (!/^[0-9a-f]{64}$/.test(stagedHash) || !marker.syncSpaceId ||
          !Number.isSafeInteger(marker.totalBytes) || !Number.isSafeInteger(marker.createdAt)) {
        rmSync(markerPath, { force: true })
        continue
      }
      const referenced = db.prepare(
        'SELECT 1 AS present FROM sync_blob_reference WHERE sync_space_id=? AND hash=? LIMIT 1'
      ).get(marker.syncSpaceId, stagedHash)
      if (referenced) {
        rmSync(markerPath, { force: true })
        rmSync(join(root, `${stagedHash}.reservation`), { force: true })
        continue
      }
      if ((marker.createdAt ?? 0) <= 0 || now - (marker.createdAt ?? 0) > STAGED_BLOB_TTL_MS) {
        this.localBlobStore.remove(stagedHash)
        rmSync(join(root, `${stagedHash}.part`), { force: true })
        rmSync(join(root, `${stagedHash}.meta`), { force: true })
        rmSync(join(root, `${stagedHash}.reservation`), { force: true })
        rmSync(markerPath, { force: true })
        continue
      }
      if (stagedHash === hash && marker.syncSpaceId === syncSpaceId) continue
      const stagedBytes = Number(marker.totalBytes ?? 0)
      totalStaged += stagedBytes
      if (marker.syncSpaceId === syncSpaceId && marker.peerDeviceId === peerDeviceId) peerStaged += stagedBytes
    }
    if (totalStaged + totalBytes > MAX_STAGED_BLOB_BYTES_TOTAL) {
      return 'Total unreferenced Blob staging quota is exhausted'
    }
    if (peerStaged + totalBytes > MAX_STAGED_BLOB_BYTES_PER_PEER) {
      return 'Peer unreferenced Blob staging quota is exhausted'
    }
    return null
  }

  /**
   * 修复 B17, B30, C13, C14, C16：
   * 1. 支持同空间受信任 Peer 预授权暂存上传 (消除 C13 死锁)；
   * 2. 严格按空间结构化引用索引检查；
   * 3. 严格在出口拦截 PAUSED 与 LOCAL_PURGE lane。
   */
  private verifyBlobSpaceAndLane(syncSpaceId: string, hash: string, isUpload = false, remoteDeviceId?: string): void {
    const db = this.runtime.databaseHandle()
    const localPolicy = new SyncLocalLanePolicy(db).read(syncSpaceId)
    const rows = db.prepare(
      'SELECT replication_lane_id FROM sync_blob_reference WHERE sync_space_id=? AND hash=? ORDER BY replication_lane_id'
    ).all(syncSpaceId, hash) as Array<{ replication_lane_id: string }>
    if (rows.length === 0) {
      if (isUpload && remoteDeviceId && this.localBlobStore) {
        requireBlobReservation({ root: this.localBlobStore.getRoot(), space: syncSpaceId,
          peer: remoteDeviceId, hash, policy: localPolicy })
        return
      }
      throw new Error(`AUTH_FORBIDDEN: Blob ${hash} does not belong to space ${syncSpaceId}`)
    }

    // Structured references are the only source of lane authorization. Arbitrary JSON text
    // containing the same hash is never treated as a Blob reference.
    const hasActiveLane = rows.some((r) => {
      const policy = localPolicy[r.replication_lane_id]
      return policy !== 'PAUSED' && policy !== 'LOCAL_PURGE' && policy !== 'UNSUPPORTED'
    })
    if (!hasActiveLane) {
      throw new Error(`AUTH_FORBIDDEN: Blob belongs exclusively to paused or purged lanes`)
    }
  }

  /** 请求开始和每个传输块都核对当前信任及 signed grant；不重新消费已验证请求的 nonce。 */
  private requireActivePeer(syncSpaceId: string, deviceId: string) {
    const peer = this.state.findPeer(syncSpaceId, deviceId)
    if (!peer || peer.status === 'REVOKED') throw new Error('AUTH_FAILED: Peer device is not trusted or revoked')
    const history = this.runtime.listAuthObjects(syncSpaceId)
    if (history.length && !computeActiveGrant(history, deviceId)) throw new Error('AUTH_REVOKED: Device has no active signed authorization')
    return peer
  }

  private requirePeerAuthorization(
    request: IncomingMessage,
    syncSpaceId: string,
    rawTarget: string,
    bodyBuffer: Buffer
  ): void {
    const deviceId = request.headers[HEADER_DEVICE_ID]
    if (typeof deviceId !== 'string' || !deviceId.trim()) {
      throw new Error('AUTH_FAILED: Missing device id header')
    }
    const peer = this.requireActivePeer(syncSpaceId, deviceId)

    const rawTimestamp = request.headers[HEADER_TIMESTAMP]
    if (typeof rawTimestamp !== 'string' || !rawTimestamp.trim()) {
      throw new Error('AUTH_FAILED: Missing timestamp header')
    }
    const timestamp = Number(rawTimestamp)
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
      throw new Error('REQUEST_EXPIRED: Timestamp skew outside allowed window')
    }

    const nonce = request.headers[HEADER_NONCE]
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) {
      throw new Error('AUTH_FAILED: Invalid or missing nonce header')
    }

    const signature = request.headers[HEADER_SIGNATURE]
    if (typeof signature !== 'string' || !signature.trim()) {
      throw new Error('AUTH_FAILED: Missing signature header')
    }

    const bodyDigest = hashBufferHex(bodyBuffer)
    const material = canonicalSigningMaterial(request.method ?? 'GET', rawTarget, rawTimestamp, nonce, bodyDigest)
    const pubKey = createPublicKey({ key: Buffer.from(peer.publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
    const verified = cryptoVerify('sha256', Buffer.from(material, 'utf8'), pubKey, Buffer.from(signature, 'base64'))
    if (!verified) {
      throw new Error('INVALID_SIGNATURE: Signature verification failed')
    }

    if (!this.nonceCache.checkAndRecord(`${syncSpaceId}:${deviceId}:${nonce}`, Date.now())) {
      throw new Error('REPLAY_DETECTED: Nonce already used')
    }
  }

  /**
   * 修复 B20 与 B12：当 body === null 时，除 204 外输出 "null"，杜绝 EOFException
   * 响应头附带服务端数字签名与时间戳，防止响应被中间人伪造 (B12)
   */
  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = body === null ? (status === 204 ? '' : 'null') : JSON.stringify(body)
    const timestamp = String(Date.now())
    const nonce = randomUUID()
    const payloadHash = sha256Hex(payload)
    const material = `SYNC_LAN_RESPONSE\n${status}\n${timestamp}\n${nonce}\n${payloadHash}`
    let signature = ''
    try {
      const device = this.runtime.findDeviceIdentity()
      if (device) {
        signature = this.keys.signBase64(device.deviceId, material)
      }
    } catch {
      // 容错处理
    }

    const headers: Record<string, string | number> = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload, 'utf8'),
      connection: 'close',
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_NONCE]: nonce
    }
    if (signature) {
      headers[HEADER_SIGNATURE] = signature
    }

    response.writeHead(status, headers)
    response.end(payload)
  }
}

function readBody(request: IncomingMessage, maxBytes = MAX_DEFAULT_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers['content-length']
    if (typeof declaredLength === 'string') {
      const parsed = Number(declaredLength)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
        reject(new Error('Request body exceeded maximum allowed size for this Sync route'))
        request.destroy()
        return
      }
    }
    const chunks: Buffer[] = []
    let totalLength = 0
    request.on('data', (chunk: Buffer) => {
      totalLength += chunk.length
      if (totalLength > maxBytes) {
        reject(new Error('Request body exceeded maximum allowed size for this Sync route'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function requestBodyLimit(method: string, pathname: string): number {
  if (method === 'POST' && pathname.startsWith('/v1/pairing/')) return MAX_PAIRING_BODY_BYTES
  if ((method === 'PUT' || method === 'POST') && /^\/v1\/spaces\/[^/]+\/blobs\/[^/]+$/.test(pathname)) {
    return MAX_BLOB_CHUNK_BODY_BYTES
  }
  if ((method === 'PUT' || method === 'POST') && /^\/v1\/spaces\/[^/]+\/snapshots\/[^/]+$/.test(pathname)) {
    return MAX_SNAPSHOT_BODY_BYTES
  }
  if ((method === 'PUT' || method === 'POST') &&
      /^\/v1\/spaces\/[^/]+\/snapshots\/[^/]+\/stream\/shards\/[^/]+$/.test(pathname)) {
    return MAX_SNAPSHOT_BODY_BYTES
  }
  return MAX_DEFAULT_BODY_BYTES
}

function parseJson(buffer: Buffer): Record<string, unknown> {
  if (buffer.length === 0) return {}
  return parseSyncJson(buffer.toString('utf8')) as Record<string, unknown>
}

function parseRanges(raw: string | null): SyncRange[] {
  if (!raw) return []
  try {
    return JSON.parse(raw) as SyncRange[]
  } catch {
    return []
  }
}
