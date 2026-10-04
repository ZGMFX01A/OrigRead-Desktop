import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, KeyObject } from 'node:crypto'

export const SYNC_PROTOCOL_VERSION = 1
export const PAIRING_HKDF_INFO = 'OrigRead-Sync-Pairing-Session-Key-v1'

export interface SyncHandshakeHello {
  protocolVersion: number
  syncSpaceId: string
  deviceId: string
  ephemeralPublicKey: string
  nonce: string
}

export interface SyncHandshakeTranscript {
  initiator: SyncHandshakeHello
  responder: SyncHandshakeHello
  staticIdentityKeys: string[]
}

export interface PairingStartRequest {
  protocolVersion: number
  syncSpaceId: string
  initiatorDeviceId: string
  initiatorDisplayName: string
  initiatorPlatform: string
  initiatorEphemeralPublicKey: string
  initiatorStaticPublicKey: string
  initiatorPort: number // 端口为强制绑定字段，不得为空或临时端口 (B07)
  mode?: 'MATCH_OR_JOIN' | 'JOIN_TARGET' | 'MATCH_EXISTING'
  nonce: string
  timestamp: number
  signature: string
}

export interface PairingStartResponse {
  sessionId: string
  protocolVersion: number
  syncSpaceId: string
  responderDeviceId: string
  responderDisplayName: string
  responderPlatform: string
  responderEphemeralPublicKey: string
  responderStaticPublicKey: string
  responderPort: number // 端口为强制绑定字段 (B07)
  nonce: string
  timestamp: number
  sasCode: string
  initiatorFingerprint: string
  responderFingerprint: string
  expiresAt: number
  signature: string
}

export interface PairingConfirmRequest {
  sessionId: string
  syncSpaceId: string
  deviceId: string
  sasCode: string
  confirmed: boolean
  timestamp: number
  signature: string
}

export interface PairingConfirmResponse {
  sessionId: string
  status: 'CONFIRMED' | 'WAITING_PEER' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'
  message?: string
  signature?: string
  timestamp?: number
}

export interface PairingCancelRequest {
  sessionId: string
  reason: string
  deviceId: string
  timestamp: number
  signature: string // 取消请求必须带有合法签名，禁止未签名取消 (B13)
}

/**
 * 专供外部公开查询的配对状态 DTO，杜绝私钥与会话秘钥泄露 (B28)
 */
export interface PublicPairingStatusDto {
  sessionId: string
  syncSpaceId: string
  role: 'INITIATOR' | 'RESPONDER'
  status: 'WAITING_CONFIRMATION' | 'WAITING_PEER' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'
  peerDeviceId: string
  peerDisplayName: string
  peerPlatform: string
  sas: string
  initiatorFingerprint: string
  responderFingerprint: string
  expiresAt: number
  isLocalConfirmed: boolean
  isPeerConfirmed: boolean
  targetHost?: string | null
  targetPort?: number | null
  failureMessage?: string
  cancellationOrigin?: 'LOCAL' | 'PEER'

  // 跨端双向兼容别名
  remoteDeviceId?: string
  remoteDisplayName?: string
  remotePlatform?: string
  remoteFingerprint?: string
  localFingerprint?: string
  sasCode?: string
  localConfirmed?: boolean
  remoteConfirmed?: boolean
}

export function generateEphemeralKeyPair(): { publicKeySpkiBase64: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  })
  const publicKeySpkiBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { publicKeySpkiBase64, privateKeyPem }
}

export function signWithKey(privateKeyPemOrDer: string | KeyObject, data: Buffer): string {
  const signature = sign('sha256', data, privateKeyPemOrDer)
  return signature.toString('base64')
}

export function verifyWithSpkiKey(publicKeySpkiBase64: string, data: Buffer, signatureBase64: string): boolean {
  try {
    const keyDer = Buffer.from(publicKeySpkiBase64, 'base64')
    const pubKey = createPublicKey({ key: keyDer, format: 'der', type: 'spki' })
    return verify('sha256', data, pubKey, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

export function computeSharedSecret(privateKeyPem: string, peerPublicKeySpkiBase64: string): Buffer {
  const privKey = createPrivateKey(privateKeyPem)
  const pubKey = createPublicKey({ key: Buffer.from(peerPublicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' })
  return diffieHellman({ privateKey: privKey, publicKey: pubKey })
}

/**
 * 遵循 RFC 5869 标准 HKDF-SHA256，双端采用统一固定常量 info (B29)
 */
export function deriveSessionKey(
  sharedSecret: Buffer,
  salt: Buffer,
  info: Buffer = Buffer.from(PAIRING_HKDF_INFO, 'utf8'),
  length = 32
): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, length))
}

export function formatSyncUrl(host: string, port: number, path = ''): string {
  let cleanHost = host.trim()
  if (cleanHost.includes(':') && !cleanHost.startsWith('[')) {
    cleanHost = `[${cleanHost.replaceAll('%', '%25')}]`
  }
  const cleanPath = path.startsWith('/') || path === '' ? path : `/${path}`
  return `https://${cleanHost}:${port}${cleanPath}`
}

export function pairingStartInitiatorPayload(
  syncSpaceId: string,
  deviceId: string,
  ephemeralKey: string,
  nonce: string,
  timestamp: number,
  initiatorPort: number,
  mode: 'MATCH_OR_JOIN' | 'JOIN_TARGET' | 'MATCH_EXISTING' = 'MATCH_OR_JOIN'
): Buffer {
  return Buffer.from(`${syncSpaceId}:${deviceId}:${ephemeralKey}:${nonce}:${timestamp}:${initiatorPort}:${mode}`, 'utf8')
}

export function pairingStartResponderPayload(
  sessionId: string,
  syncSpaceId: string,
  deviceId: string,
  ephemeralKey: string,
  nonce: string,
  sasCode: string,
  responderPort: number
): Buffer {
  return Buffer.from(`${sessionId}:${syncSpaceId}:${deviceId}:${ephemeralKey}:${nonce}:${sasCode}:${responderPort}`, 'utf8')
}

export function pairingConfirmPayload(
  sessionId: string,
  syncSpaceId: string,
  deviceId: string,
  sasCode: string,
  confirmed: boolean,
  timestamp: number
): Buffer {
  return Buffer.from(`${sessionId}:${syncSpaceId}:${deviceId}:${sasCode}:${confirmed}:${timestamp}`, 'utf8')
}

export function pairingConfirmResponsePayload(
  sessionId: string,
  status: string,
  timestamp: number
): Buffer {
  return Buffer.from(`${sessionId}:${status}:${timestamp}`, 'utf8')
}

export function pairingCancelPayload(
  sessionId: string,
  deviceId: string,
  reason: string,
  timestamp: number
): Buffer {
  return Buffer.from(`${sessionId}:${deviceId}:${reason}:${timestamp}`, 'utf8')
}

/** Pairing is interactive: discovery only supplies a candidate endpoint. */
export function syncHandshakeTranscriptHash(transcript: SyncHandshakeTranscript): string {
  const canonical = JSON.stringify({
    initiator: transcript.initiator,
    responder: transcript.responder,
    staticIdentityKeys: [...transcript.staticIdentityKeys].sort()
  })
  return createHash('sha256').update(`ORIGREAD_SYNC_HANDSHAKE_V1\n${canonical}`, 'utf8').digest('hex')
}

export function syncSasCode(transcript: SyncHandshakeTranscript): string {
  const digest = syncHandshakeTranscriptHash(transcript)
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`.toUpperCase()
}

export function syncDeviceFingerprint(staticIdentityKeySpkiBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(staticIdentityKeySpkiBase64, 'base64')).digest('hex')
  return digest.match(/.{1,4}/g)?.slice(0, 8).join(':').toUpperCase() ?? ''
}
