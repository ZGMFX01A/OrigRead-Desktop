import { randomUUID } from 'node:crypto'
import type { SyncStateRepository, SyncTrustedDeviceRecord } from './sync-state-repository'
import { computeActiveGrant, type SyncRuntimeRepository } from './sync-runtime-repository'
import type { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import type { DesktopAuthLedgerService } from './sync-auth-ledger'
import {
  SYNC_PROTOCOL_VERSION,
  generateEphemeralKeyPair,
  signWithKey,
  verifyWithSpkiKey,
  computeSharedSecret,
  deriveSessionKey,
  formatSyncUrl,
  pairingStartInitiatorPayload,
  pairingStartResponderPayload,
  pairingConfirmPayload,
  pairingConfirmResponsePayload,
  pairingCancelPayload,
  syncSasCode,
  syncDeviceFingerprint,
  type PairingStartRequest,
  type PairingStartResponse,
  type PairingConfirmRequest,
  type PairingConfirmResponse,
  type PairingCancelRequest,
  type PublicPairingStatusDto,
  type SyncHandshakeHello,
  type SyncHandshakeTranscript
} from './sync-pairing'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { authObjectId, authSigningDigest, authSigningMaterial } from './sync-auth-wire'
import type { SyncAuthLedgerPage, SyncAuthProtocolObject } from '../../shared/sync-protocol'
import { SyncHttpEndpointSession } from './sync-http-session'
import { SyncLanPeerTlsClient } from './sync-lan-tls'

const MAX_CLOCK_SKEW_MS = 120_000
const SESSION_EXPIRY_MS = 180_000

export interface ActivePairingSession {
  sessionId: string
  syncSpaceId: string
  role: 'INITIATOR' | 'RESPONDER'
  remoteDeviceId: string
  remoteDisplayName: string
  remotePlatform: string
  remoteStaticPublicKey: string
  remoteFingerprint: string
  localFingerprint: string
  sasCode: string
  status: 'WAITING_CONFIRMATION' | 'WAITING_PEER' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'
  localConfirmed: boolean
  remoteConfirmed: boolean
  expiresAt: number
  remoteEndpoint?: { host: string; port: number; localBindAddress?: string }
  sessionKeyBase64?: string
  localEphemeralPrivateKeyPem?: string
  failureMessage?: string
  cancellationOrigin?: 'LOCAL' | 'PEER'
}

export type PairingSessionListener = (session: ActivePairingSession) => void

/**
 * 桌面端 Authenticated Interactive Pairing 协调器。
 *
 * 遵循 R11 规范与整改要求：
 * 1. 临时密钥对交换 + 静态身份密钥绑定；
 * 2. 真实 P-256 ECDH 计算共享密钥，并通过 HKDF-SHA256 派生安全会话密钥（B12, U03）；
 * 3. 完整 handshake transcript 计算 SAS 和双方设备指纹；
 * 4. 显式传递与使用真实监听端口（B07）；
 * 5. 空间加入与协商支持（B05, U02）；
 * 6. 发起方先确认与接收方后确认的双向收敛及防分叉处理（B06）；
 * 7. 终态不可逆与防重放校验（B13）；
 * 8. 会话超时严格检查（B27）；
 * 9. RFC 3986/6874 合规的 IPv6/IPv4 URL 格式化（B24）；
 * 10. 符合 R10 AUTH 规范的 MEMBER_GRANT 生成与签名，杜绝吞异常（B09）。
 */
export class DesktopPairingCoordinator {
  private readonly sessions = new Map<string, ActivePairingSession>()
  private readonly listeners = new Set<PairingSessionListener>()

  constructor(
    private readonly runtime: SyncRuntimeRepository,
    private readonly state: SyncStateRepository,
    private readonly keyStore: DesktopSyncDeviceSigningKeyStore,
    private readonly authLedger: DesktopAuthLedgerService,
    private readonly localAccountId: () => number,
    private readonly localListenerPort?: () => number,
    private readonly prepareJoinedSpaceIdentities?: (syncSpaceId: string, localAccountId: number, now: number) => void
  ) {}

  onSessionUpdated(listener: PairingSessionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(session: ActivePairingSession): void {
    for (const listener of this.listeners) {
      try { listener(session) } catch { /* ignore */ }
    }
  }

  listSessions(): ActivePairingSession[] {
    const now = Date.now()
    const active: ActivePairingSession[] = []
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now && (s.status === 'WAITING_CONFIRMATION' || s.status === 'WAITING_PEER')) {
        s.status = 'EXPIRED'
      }
      active.push(s)
    }
    return active
  }

  getSession(sessionId: string): ActivePairingSession | null {
    const session = this.sessions.get(sessionId) ?? null
    if (session && session.expiresAt <= Date.now() && (session.status === 'WAITING_CONFIRMATION' || session.status === 'WAITING_PEER')) {
      session.status = 'EXPIRED'
    }
    return session
  }

  /**
   * 仅返回用于外部查询的安全公开状态 DTO，杜绝私钥与会话密钥泄露 (B28)
   */
  getSessionPublicDto(sessionId: string): PublicPairingStatusDto | null {
    const session = this.getSession(sessionId)
    if (!session) return null
    return {
      sessionId: session.sessionId,
      syncSpaceId: session.syncSpaceId,
      role: session.role,
      status: session.status,
      peerDeviceId: session.remoteDeviceId,
      peerDisplayName: session.remoteDisplayName,
      peerPlatform: session.remotePlatform,
      sas: session.sasCode,
      initiatorFingerprint: session.role === 'INITIATOR' ? session.localFingerprint : session.remoteFingerprint,
      responderFingerprint: session.role === 'INITIATOR' ? session.remoteFingerprint : session.localFingerprint,
      expiresAt: session.expiresAt,
      isLocalConfirmed: session.localConfirmed,
      isPeerConfirmed: session.remoteConfirmed,
      targetHost: session.remoteEndpoint?.host ?? null,
      targetPort: session.remoteEndpoint?.port ?? null,

      // 兼容别名
      remoteDeviceId: session.remoteDeviceId,
      remoteDisplayName: session.remoteDisplayName,
      remotePlatform: session.remotePlatform,
      remoteFingerprint: session.remoteFingerprint,
      localFingerprint: session.localFingerprint,
      sasCode: session.sasCode,
      localConfirmed: session.localConfirmed,
      remoteConfirmed: session.remoteConfirmed
    }
  }

  /**
   * 处理对端（作为 Initiator）发起的配对握手请求。
   */
  handleStartRequest(request: PairingStartRequest, remoteHost: string, _remotePort: number): PairingStartResponse {
    if (request.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      throw new Error(`Protocol version mismatch: expected ${SYNC_PROTOCOL_VERSION}, got ${request.protocolVersion}`)
    }
    const now = Date.now()
    if (Math.abs(now - request.timestamp) > MAX_CLOCK_SKEW_MS) {
      throw new Error('Pairing request expired: clock skew too large')
    }

    // 端口修复（B07）：强制校验请求方显式声明的 listener 端口，杜绝回退 TCP 源临时端口
    if (!request.initiatorPort || request.initiatorPort <= 0 || request.initiatorPort > 65535) {
      throw new Error('Pairing request rejected: invalid or missing initiatorPort')
    }

    const localPort = this.localListenerPort ? this.localListenerPort() : 0
    if (!localPort || localPort <= 0) {
      throw new Error('Local LAN listener port is not ready for pairing')
    }

    const accountId = this.localAccountId()
    const binding = this.runtime.findBinding(accountId)
    const localDevice = this.runtime.findDeviceIdentity()
    if (!binding || !localDevice) {
      throw new Error('Local Sync Space or device identity is not initialized')
    }

    // 空间协商模式（B05, U02）：支持跨不同初始 Space 的加入
    let negotiatedSpaceId = binding.syncSpaceId
    if (request.syncSpaceId !== binding.syncSpaceId) {
      if (request.mode === 'JOIN_TARGET' || request.mode === 'MATCH_OR_JOIN' || !request.mode) {
        // 对端加入本机 Space
        negotiatedSpaceId = binding.syncSpaceId
      } else {
        throw new Error(`Sync Space mismatch: expected ${binding.syncSpaceId}, got ${request.syncSpaceId}`)
      }
    }

    // 验证 Initiator 签名（载荷必须包含 initiatorPort，B07）
    const initPayload = pairingStartInitiatorPayload(
      request.syncSpaceId,
      request.initiatorDeviceId,
      request.initiatorEphemeralPublicKey,
      request.nonce,
      request.timestamp,
      request.initiatorPort,
      request.mode ?? 'MATCH_OR_JOIN'
    )
    const valid = verifyWithSpkiKey(request.initiatorStaticPublicKey, initPayload, request.signature)
    if (!valid) {
      throw new Error('Initiator signature verification failed')
    }

    // 生成 Responder 临时密钥对与 Nonce
    const { publicKeySpkiBase64: responderEphemeralPub, privateKeyPem: responderEphemeralPriv } = generateEphemeralKeyPair()
    const responderNonce = randomUUID().replaceAll('-', '')
    const localStaticPublicKey = this.keyStore.publicKeySpkiBase64(localDevice.deviceId)

    // 构建完整 Handshake Transcript
    const initiatorHello: SyncHandshakeHello = {
      protocolVersion: request.protocolVersion,
      syncSpaceId: request.syncSpaceId,
      deviceId: request.initiatorDeviceId,
      ephemeralPublicKey: request.initiatorEphemeralPublicKey,
      nonce: request.nonce
    }
    const responderHello: SyncHandshakeHello = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncSpaceId: negotiatedSpaceId,
      deviceId: localDevice.deviceId,
      ephemeralPublicKey: responderEphemeralPub,
      nonce: responderNonce
    }
    const transcript: SyncHandshakeTranscript = {
      initiator: initiatorHello,
      responder: responderHello,
      staticIdentityKeys: [request.initiatorStaticPublicKey, localStaticPublicKey]
    }

    const sas = syncSasCode(transcript)
    const initFingerprint = syncDeviceFingerprint(request.initiatorStaticPublicKey)
    const respFingerprint = syncDeviceFingerprint(localStaticPublicKey)
    const sessionId = randomUUID()
    const expiresAt = now + SESSION_EXPIRY_MS

    // 真实 P-256 ECDH 共享秘密协商与 HKDF 会话密钥派生（统一使用统一 info 常量，B29）
    let sessionKeyBase64: string | undefined
    try {
      const sharedSecret = computeSharedSecret(responderEphemeralPriv, request.initiatorEphemeralPublicKey)
      const sessionKey = deriveSessionKey(
        sharedSecret,
        Buffer.from(sas, 'utf8')
      )
      sessionKeyBase64 = sessionKey.toString('base64')
    } catch (err) {
      console.warn('ECDH session key derivation failed:', err)
    }

    const session: ActivePairingSession = {
      sessionId,
      syncSpaceId: negotiatedSpaceId,
      role: 'RESPONDER',
      remoteDeviceId: request.initiatorDeviceId,
      remoteDisplayName: request.initiatorDisplayName,
      remotePlatform: request.initiatorPlatform,
      remoteStaticPublicKey: request.initiatorStaticPublicKey,
      remoteFingerprint: initFingerprint,
      localFingerprint: respFingerprint,
      sasCode: sas,
      status: 'WAITING_CONFIRMATION',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt,
      remoteEndpoint: { host: remoteHost, port: request.initiatorPort },
      sessionKeyBase64,
      localEphemeralPrivateKeyPem: responderEphemeralPriv
    }
    this.sessions.set(sessionId, session)
    this.notify(session)

    // Responder 签名响应 payload（包含真实 responderPort，B07）
    const respPayload = pairingStartResponderPayload(
      sessionId,
      negotiatedSpaceId,
      localDevice.deviceId,
      responderEphemeralPub,
      responderNonce,
      sas,
      localPort
    )
    const signature = this.keyStore.signBase64(localDevice.deviceId, respPayload.toString('utf8'))

    return {
      sessionId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncSpaceId: negotiatedSpaceId,
      responderDeviceId: localDevice.deviceId,
      responderDisplayName: `OrigRead-Desktop-${localDevice.deviceId.slice(0, 6)}`,
      responderPlatform: 'DESKTOP',
      responderEphemeralPublicKey: responderEphemeralPub,
      responderStaticPublicKey: localStaticPublicKey,
      responderPort: localPort,
      nonce: responderNonce,
      timestamp: now,
      sasCode: sas,
      initiatorFingerprint: initFingerprint,
      responderFingerprint: respFingerprint,
      expiresAt,
      signature
    }
  }

  /**
   * 处理对端发来的确认请求。
   */
  async handleConfirmRequest(request: PairingConfirmRequest): Promise<PairingConfirmResponse> {
    const session = this.sessions.get(request.sessionId)
    if (!session) {
      return { sessionId: request.sessionId, status: 'EXPIRED', message: 'Pairing session not found' }
    }

    const localDevice = this.runtime.findDeviceIdentity()
    const now = Date.now()

    // 终态不可逆与防重放校验（B13）
    if (session.status === 'CONFIRMED') {
      const respPayload = pairingConfirmResponsePayload(session.sessionId, 'CONFIRMED', now)
      const signature = localDevice ? this.keyStore.signBase64(localDevice.deviceId, respPayload.toString('utf8')) : undefined
      return { sessionId: session.sessionId, status: 'CONFIRMED', signature, timestamp: now }
    }
    if (session.status === 'REJECTED' || session.status === 'EXPIRED' || session.status === 'CANCELLED') {
      return { sessionId: session.sessionId, status: session.status, message: `Pairing session is ${session.status}` }
    }
    if (session.expiresAt <= now) {
      session.status = 'EXPIRED'
      this.notify(session)
      return { sessionId: session.sessionId, status: 'EXPIRED', message: 'Pairing session expired' }
    }

    if (request.syncSpaceId !== session.syncSpaceId || request.deviceId !== session.remoteDeviceId ||
      !Number.isFinite(request.timestamp) || Math.abs(now - request.timestamp) > MAX_CLOCK_SKEW_MS) {
      return { sessionId: session.sessionId, status: 'REJECTED', message: 'Pairing confirmation identity or timestamp is invalid' }
    }

    if (session.sasCode !== request.sasCode) {
      session.status = 'REJECTED'
      this.notify(session)
      return { sessionId: session.sessionId, status: 'REJECTED', message: 'SAS code mismatch' }
    }

    // 验签确认 payload
    const payload = pairingConfirmPayload(
      request.sessionId,
      request.syncSpaceId,
      request.deviceId,
      request.sasCode,
      request.confirmed,
      request.timestamp
    )
    const valid = verifyWithSpkiKey(session.remoteStaticPublicKey, payload, request.signature)
    if (!valid) {
      return { sessionId: session.sessionId, status: 'REJECTED', message: 'Confirm signature verification failed' }
    }

    if (!request.confirmed) {
      session.status = 'REJECTED'
      this.notify(session)
      return { sessionId: session.sessionId, status: 'REJECTED', message: 'Peer rejected pairing' }
    }

    if (session.localConfirmed) {
      try {
        await this.commitConfirmedSession(session.sessionId)

        const responseTimestamp = Date.now()
        const respPayload = pairingConfirmResponsePayload(session.sessionId, 'CONFIRMED', responseTimestamp)
        const signature = localDevice ? this.keyStore.signBase64(localDevice.deviceId, respPayload.toString('utf8')) : undefined
        return { sessionId: session.sessionId, status: 'CONFIRMED', signature, timestamp: responseTimestamp }
      } catch (error) {
        const latest = this.sessions.get(session.sessionId)
        if (latest && latest.status !== 'REJECTED' && latest.status !== 'EXPIRED' && latest.status !== 'CANCELLED' && latest.expiresAt > Date.now()) {
          latest.remoteConfirmed = true
          latest.status = 'WAITING_PEER'
          latest.failureMessage = error instanceof Error ? error.message : String(error)
          this.notify(latest)
        }
        throw error
      }
    }

    session.remoteConfirmed = true
    session.status = 'WAITING_CONFIRMATION'
    session.failureMessage = undefined
    this.notify(session)

    const responseTimestamp = Date.now()
    const respPayload = pairingConfirmResponsePayload(session.sessionId, 'WAITING_PEER', responseTimestamp)
    const signature = localDevice ? this.keyStore.signBase64(localDevice.deviceId, respPayload.toString('utf8')) : undefined
    return { sessionId: session.sessionId, status: 'WAITING_PEER', signature, timestamp: responseTimestamp }
  }

  /**
   * 处理对端取消请求。
   */
  handleCancelRequest(request: PairingCancelRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) {
      throw new Error('Pairing session not found')
    }
    // 强制安全校验（B13）：必须提供完整的认证参数并验签，杜绝未签名恶意取消
    if (!request.signature || !request.deviceId || !Number.isSafeInteger(request.timestamp) || !request.reason?.trim()) {
      throw new Error('AUTH_FAILED: Cancel request missing required authentication fields')
    }
    const now = Date.now()
    if (Math.abs(now - request.timestamp) > MAX_CLOCK_SKEW_MS) {
      throw new Error('AUTH_FAILED: Cancel request expired: clock skew too large')
    }
    if (request.deviceId !== session.remoteDeviceId) {
      throw new Error('AUTH_FAILED: Cancel request device mismatch')
    }
    const payload = pairingCancelPayload(request.sessionId, request.deviceId, request.reason, request.timestamp)
    const valid = verifyWithSpkiKey(session.remoteStaticPublicKey, payload, request.signature)
    if (!valid) {
      throw new Error('AUTH_FAILED: Invalid signature on cancel request')
    }
    // POST itself is not idempotent. The pairing state machine makes only an authenticated
    // repeat cancellation of this same session idempotent, so a lost 204 can be recovered.
    if (session.status === 'CANCELLED') return
    if (session.status === 'CONFIRMED' || session.status === 'REJECTED' || session.status === 'EXPIRED') {
      throw new Error(`PAIRING_TERMINAL: session is already ${session.status}`)
    }
    if (session.expiresAt <= now) {
      session.status = 'EXPIRED'
      this.notify(session)
      throw new Error('PAIRING_EXPIRED: session expired before cancellation')
    }
    session.status = 'CANCELLED'
    session.localConfirmed = false
    session.remoteConfirmed = false
    session.cancellationOrigin = 'PEER'
    session.failureMessage = `对端已取消配对（${request.reason}）`
    this.notify(session)
  }

  /**
   * 本机发起对局域网目标节点的配对握手。
   */
  async initiatePairing(
    targetHost: string,
    targetPort: number,
    mode: 'MATCH_OR_JOIN' | 'JOIN_TARGET' | 'MATCH_EXISTING' = 'MATCH_OR_JOIN',
    localBindAddress?: string
  ): Promise<ActivePairingSession> {
    const accountId = this.localAccountId()
    const binding = this.runtime.findBinding(accountId)
    const localDevice = this.runtime.findDeviceIdentity()
    if (!binding || !localDevice) {
      throw new Error('Local Sync Space or device identity is not initialized')
    }
    if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65_534) {
      throw new Error('LAN bootstrap port must be between 1 and 65534')
    }

    // 端口注入与前置就绪校验（B07）
    const localPort = this.localListenerPort ? this.localListenerPort() : 0
    if (!localPort || localPort <= 0) {
      throw new Error('Local LAN listener port is not ready for pairing')
    }

    const { publicKeySpkiBase64: initiatorEphemeralPub, privateKeyPem: initiatorEphemeralPriv } = generateEphemeralKeyPair()
    const initiatorNonce = randomUUID().replaceAll('-', '')
    const localStaticPublicKey = this.keyStore.publicKeySpkiBase64(localDevice.deviceId)
    const now = Date.now()

    const initPayload = pairingStartInitiatorPayload(
      binding.syncSpaceId,
      localDevice.deviceId,
      initiatorEphemeralPub,
      initiatorNonce,
      now,
      localPort,
      mode
    )
    const signature = this.keyStore.signBase64(localDevice.deviceId, initPayload.toString('utf8'))

    const startReq: PairingStartRequest = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncSpaceId: binding.syncSpaceId,
      initiatorDeviceId: localDevice.deviceId,
      initiatorDisplayName: `OrigRead-Desktop-${localDevice.deviceId.slice(0, 6)}`,
      initiatorPlatform: 'DESKTOP',
      initiatorEphemeralPublicKey: initiatorEphemeralPub,
      initiatorStaticPublicKey: localStaticPublicKey,
      initiatorPort: localPort,
      mode,
      nonce: initiatorNonce,
      timestamp: now,
      signature
    }

    // 使用 RFC 3986/6874 合规的 URL 格式化（B24）
    const startResult = await this.postPeerJson(
      targetHost,
      targetPort + 1,
      '/v1/pairing/start',
      startReq,
      undefined,
      undefined,
      localBindAddress
    )
    if (!startResult.ok) {
      throw new Error(`Pairing start failed (HTTP ${startResult.status}): ${startResult.body}`)
    }
    const startResp = JSON.parse(startResult.body) as PairingStartResponse
    if (
      startResp.responderDeviceId !== startResult.identity.deviceId ||
      startResp.responderStaticPublicKey !== startResult.identity.publicKeySpkiBase64
    ) {
      throw new Error('TLS bootstrap identity does not match the signed pairing responder identity')
    }

    // 验证 Responder 端口与签名（B07）
    if (!startResp.responderPort || startResp.responderPort <= 0 || startResp.responderPort > 65535) {
      throw new Error('Responder returned invalid or missing responderPort')
    }
    const respPayload = pairingStartResponderPayload(
      startResp.sessionId,
      startResp.syncSpaceId,
      startResp.responderDeviceId,
      startResp.responderEphemeralPublicKey,
      startResp.nonce,
      startResp.sasCode,
      startResp.responderPort
    )
    const valid = verifyWithSpkiKey(startResp.responderStaticPublicKey, respPayload, startResp.signature)
    if (!valid) {
      throw new Error('Responder signature verification failed during pairing')
    }

    // 本地复现 Transcript 计算 SAS 码并严格核对
    const transcript: SyncHandshakeTranscript = {
      initiator: {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        syncSpaceId: binding.syncSpaceId,
        deviceId: localDevice.deviceId,
        ephemeralPublicKey: initiatorEphemeralPub,
        nonce: initiatorNonce
      },
      responder: {
        protocolVersion: startResp.protocolVersion,
        syncSpaceId: startResp.syncSpaceId,
        deviceId: startResp.responderDeviceId,
        ephemeralPublicKey: startResp.responderEphemeralPublicKey,
        nonce: startResp.nonce
      },
      staticIdentityKeys: [localStaticPublicKey, startResp.responderStaticPublicKey]
    }

    const localSas = syncSasCode(transcript)
    if (localSas !== startResp.sasCode) {
      throw new Error(`SAS code mismatch! Potential MITM attack detected: expected ${localSas}, got ${startResp.sasCode}`)
    }

    // 真实 P-256 ECDH 共享密钥计算与 HKDF 会话密钥派生（统一使用统一 info 常量，B29）
    let sessionKeyBase64: string | undefined
    try {
      const sharedSecret = computeSharedSecret(initiatorEphemeralPriv, startResp.responderEphemeralPublicKey)
      const sessionKey = deriveSessionKey(
        sharedSecret,
        Buffer.from(localSas, 'utf8')
      )
      sessionKeyBase64 = sessionKey.toString('base64')
    } catch (err) {
      console.warn('Initiator ECDH derivation failed:', err)
    }

    // 协商目标 Space（B05）：若 Responder 声明了有效不同的 spaceId，以对端响应为准
    const targetSpaceId = startResp.syncSpaceId || binding.syncSpaceId

    const session: ActivePairingSession = {
      sessionId: startResp.sessionId,
      syncSpaceId: targetSpaceId,
      role: 'INITIATOR',
      remoteDeviceId: startResp.responderDeviceId,
      remoteDisplayName: startResp.responderDisplayName,
      remotePlatform: startResp.responderPlatform,
      remoteStaticPublicKey: startResp.responderStaticPublicKey,
      remoteFingerprint: startResp.responderFingerprint,
      localFingerprint: startResp.initiatorFingerprint,
      sasCode: localSas,
      status: 'WAITING_CONFIRMATION',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt: startResp.expiresAt,
      remoteEndpoint: { host: targetHost, port: startResp.responderPort, localBindAddress },
      sessionKeyBase64,
      localEphemeralPrivateKeyPem: initiatorEphemeralPriv
    }
    this.sessions.set(session.sessionId, session)
    this.notify(session)
    return session
  }

  /**
   * 本机用户点击确认一致。
   */
  async confirmSession(sessionId: string): Promise<ActivePairingSession> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Pairing session not found')

    // 会话超时严格检查（B27）
    if (session.expiresAt <= Date.now()) {
      session.status = 'EXPIRED'
      this.notify(session)
      throw new Error('Pairing session expired')
    }

    if (session.status !== 'WAITING_CONFIRMATION' && session.status !== 'WAITING_PEER') {
      return session
    }

    const localDevice = this.runtime.findDeviceIdentity()
    if (!localDevice) throw new Error('Device identity is not initialized')
    session.localConfirmed = true

    const now = Date.now()
    const confirmPayload = pairingConfirmPayload(
      session.sessionId,
      session.syncSpaceId,
      localDevice.deviceId,
      session.sasCode,
      true,
      now
    )
    const signature = this.keyStore.signBase64(localDevice.deviceId, confirmPayload.toString('utf8'))

    const confirmReq: PairingConfirmRequest = {
      sessionId: session.sessionId,
      syncSpaceId: session.syncSpaceId,
      deviceId: localDevice.deviceId,
      sasCode: session.sasCode,
      confirmed: true,
      timestamp: now,
      signature
    }

    let latest = this.sessions.get(session.sessionId)
    if (!latest || latest.status === 'CANCELLED' || latest.status === 'REJECTED' || latest.status === 'EXPIRED' ||
      !latest.localConfirmed || latest.expiresAt <= Date.now()) return latest ?? session

    if (latest.status === 'CONFIRMED') return latest

    // Both roles send the signed confirmation to the peer. The response, not an unsigned status DTO,
    // carries the peer's current confirmation result.
    if (latest.remoteEndpoint) {
      let result: { ok: boolean; status: number; body: string }
      try {
        result = await this.postPeerJson(
          latest.remoteEndpoint.host,
          latest.remoteEndpoint.port,
          '/v1/pairing/confirm',
          confirmReq,
          latest.remoteStaticPublicKey,
          latest.remoteDeviceId,
          latest.remoteEndpoint.localBindAddress
        )
      } catch (error) {
        const current = this.sessions.get(session.sessionId)
        if (current && current.status !== 'CANCELLED' && current.status !== 'REJECTED' && current.status !== 'EXPIRED') {
          current.failureMessage = error instanceof Error ? error.message : String(error)
          this.notify(current)
        }
        throw error
      }
      const responseBody = result.body
      if (!result.ok) {
        let message = `Pairing confirmation failed: HTTP ${result.status}`
        try { message = (JSON.parse(responseBody) as { message?: string }).message ?? message } catch { /* retain HTTP error */ }
        const current = this.sessions.get(session.sessionId)
        if (current && current.status !== 'CANCELLED' && current.status !== 'REJECTED' && current.status !== 'EXPIRED') {
          current.status = 'WAITING_PEER'
          current.failureMessage = message
          this.notify(current)
        }
        throw new Error(message)
      }
      const resp = JSON.parse(responseBody) as PairingConfirmResponse
      this.verifyConfirmResponse(latest, resp)
      latest = this.sessions.get(session.sessionId)
      if (!latest || latest.status === 'CANCELLED' || latest.status === 'REJECTED' || latest.status === 'EXPIRED' ||
        latest.status === 'CONFIRMED' || !latest.localConfirmed || latest.expiresAt <= Date.now()) return latest ?? session
      if (resp.status === 'CONFIRMED') {
        try {
          latest = await this.commitConfirmedSession(session.sessionId)
        } catch (error) {
          const current = this.sessions.get(session.sessionId)
          if (current && current.status !== 'CANCELLED' && current.status !== 'REJECTED' && current.status !== 'EXPIRED') {
            current.remoteConfirmed = true
            current.status = 'WAITING_PEER'
            current.failureMessage = error instanceof Error ? error.message : String(error)
            this.notify(current)
          }
          throw error
        }
      } else if (resp.status === 'WAITING_PEER') {
        latest.status = 'WAITING_PEER'
        latest.failureMessage = undefined
        this.pollPeerStatusUntilResolved(latest)
      } else if (resp.status === 'REJECTED') {
        latest.status = 'REJECTED'
      } else if (resp.status === 'EXPIRED') {
        latest.status = 'EXPIRED'
      }
    } else {
      session.failureMessage = 'Paired peer endpoint is unavailable; retry pairing while both devices are reachable'
      this.notify(session)
    }

    const finalSession = this.sessions.get(session.sessionId) ?? session
    this.notify(finalSession)
    return finalSession
  }

  private verifyConfirmResponse(session: ActivePairingSession, response: PairingConfirmResponse): void {
    if (response.sessionId !== session.sessionId) throw new Error('Pairing response session ID does not match')
    if (response.status !== 'CONFIRMED' && response.status !== 'WAITING_PEER') return
    const now = Date.now()
    if (!Number.isFinite(response.timestamp) || Math.abs(now - (response.timestamp ?? 0)) > MAX_CLOCK_SKEW_MS) {
      throw new Error('Pairing response timestamp is expired')
    }
    const payload = pairingConfirmResponsePayload(session.sessionId, response.status, response.timestamp!)
    if (!response.signature || !verifyWithSpkiKey(session.remoteStaticPublicKey, payload, response.signature)) {
      throw new Error('Pairing response signature verification failed')
    }
  }

  /**
   * 后台轮询对端配对状态，防止 Initiator 先确认时卡在 WAITING_PEER（B06）。
   * 修复 B36：在途请求响应返回后原子复核本地状态，若已取消或过期，严禁复活会话。
   */
  private pollPeerStatusUntilResolved(session: ActivePairingSession): void {
    if (!session.remoteEndpoint) return
    const endpoint = session.remoteEndpoint
    const sessionId = session.sessionId
    let requestInFlight = false

    const interval = setInterval(async () => {
      const current = this.sessions.get(sessionId)
      if (!current || current.status !== 'WAITING_PEER' || current.expiresAt <= Date.now()) {
        clearInterval(interval)
        if (current && current.expiresAt <= Date.now() && current.status === 'WAITING_PEER') {
          current.status = 'EXPIRED'
          this.notify(current)
        }
        return
      }
      if (requestInFlight) return
      requestInFlight = true

      try {
        const localDevice = this.runtime.findDeviceIdentity()
        if (!localDevice) throw new Error('Device identity is not initialized')
        const timestamp = Date.now()
        const payload = pairingConfirmPayload(sessionId, current.syncSpaceId, localDevice.deviceId, current.sasCode, true, timestamp)
        const request: PairingConfirmRequest = {
          sessionId,
          syncSpaceId: current.syncSpaceId,
          deviceId: localDevice.deviceId,
          sasCode: current.sasCode,
          confirmed: true,
          timestamp,
          signature: this.keyStore.signBase64(localDevice.deviceId, payload.toString('utf8'))
        }
        const result = await this.postPeerJson(
          endpoint.host,
          endpoint.port,
          '/v1/pairing/confirm',
          request,
          current.remoteStaticPublicKey,
          current.remoteDeviceId,
          endpoint.localBindAddress
        )
        const responseBody = result.body
        if (!result.ok) {
          let message = `Pairing confirmation retry failed: HTTP ${result.status}`
          try { message = (JSON.parse(responseBody) as { message?: string }).message ?? message } catch { /* retain HTTP error */ }
          throw new Error(message)
        }
        const response = JSON.parse(responseBody) as PairingConfirmResponse
        this.verifyConfirmResponse(current, response)

        // The response can arrive after a cancel/expiry. Re-read every state precondition before commit.
        const latest = this.sessions.get(sessionId)
        if (!latest || latest.status !== 'WAITING_PEER' || !latest.localConfirmed || latest.expiresAt <= Date.now()) {
          if (latest && latest.expiresAt <= Date.now() && latest.status === 'WAITING_PEER') {
            latest.status = 'EXPIRED'
            this.notify(latest)
          }
          clearInterval(interval)
          return
        }
        if (response.status === 'CONFIRMED') {
          try {
            await this.commitConfirmedSession(sessionId)
          } catch (error) {
            const currentSession = this.sessions.get(sessionId)
            if (currentSession && currentSession.status === 'WAITING_PEER') {
              currentSession.remoteConfirmed = true
              currentSession.failureMessage = error instanceof Error ? error.message : String(error)
              this.notify(currentSession)
            }
            return
          }
          clearInterval(interval)
        } else if (response.status === 'REJECTED' || response.status === 'EXPIRED') {
          latest.status = response.status
          latest.failureMessage = response.message
          this.notify(latest)
          clearInterval(interval)
        } else {
          latest.failureMessage = undefined
          this.notify(latest)
        }
      } catch (error) {
        const latest = this.sessions.get(sessionId)
        if (latest && latest.status === 'WAITING_PEER') {
          latest.failureMessage = error instanceof Error ? error.message : String(error)
          this.notify(latest)
        }
      } finally {
        requestInFlight = false
      }
    }, 1500)
  }

  /**
   * 本机用户点击取消/拒绝配对。
   */
  async cancelSession(sessionId: string, reason = 'USER_CANCELLED'): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.status === 'CONFIRMED') {
      throw new Error('PAIRING_TERMINAL: pairing already completed; revoke device authorization to remove access')
    }
    if (session.status === 'REJECTED' || session.status === 'EXPIRED' || session.status === 'CANCELLED') return
    session.status = 'CANCELLED'
    session.localConfirmed = false
    session.remoteConfirmed = false
    session.cancellationOrigin = 'LOCAL'
    session.failureMessage = undefined
    this.notify(session)

    if (!session.remoteEndpoint) {
      session.failureMessage = '本机已取消配对，但缺少对端地址，未能发送取消通知'
      this.notify(session)
      throw new Error(session.failureMessage)
    }
    {
      const localDevice = this.runtime.findDeviceIdentity()
      if (!localDevice) throw new Error('AUTH_FAILED: local Sync Device identity is missing')
      const now = Date.now()
      const payload = pairingCancelPayload(sessionId, localDevice.deviceId, reason, now)
      const cancelReq: PairingCancelRequest = {
        sessionId,
        reason,
        deviceId: localDevice.deviceId,
        timestamp: now,
        signature: this.keyStore.signBase64(localDevice.deviceId, payload.toString('utf8'))
      }
      let response: { ok: boolean; status: number; body: string }
      try {
        response = await this.postPeerJson(
          session.remoteEndpoint.host,
          session.remoteEndpoint.port,
          '/v1/pairing/cancel',
          cancelReq,
          session.remoteStaticPublicKey,
          session.remoteDeviceId,
          session.remoteEndpoint.localBindAddress
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        session.failureMessage = `This device stopped pairing, but the peer could not confirm cancellation: ${detail}`
        this.notify(session)
        throw new Error(session.failureMessage)
      }
      if (!response.ok) {
        let message = `Peer cancellation failed: HTTP ${response.status}`
        try { message = (JSON.parse(response.body) as { message?: string }).message ?? message } catch { /* retain HTTP error */ }
        session.failureMessage = `This device stopped pairing, but the peer could not confirm cancellation: ${message}`
        this.notify(session)
        throw new Error(session.failureMessage)
      }
    }
  }

  /**
   * 配对成功后的持久化收口：
   * 1. 空间切换支持（B05, U02）：若加入对端空间，原子更新 local space binding 并确保创建本地目标空间 actor；
   * 2. 若当前设备是 OWNER，先签发并落库合规 MEMBER_GRANT（B09），授权失败严禁残留 Trust；
   * 3. 写入 sync_trusted_device 表并注册 peer；
   * 4. 自动添加/启用 LAN 端点（使用合规 URL，B24）。
   */
  private commitDurableTrust(session: ActivePairingSession, remoteAuthObjects: SyncAuthProtocolObject[] = []): void {
    const executeCommit = (): void => {
      const now = Date.now()
      const accountId = this.localAccountId()
      const binding = this.runtime.findBinding(accountId)
      const localDevice = this.runtime.findDeviceIdentity()
      if (!binding) throw new Error('No active Sync Space binding is available for pairing')
      if (!localDevice) throw new Error('Sync Device Identity is not initialized')

      // The pairing-confirmed peer key is a one-transaction bootstrap pin, not a grant. Register it
      // only inside the outer savepoint so any AUTH failure rolls it back with every pairing write.
      if (remoteAuthObjects.length > 0) {
        this.validateRemoteAuthPage(session, remoteAuthObjects)
        const existingHistory = this.runtime.listAuthObjects(session.syncSpaceId)
        if (!existingHistory.some((object) => object.objectType === 'SPACE_ROOT')) {
          const root = remoteAuthObjects.find((object) => object.objectType === 'SPACE_ROOT')!
          const rootPayload = JSON.parse(root.payloadJson) as Record<string, unknown>
          const rootKey = rootPayload.ownerPublicKeySpkiBase64 ?? rootPayload.publicKeySpkiBase64
          if (root.authorDeviceId !== session.remoteDeviceId || root.ownerDeviceId !== session.remoteDeviceId ||
            rootKey !== session.remoteStaticPublicKey) {
            throw new Error('AUTH_BOOTSTRAP_FAILED: a new Space must be joined through its current owner device')
          }
        }
        this.state.registerPeer({
          syncSpaceId: session.syncSpaceId,
          deviceId: session.remoteDeviceId,
          publicKeySpkiBase64: session.remoteStaticPublicKey,
          status: 'ACTIVE',
          authEpoch: remoteAuthObjects[0]?.authEpoch ?? 0,
          updatedAt: now
        })
        this.authLedger.append(session.syncSpaceId, remoteAuthObjects, now)
      }

      // 空间加入协商（B05, U02, C06）：若目标空间与本地当前绑定的空间不同，则切换至目标空间并初始化 Actor
      if (session.syncSpaceId !== binding.syncSpaceId) {
        // Leaving a Space invalidates any previous local-state bootstrap marker. If this account
        // later rejoins a Space, changes made while detached/bound elsewhere must be re-emitted.
        this.runtime.clearSpaceJoinBootstrap(accountId)
        this.prepareJoinedSpaceIdentities?.(session.syncSpaceId, accountId, now)
        this.runtime.upsertBinding({
          localAccountId: accountId,
          syncSpaceId: session.syncSpaceId,
          lifecycleState: 'ACTIVE',
          genesisSessionId: binding.genesisSessionId,
          createdAt: binding.createdAt,
          updatedAt: now
        })

      }

      // Ensure the target Space has an active local actor even when the binding already matched.
      const targetActor = this.runtime.findActiveActor(session.syncSpaceId)
      if (!targetActor) {
        this.runtime.insertActor({
          actorIncarnationId: randomUUID(),
          syncSpaceId: session.syncSpaceId,
          deviceId: localDevice.deviceId,
          status: 'ACTIVE',
          createdAt: now,
          retiredAt: null
        })
      }

      // 检查当前设备在 Space 中是否为 OWNER，并签发符合规范的 MEMBER_GRANT（B09, C07）
      // 强制事务原子性：授权必须在写入 Trust 之前成功，若抛错则整个 commit 失败，不残留假信任
      this.ensureOwnerMembershipGrant(session.syncSpaceId, session.remoteDeviceId, session.remoteStaticPublicKey)

      const trustedRecord: SyncTrustedDeviceRecord = {
        id: `${session.syncSpaceId}:${session.remoteDeviceId}`,
        syncSpaceId: session.syncSpaceId,
        deviceId: session.remoteDeviceId,
        staticPublicKey: session.remoteStaticPublicKey,
        fingerprint: session.remoteFingerprint,
        displayName: session.remoteDisplayName,
        platform: session.remotePlatform,
        trustState: 'TRUSTED',
        pairedAt: now,
        lastSeenAt: now,
        authEpoch: 0
      }
      this.state.upsertTrustedDevice(trustedRecord)
      this.state.registerPeer({
        syncSpaceId: session.syncSpaceId,
        deviceId: session.remoteDeviceId,
        publicKeySpkiBase64: session.remoteStaticPublicKey,
        status: 'ACTIVE',
        authEpoch: 0,
        updatedAt: now
      })

      // 自动添加或更新该设备的 LAN 端点配置（RFC 3986/6874 IPv6 安全 URL，B24）
      if (session.remoteEndpoint) {
        const endpointId = `lan:${session.remoteDeviceId}`
        const endpointUrl = formatSyncUrl(session.remoteEndpoint.host, session.remoteEndpoint.port)
        const existingEndpoint = this.state.findEndpoint(endpointId)
        this.state.upsertEndpoint({
          endpointId,
          syncSpaceId: session.syncSpaceId,
          kind: 'LAN',
          url: endpointUrl,
          displayName: session.remoteDisplayName,
          enabled: true,
          localBindAddress: session.remoteEndpoint.localBindAddress ?? null,
          createdAt: existingEndpoint?.createdAt ?? now,
          updatedAt: now,
          lastError: null
        })
      }
    }

    try {
      // Uses the same DatabaseSync connection as AUTH and state repositories. Releasing this
      // outermost SAVEPOINT is the durable commit; nested AUTH savepoints still roll back with it.
      this.runtime.transaction(executeCommit)
    } catch (err) {
      console.error('[DesktopPairingCoordinator] commitDurableTrust failed, rolled back:', err)
      throw err
    }
  }

  private async commitConfirmedSession(sessionId: string): Promise<ActivePairingSession> {
    const initial = this.sessions.get(sessionId)
    if (!initial) throw new Error('Pairing session not found')
    if (initial.status === 'CONFIRMED') return initial
    if (initial.status === 'CANCELLED' || initial.status === 'REJECTED' || initial.status === 'EXPIRED') {
      throw new Error(`Pairing session is ${initial.status}`)
    }
    if (initial.expiresAt <= Date.now()) {
      initial.status = 'EXPIRED'
      this.notify(initial)
      throw new Error('Pairing session expired before durable authorization completed')
    }
    if (!initial.localConfirmed) throw new Error('Local user confirmation is required before durable authorization')

    const remoteAuthObjects = this.isLocalOwner(initial.syncSpaceId)
      ? []
      : await this.fetchRemoteAuthLedger(initial)

    const latest = this.sessions.get(sessionId)
    if (!latest || latest !== initial || latest.status === 'CANCELLED' || latest.status === 'REJECTED' || latest.status === 'EXPIRED') {
      throw new Error('Pairing session was cancelled or ended before durable authorization completed')
    }
    if (latest.expiresAt <= Date.now()) {
      latest.status = 'EXPIRED'
      this.notify(latest)
      throw new Error('Pairing session expired before durable authorization completed')
    }
    if (!latest.localConfirmed) throw new Error('Local user confirmation was withdrawn before durable authorization completed')

    const confirmed: ActivePairingSession = {
      ...latest,
      remoteConfirmed: true,
      status: 'CONFIRMED',
      failureMessage: undefined
    }
    this.commitDurableTrust(confirmed, remoteAuthObjects)
    Object.assign(latest, confirmed)
    this.notify(latest)
    return latest
  }

  private isLocalOwner(syncSpaceId: string): boolean {
    const device = this.runtime.findDeviceIdentity()
    if (!device) return false
    const history = this.runtime.listAuthObjects(syncSpaceId)
    const head = history.at(-1)
    return Boolean(head && head.ownerDeviceId === device.deviceId && computeActiveGrant(history, device.deviceId)?.isOwner)
  }

  private async fetchRemoteAuthLedger(session: ActivePairingSession): Promise<SyncAuthProtocolObject[]> {
    if (!session.remoteEndpoint) throw new Error('AUTH_FETCH_FAILED: paired peer endpoint is unavailable')
    const localDevice = this.runtime.findDeviceIdentity()
    if (!localDevice) throw new Error('AUTH_FAILED: local Sync Device identity is missing')
    const endpoint = new SyncHttpEndpointSession({
      baseUrl: formatSyncUrl(session.remoteEndpoint.host, session.remoteEndpoint.port),
      syncSpaceId: session.syncSpaceId,
      deviceId: localDevice.deviceId,
      signer: (material) => this.keyStore.signBase64(localDevice.deviceId, material),
      peerPublicKeySpkiBase64: session.remoteStaticPublicKey,
      localBindAddress: session.remoteEndpoint.localBindAddress,
      timeoutMs: 15_000
    })
    try {
      const page = await endpoint.getAuthLedger()
      this.validateRemoteAuthPage(session, page.objects, page)
      return page.objects
    } finally {
      await endpoint.close()
    }
  }

  private async postPeerJson<TRequest extends object>(
    host: string,
    port: number,
    path: string,
    payload: TRequest,
    expectedPublicKeySpkiBase64?: string,
    expectedDeviceId?: string,
    localBindAddress?: string
  ): Promise<{ identity: SyncLanPeerTlsClient['identity']; ok: boolean; status: number; body: string }> {
    const baseUrl = formatSyncUrl(host, port)
    const peer = await SyncLanPeerTlsClient.connect(
      baseUrl,
      expectedPublicKeySpkiBase64,
      expectedDeviceId,
      5_000,
      localBindAddress
    )
    try {
      const response = await peer.fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
      return {
        identity: peer.identity,
        ok: response.ok,
        status: response.status,
        body: await response.text()
      }
    } finally {
      peer.close()
    }
  }

  private validateRemoteAuthPage(
    session: ActivePairingSession,
    objects: SyncAuthProtocolObject[],
    page?: SyncAuthLedgerPage
  ): void {
    if (!Array.isArray(objects) || objects.length === 0) {
      throw new Error('AUTH_FETCH_FAILED: peer returned no Space authorization history')
    }
    if (objects.some((object) => !object || object.syncSpaceId !== session.syncSpaceId)) {
      throw new Error('AUTH_SPACE_MISMATCH: peer returned authorization for another Space')
    }
    const history = [...objects].sort((a, b) => a.authEpoch - b.authEpoch || (a.authSequence ?? 0) - (b.authSequence ?? 0))
    const root = history[0]!
    const head = history.at(-1)!
    if (root.objectType !== 'SPACE_ROOT') throw new Error('AUTH_FETCH_FAILED: peer history does not begin with SPACE_ROOT')
    if (page && (page.authEpoch !== head.authEpoch || page.ownerDeviceId !== head.ownerDeviceId)) {
      throw new Error('AUTH_FETCH_FAILED: peer metadata does not match its signed authorization history')
    }
    const existingHistory = this.runtime.listAuthObjects(session.syncSpaceId)
    if (!existingHistory.some((object) => object.objectType === 'SPACE_ROOT')) {
      const rootPayload = JSON.parse(root.payloadJson) as Record<string, unknown>
      const rootKey = rootPayload.ownerPublicKeySpkiBase64 ?? rootPayload.publicKeySpkiBase64
      if (root.authorDeviceId !== session.remoteDeviceId || root.ownerDeviceId !== session.remoteDeviceId ||
        rootKey !== session.remoteStaticPublicKey) {
        throw new Error('AUTH_BOOTSTRAP_FAILED: a new Space must be joined through its current owner device')
      }
    }
  }

  /**
   * 修复 B09, C07：遵循 R10 AUTH 规范生成 MEMBER_GRANT，比对公钥变更（重装/重新配对），严禁吞异常。
   */
  private ensureOwnerMembershipGrant(syncSpaceId: string, targetDeviceId: string, targetPublicKey: string): void {
    try {
      const history = this.runtime.listAuthObjects(syncSpaceId)
      const head = history.at(-1)
      if (!head || !history.some((object) => object.objectType === 'SPACE_ROOT')) {
        throw new Error('OWNER_APPROVAL_REQUIRED: Sync Space has no verified AUTH root')
      }
      const localDevice = this.runtime.findDeviceIdentity()
      if (!localDevice) throw new Error('AUTH_FAILED: local Sync Device identity is missing')
      const localGrant = computeActiveGrant(history, localDevice.deviceId)
      if (!localGrant) throw new Error('AUTH_FAILED: this device is not currently authorized in the Sync Space')

      // Pairing consumes the current effective authorization for this exact device key. A stale grant,
      // revoked device, or grant for a prior installation key cannot authorize a replacement key.
      const targetGrant = computeActiveGrant(history, targetDeviceId)
      const targetGrantObject = targetGrant && history.find((object) => object.authObjectId === targetGrant.authGrantId)
      let targetGrantKey: string | null = null
      if (targetGrantObject) {
        try {
          const payload = JSON.parse(targetGrantObject.payloadJson) as Record<string, unknown>
          const key = payload.publicKeySpkiBase64 ?? payload.ownerPublicKeySpkiBase64
          if (typeof key === 'string') targetGrantKey = key
        } catch {
          targetGrantKey = null
        }
      }
      const targetAuthorizationMatchesDevice = targetGrantObject?.objectType === 'SPACE_ROOT'
        ? targetGrantObject.ownerDeviceId === targetDeviceId
        : targetGrantObject?.targetDeviceId === targetDeviceId
      if (targetGrant && targetAuthorizationMatchesDevice && targetGrantKey === targetPublicKey) return

      // A non-owner can pair only a target key that the current owner has already granted.
      if (!localGrant.isOwner || head.ownerDeviceId !== localDevice.deviceId) {
        throw new Error('OWNER_APPROVAL_REQUIRED: the Space owner must authorize this device key before pairing')
      }
      if (!targetDeviceId.trim() || !targetPublicKey.trim()) {
        throw new Error('AUTH_FAILED: pairing target identity is incomplete')
      }

      const payloadJson = canonicalJson(JSON.stringify({
        targetDeviceId,
        publicKeySpkiBase64: targetPublicKey
      }))
      const payloadHash = sha256Hex(payloadJson)
      const nextSequence = (head.authSequence ?? 0) + 1
      const objectId = authObjectId(syncSpaceId, head.authEpoch, 'MEMBER_GRANT', localDevice.deviceId, payloadHash, nextSequence)

      const unsignedGrant: SyncAuthProtocolObject = {
        protocolVersion: 1,
        authObjectId: objectId,
        syncSpaceId,
        authEpoch: head.authEpoch,
        authSequence: nextSequence,
        objectType: 'MEMBER_GRANT',
        authorDeviceId: localDevice.deviceId,
        ownerDeviceId: head.ownerDeviceId,
        targetDeviceId,
        previousEpochFinalAcceptedPrefixByActorLane: {},
        payloadJson,
        payloadHash,
        signingDigest: '',
        authorSignature: ''
      }

      // 签名素材严格使用 authSigningMaterial，签署生成 signingDigest 与 authorSignature
      const signingDigest = authSigningDigest(unsignedGrant)
      const authorSignature = this.keyStore.signBase64(localDevice.deviceId, authSigningMaterial(unsignedGrant))

      const signedGrant: SyncAuthProtocolObject = {
        ...unsignedGrant,
        signingDigest,
        authorSignature
      }

      this.authLedger.append(syncSpaceId, [signedGrant])
    } catch (err) {
      console.error(`[DesktopPairingCoordinator] Failed to issue MEMBER_GRANT for ${targetDeviceId}:`, err)
      throw err
    }
  }
}
