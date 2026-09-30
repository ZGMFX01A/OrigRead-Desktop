import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { SyncAuthProtocolObject, SyncOperationEnvelope, SyncSnapshotBundleWire, SyncRange, SyncCoverage, SyncCursor } from '../../../shared/sync-protocol'
import { SyncServerError, SyncServerStore, SYNC_SERVER_CAPABILITIES, type SyncServerStoreOptions } from './sync-server-store'
import { computeActiveGrant } from '../sync-runtime-repository'
import {
  HEADER_DEVICE_ID,
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_CLOCK_SKEW_MS,
  SyncNonceCache,
  canonicalSigningMaterial,
  sha256Hex
} from '../sync-http-auth'

const MAX_DEFAULT_BODY_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_BODY_BYTES = 64 * 1024 * 1024
const MAX_BLOB_CHUNK_BODY_BYTES = 5 * 1024 * 1024
const MAX_ADMIN_BODY_BYTES = 1024 * 1024

export interface SyncServerHttpOptions extends SyncServerStoreOptions {
  host?: string
  port?: number
  adminToken?: string
}

/**
 * 桌面端/云端 HTTP 同步服务。
 *
 * 遵循 R11-R13 规范：
 * 1. 暴露 OrigRead Sync v1 HTTP(S) 协议路由；
 * 2. 强制执行基于设备公钥的数字签名校验与 Nonce 防重放（防冒名与防重放闭环）；
 * 3. 对成员管理和历史回滚路由执行管理员 Token 鉴权。
 */
export class SyncServerHttp {
  readonly store: SyncServerStore
  private readonly server: Server
  private readonly options: Required<Pick<SyncServerHttpOptions, 'host' | 'port'>> & SyncServerHttpOptions
  private readonly nonceCache = new SyncNonceCache()

  constructor(options: SyncServerHttpOptions) {
    this.options = { host: options.host ?? '127.0.0.1', port: options.port ?? 8787, ...options }
    this.store = new SyncServerStore(options)
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => { this.server.off('listening', onListening); reject(error) }
      const onListening = (): void => {
        this.server.off('error', onError)
        const address = this.server.address()
        if (!address || typeof address === 'string') return reject(new Error('Sync server did not expose a TCP address'))
        resolve({ host: address.address, port: address.port })
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.port, this.options.host)
    })
  }

  close(): Promise<void> {
    this.store.close()
    return new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rawTarget = request.url ?? '/'
      const url = new URL(rawTarget, `http://${request.headers.host ?? 'localhost'}`)

      // 健康检查免鉴权
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return this.sendJson(response, 200, { ok: true, protocol: 'origread-sync-v1' })
      }

      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (segments[0] !== 'v1' || segments[1] !== 'spaces' || !segments[2]) {
        throw new SyncServerError(404, 'NOT_FOUND', 'Unknown Sync endpoint')
      }
      const syncSpaceId = segments[2]

      // 成员管理操作需管理员权限
      if (segments[3] === 'members' && segments[4]) {
        return await this.handleMember(request, response, syncSpaceId, segments[4])
      }

      // 历史回滚操作需管理员权限
      if (segments[3] === 'history' && segments[4] === 'rewind' && request.method === 'POST') {
        this.requireAdmin(request)
        return this.sendJson(response, 200, { code: 'SERVER_HISTORY_REWIND', serverCursor: this.store.rewindHistory() })
      }

      // 读取请求体 Buffer 并计算 SHA-256；不同路由使用独立硬上限，避免大请求耗尽内存。
      const bodyBuffer = await readBody(
        request,
        requestBodyLimit(request.method ?? 'GET', url.pathname)
      )

      // 验证设备成员身份、防重放与数字签名
      this.requireMember(request, syncSpaceId, rawTarget, bodyBuffer)

      if (segments[3] === 'auth' && segments[4] === 'ledger') {
        if (request.method === 'GET') return this.sendJson(response, 200, this.store.authLedger(syncSpaceId))
        if (request.method === 'POST') {
          const body = parseJson(bodyBuffer)
          const objects = Array.isArray(body.objects) ? body.objects as SyncAuthProtocolObject[] : body.object ? [body.object as SyncAuthProtocolObject] : []
          return this.sendJson(response, 200, this.store.appendAuthObjects(syncSpaceId, objects))
        }
      }
      if (segments[3] === 'session' && request.method === 'POST') {
        const deviceId = this.deviceId(request)
        return this.sendJson(response, 200, {
          syncSpaceId,
          localDeviceId: deviceId,
          remoteDeviceId: 'durable-sync-peer',
          capabilities: SYNC_SERVER_CAPABILITIES,
          serverCursor: this.store.currentCursor()
        })
      }
      if (segments[3] === 'state' && request.method === 'GET') return this.sendJson(response, 200, this.store.state(syncSpaceId))
      if (segments[3] === 'operations') {
        if (request.method === 'GET') {
          const ranges = parseRanges(url.searchParams.get('ranges'))
          const cursor = parseCursor(url.searchParams.get('cursor'))
          return this.sendJson(response, 200, this.store.requestOperations(syncSpaceId, ranges, cursor))
        }
        if (request.method === 'POST') {
          const body = parseJson(bodyBuffer)
          const operations = Array.isArray(body.operations) ? body.operations as SyncOperationEnvelope[] : []
          if (!Array.isArray(body.operations) || operations.length > 500) throw new SyncServerError(400, 'INVALID_REQUEST', 'Expected at most 500 operations')
          return this.sendJson(response, 200, this.store.putOperations(syncSpaceId, operations))
        }
      }
      if (segments[3] === 'snapshots' && segments[4] === 'latest' && request.method === 'GET') {
        const lanes = url.searchParams.get('lanes')?.split(',').filter(Boolean)
        return this.sendJson(response, 200, this.store.latestSnapshot(syncSpaceId, url.searchParams.get('class') as SyncSnapshotBundleWire['snapshotClass'] | null ?? undefined, lanes))
      }
      if (segments[3] === 'snapshots' && segments[4] && request.method === 'PUT') {
        const snapshot = parseJson(bodyBuffer) as unknown as SyncSnapshotBundleWire
        if (snapshot.syncSpaceId !== syncSpaceId || snapshot.snapshotBundleId !== segments[4]) {
          throw new SyncServerError(409, 'SNAPSHOT_INCOMPATIBLE', 'Snapshot identity does not match the endpoint scope')
        }
        this.store.putSnapshot(snapshot)
        return this.sendJson(response, 204, null)
      }
      if (segments[3] === 'snapshots' && segments[4] && segments[5] === 'accept' && request.method === 'POST') {
        const body = parseJson(bodyBuffer)
        this.store.promoteRecoverySnapshot(syncSpaceId, segments[4], body.acceptance as SyncAuthProtocolObject)
        return this.sendJson(response, 204, null)
      }
      if (segments[3] === 'coverage' && segments[4] && request.method === 'POST') {
        const body = parseJson(bodyBuffer)
        const kind = segments[4]
        if (kind !== 'received' && kind !== 'applied' && kind !== 'retained') throw new SyncServerError(404, 'NOT_FOUND', 'Unknown coverage kind')
        const coverage = (
          kind === 'received' ? body.received ?? body.coverage :
          kind === 'applied' ? body.applied ?? body.coverage :
          body.retained ?? body.coverage
        ) as SyncCoverage | undefined
        if (!coverage) throw new SyncServerError(400, 'INVALID_COVERAGE', `${kind} coverage is required`)
        this.store.putCoverage(syncSpaceId, this.deviceId(request), kind, coverage)
        return this.sendJson(response, 204, null)
      }
      if (segments[3] === 'blobs' && segments[4]) {
        if (segments[5] === 'status' && request.method === 'GET') {
          return this.sendJson(response, 200, this.store.blobStatus(syncSpaceId, segments[4]))
        }
        if (request.method === 'GET') {
          const range = parseByteRange(request.headers.range)
          const chunk = this.store.getBlob(syncSpaceId, segments[4], range?.offset ?? 0, range?.length)
          if (range && (chunk.totalBytes === 0 || chunk.offset >= chunk.totalBytes)) {
            response.writeHead(416, {
              'content-type': 'application/json',
              'content-range': `bytes */${chunk.totalBytes}`
            })
            response.end(JSON.stringify({ error: 'RANGE_NOT_SATISFIABLE' }))
            return
          }
          const status = range ? 206 : chunk.isFinal ? 200 : 206
          response.writeHead(status, {
            'content-type': 'application/octet-stream',
            'content-length': chunk.bytes.byteLength,
            'x-sync-offset': chunk.offset,
            'x-sync-total-bytes': chunk.totalBytes,
            'accept-ranges': 'bytes',
            ...(range ? {
              'content-range': `bytes ${chunk.offset}-${chunk.offset + Math.max(0, chunk.bytes.byteLength - 1)}/${chunk.totalBytes}`
            } : {})
          })
          response.end(Buffer.from(chunk.bytes))
          return
        }
        if (request.method === 'PUT') {
          const bytes = new Uint8Array(bodyBuffer)
          const ack = this.store.putBlob(syncSpaceId, {
            hash: segments[4],
            offset: Number(request.headers['x-sync-offset'] ?? 0),
            totalBytes: Number(request.headers['x-sync-total-bytes'] ?? bytes.length),
            bytes,
            isFinal: String(request.headers['x-sync-final'] ?? 'false') === 'true',
            restart: String(request.headers['x-sync-restart'] ?? 'false') === 'true'
          })
          return ack ? this.sendJson(response, 200, ack) : this.sendJson(response, 204, null)
        }
      }
      throw new SyncServerError(404, 'NOT_FOUND', 'Unknown Sync endpoint')
    } catch (error) {
      const serverError = error instanceof SyncServerError ? error : new SyncServerError(400, 'INVALID_REQUEST', error instanceof Error ? error.message : String(error))
      this.sendJson(response, serverError.status, { error: serverError.code, message: serverError.message })
    }
  }

  private async handleMember(request: IncomingMessage, response: ServerResponse, syncSpaceId: string, deviceId: string): Promise<void> {
    this.requireAdmin(request)
    if (request.method === 'PUT') {
      const bodyBuffer = await readBody(request, MAX_ADMIN_BODY_BYTES)
      const body = parseJson(bodyBuffer)
      const requestedStatus = body.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE'
      const ledger = this.store.authLedger(syncSpaceId)
      if (ledger.objects.length > 0) {
        const authorized = computeActiveGrant(ledger.objects, deviceId) != null
        const ledgerStatus = authorized ? 'ACTIVE' : 'REVOKED'
        if (requestedStatus !== ledgerStatus) {
          throw new SyncServerError(
            403,
            'AUTH_BYPASS_FORBIDDEN',
            'Member status is governed by the signed AUTH ledger; append a signed grant/revoke instead of overriding it administratively'
          )
        }
      }
      this.store.registerMember({
        syncSpaceId,
        deviceId,
        publicKeySpkiBase64: String(body.publicKeySpkiBase64 ?? ''),
        status: requestedStatus,
        authEpoch: Number(body.authEpoch ?? 0)
      })
      return this.sendJson(response, 204, null)
    }
    if (request.method === 'DELETE') {
      const ledger = this.store.authLedger(syncSpaceId)
      if (ledger.objects.length > 0 && computeActiveGrant(ledger.objects, deviceId)) {
        throw new SyncServerError(
          403,
          'AUTH_BYPASS_FORBIDDEN',
          'Active signed authorization must be revoked by a MEMBER_REVOKE AUTH object before deleting the member'
        )
      }
      this.store.revokeMember(syncSpaceId, deviceId, Number(request.headers['x-sync-auth-epoch'] ?? 0))
      return this.sendJson(response, 204, null)
    }
    throw new SyncServerError(405, 'METHOD_NOT_ALLOWED', 'Member endpoint only supports PUT/DELETE')
  }

  private requireAdmin(request: IncomingMessage): void {
    const configured = this.options.adminToken ?? ''
    if (!configured || request.headers.authorization !== `Bearer ${configured}`) {
      throw new SyncServerError(403, 'ADMIN_REQUIRED', 'Server administrator authorization required')
    }
  }

  /**
   * 检验成员有效性、时间窗口偏差、Nonce 重放与数字签名（防冒名闭环）。
   */
  private requireMember(request: IncomingMessage, syncSpaceId: string, targetPath: string, bodyBuffer: Buffer): void {
    const deviceId = this.deviceId(request)
    const member = this.store.findMember(syncSpaceId, deviceId)
    if (!member || member.status === 'REVOKED') {
      throw new SyncServerError(403, 'AUTH_FAILED', 'Registered active device authorization required')
    }
    const history = this.store.authLedger(syncSpaceId).objects
    if (history.length && !computeActiveGrant(history, deviceId)) throw new SyncServerError(403, 'AUTH_FAILED', 'Device has no current signed authorization')

    // 检查时间戳偏差
    const rawTimestamp = request.headers[HEADER_TIMESTAMP]
    if (typeof rawTimestamp !== 'string' || !rawTimestamp.trim()) {
      throw new SyncServerError(401, 'AUTH_FAILED', `${HEADER_TIMESTAMP} header is required`)
    }
    const timestamp = Number(rawTimestamp)
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
      throw new SyncServerError(401, 'REQUEST_EXPIRED', 'Request timestamp is outside the allowed window')
    }

    // 检查 Nonce 防重放
    const nonce = request.headers[HEADER_NONCE]
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) {
      throw new SyncServerError(401, 'AUTH_FAILED', `Invalid or missing ${HEADER_NONCE} header`)
    }

    // 检查数字签名
    const signature = request.headers[HEADER_SIGNATURE]
    if (typeof signature !== 'string' || !signature.trim()) {
      throw new SyncServerError(401, 'AUTH_FAILED', `${HEADER_SIGNATURE} header is required`)
    }
    const bodySha256 = sha256Hex(bodyBuffer)
    const material = canonicalSigningMaterial(
      request.method ?? 'GET',
      targetPath,
      rawTimestamp,
      nonce,
      bodySha256
    )

    const verified = verifySignatureBase64(member.publicKeySpkiBase64, material, signature.trim())
    if (!verified) {
      throw new SyncServerError(401, 'INVALID_SIGNATURE', 'Request signature verification failed')
    }
    if (!this.nonceCache.checkAndRecord(`${syncSpaceId}\0${deviceId}\0${nonce}`)) {
      throw new SyncServerError(401, 'REPLAY_DETECTED', 'Request nonce has already been used')
    }
  }

  private deviceId(request: IncomingMessage): string {
    const value = request.headers[HEADER_DEVICE_ID]
    if (typeof value !== 'string' || !value.trim()) {
      throw new SyncServerError(401, 'AUTH_FAILED', `${HEADER_DEVICE_ID} is required`)
    }
    return value.trim()
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    if (status === 204) {
      response.writeHead(204).end()
      return
    }
    const payload = JSON.stringify(value)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload)
    })
    response.end(payload)
  }
}

function verifySignatureBase64(publicKeySpkiBase64: string, material: string, signatureBase64: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return cryptoVerify(
      'sha256',
      Buffer.from(material, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64')
    )
  } catch {
    return false
  }
}

async function readBody(request: IncomingMessage, maxBytes = MAX_DEFAULT_BODY_BYTES): Promise<Buffer> {
  const declaredLength = request.headers['content-length']
  if (typeof declaredLength === 'string') {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new SyncServerError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large for this Sync route')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new SyncServerError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function requestBodyLimit(method: string, pathname: string): number {
  if ((method === 'PUT' || method === 'POST') && /^\/v1\/spaces\/[^/]+\/blobs\/[^/]+$/.test(pathname)) {
    return MAX_BLOB_CHUNK_BODY_BYTES
  }
  if (method === 'PUT' && /^\/v1\/spaces\/[^/]+\/snapshots\/[^/]+$/.test(pathname)) {
    return MAX_SNAPSHOT_BODY_BYTES
  }
  return MAX_DEFAULT_BODY_BYTES
}

function parseJson(bodyBuffer: Buffer): Record<string, unknown> {
  if (bodyBuffer.length === 0) return {}
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object expected')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new SyncServerError(400, 'INVALID_JSON', error instanceof Error ? error.message : 'Invalid JSON')
  }
}

function parseRanges(value: string | null): SyncRange[] {
  if (!value) return []
  try {
    const ranges = JSON.parse(value) as unknown
    if (!Array.isArray(ranges)) throw new Error('ranges must be an array')
    return ranges as SyncRange[]
  } catch (error) {
    throw new SyncServerError(400, 'INVALID_RANGE', error instanceof Error ? error.message : 'Invalid ranges')
  }
}

function parseCursor(value: string | null): SyncCursor | null {
  if (!value) return null
  try { return JSON.parse(value) as SyncCursor } catch { throw new SyncServerError(400, 'CURSOR_REWIND', 'Invalid cursor') }
}

function parseByteRange(value: string | undefined): { offset: number; length?: number } | null {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(value)
  if (!match) throw new SyncServerError(416, 'INVALID_RANGE', 'Invalid Blob Range')
  const offset = Number(match[1])
  const end = match[2] ? Number(match[2]) : undefined
  if (!Number.isSafeInteger(offset) || offset < 0 ||
    (end != null && (!Number.isSafeInteger(end) || end < offset))) {
    throw new SyncServerError(416, 'INVALID_RANGE', 'Invalid Blob Range')
  }
  return { offset, length: end == null ? undefined : end - offset + 1 }
}
