import { randomUUID } from 'node:crypto'
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, canonicalSigningMaterial, sha256Hex } from './sync-http-auth'
import { SYNC_COMPATIBILITY_VERSION } from '../../shared/sync-protocol'
import { SYNC_COMPATIBILITY_HEADER } from './sync-compatibility'

export interface SyncHttpEndpointOptions {
  baseUrl: string
  syncSpaceId: string
  deviceId: string
  accessToken?: string
  timeoutMs?: number
  signer?: (material: string) => string
  peerPublicKeySpkiBase64?: string
  localBindAddress?: string
  /** LAN 关闭、挂起和换网时取消当前自动同步轮次及正在消费的响应。 */
  signal?: AbortSignal
  /** 每次请求发送前核验当前成员权限，撤销后不能继续使用已经建立的 TLS 会话。 */
  authorizeRequest?: () => void
}

/** 把原始正文摘要绑定到签名，同时供接收端在分配正文内存前鉴权。 */
export function syncRequestHeaders(options: SyncHttpEndpointOptions, request: { path: string; init: RequestInit }): Headers {
  const { init, path } = request
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  headers.set('x-sync-device-id', options.deviceId)
  headers.set(SYNC_COMPATIBILITY_HEADER, String(SYNC_COMPATIBILITY_VERSION))
  if (options.accessToken) headers.set('authorization', `Bearer ${options.accessToken}`)
  if (!options.signer) return headers
  const body = init.body
  if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
    throw new Error('Signed Sync requests require a string or byte buffer body')
  }
  const bytes = body instanceof ArrayBuffer ? Buffer.from(body) : body instanceof Uint8Array ? Buffer.from(body) : body ?? ''
  const timestamp = String(Date.now())
  const nonce = randomUUID()
  const digest = sha256Hex(bytes)
  const material = canonicalSigningMaterial((init.method ?? 'GET').toUpperCase(), path, timestamp, nonce, digest)
  headers.set(HEADER_TIMESTAMP, timestamp)
  headers.set('x-sync-body-sha256', digest)
  headers.set(HEADER_NONCE, nonce)
  headers.set(HEADER_SIGNATURE, options.signer(material))
  return headers
}
