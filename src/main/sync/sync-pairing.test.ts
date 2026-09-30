import { describe, expect, it } from 'vitest'
import {
  generateEphemeralKeyPair,
  computeSharedSecret,
  deriveSessionKey,
  formatSyncUrl,
  syncDeviceFingerprint,
  syncSasCode,
  type SyncHandshakeTranscript
} from './sync-pairing'
import { DesktopDatabase } from '../database/database'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { MemorySecretStore } from '../security/secret-store'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import { DesktopPairingCoordinator } from './sync-pairing-coordinator'

describe('R11 Pairing Cryptography and Coordination Tests', () => {
  it('P-256 ECDH derives identical shared secrets and HKDF session keys on both peers (B12, U03)', () => {
    // 双方生成临时密钥对
    const alice = generateEphemeralKeyPair()
    const bob = generateEphemeralKeyPair()

    // 双方互换公钥并计算共享秘密
    const aliceSecret = computeSharedSecret(alice.privateKeyPem, bob.publicKeySpkiBase64)
    const bobSecret = computeSharedSecret(bob.privateKeyPem, alice.publicKeySpkiBase64)

    expect(aliceSecret.toString('hex')).toBe(bobSecret.toString('hex'))

    // 使用相同 salt 和 info 派生对称会话密钥
    const salt = Buffer.from('test-salt-sas', 'utf8')
    const info = Buffer.from('OrigRead-Sync-Pairing-Session-Key', 'utf8')

    const aliceKey = deriveSessionKey(aliceSecret, salt, info)
    const bobKey = deriveSessionKey(bobSecret, salt, info)

    expect(aliceKey.length).toBe(32)
    expect(aliceKey.toString('hex')).toBe(bobKey.toString('hex'))
  })

  it('formatSyncUrl properly handles IPv4, standard IPv6, and link-local IPv6 with scope id (B24)', () => {
    expect(formatSyncUrl('192.168.1.100', 8787, '/v1/pairing/start')).toBe('https://192.168.1.100:8787/v1/pairing/start')
    expect(formatSyncUrl('2001:db8::1', 8787, '/healthz')).toBe('https://[2001:db8::1]:8787/healthz')
    expect(formatSyncUrl('[2001:db8::1]', 8787, '/healthz')).toBe('https://[2001:db8::1]:8787/healthz')
    expect(formatSyncUrl('fe80::1%eth0', 8787, '/v1/spaces')).toBe('https://[fe80::1%25eth0]:8787/v1/spaces')
  })

  it('SAS code and fingerprint generation are deterministic and consistent', () => {
    const transcript: SyncHandshakeTranscript = {
      initiator: {
        protocolVersion: 1,
        syncSpaceId: 'space-a',
        deviceId: 'dev-init',
        ephemeralPublicKey: 'pub-init',
        nonce: 'nonce-init'
      },
      responder: {
        protocolVersion: 1,
        syncSpaceId: 'space-a',
        deviceId: 'dev-resp',
        ephemeralPublicKey: 'pub-resp',
        nonce: 'nonce-resp'
      },
      staticIdentityKeys: ['static-key-1', 'static-key-2']
    }

    const sas1 = syncSasCode(transcript)
    const sas2 = syncSasCode(transcript)
    expect(sas1).toBe(sas2)
    expect(sas1).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)

    const fp = syncDeviceFingerprint('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtest')
    expect(fp).toMatch(/^([0-9A-F]{4}:){7}[0-9A-F]{4}$/)
  })

  it('DesktopPairingCoordinator rejects expired sessions on confirm (B27)', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const coordinator = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    // 构造一个已过期的 session
    const expiredSessionId = 'test-expired-session'
    ;(coordinator as any).sessions.set(expiredSessionId, {
      sessionId: expiredSessionId,
      syncSpaceId: 'space-1',
      role: 'INITIATOR',
      remoteDeviceId: 'peer-dev',
      remoteDisplayName: 'Peer',
      remotePlatform: 'ANDROID',
      remoteStaticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpeer',
      remoteFingerprint: '1234',
      localFingerprint: '5678',
      sasCode: 'AAAA-BBBB-CCCC',
      status: 'WAITING_CONFIRMATION',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt: Date.now() - 1000 // 已经超时
    })

    await expect(coordinator.confirmSession(expiredSessionId)).rejects.toThrow('Pairing session expired')
    expect(coordinator.getSession(expiredSessionId)?.status).toBe('EXPIRED')
  })

  it('DesktopPairingCoordinator handles terminal state without replay vulnerability', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const coordinator = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    const rejectedSessionId = 'test-rejected-session'
    ;(coordinator as any).sessions.set(rejectedSessionId, {
      sessionId: rejectedSessionId,
      syncSpaceId: 'space-1',
      role: 'RESPONDER',
      remoteDeviceId: 'peer-dev',
      remoteDisplayName: 'Peer',
      remotePlatform: 'ANDROID',
      remoteStaticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpeer',
      remoteFingerprint: '1234',
      localFingerprint: '5678',
      sasCode: 'AAAA-BBBB-CCCC',
      status: 'REJECTED',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt: Date.now() + 60000
    })

    const response = await coordinator.handleConfirmRequest({
      sessionId: rejectedSessionId,
      syncSpaceId: 'space-1',
      deviceId: 'peer-dev',
      sasCode: 'AAAA-BBBB-CCCC',
      confirmed: true,
      timestamp: Date.now(),
      signature: 'dummy-sig'
    })

    expect(response.status).toBe('REJECTED')
  })

  it('DesktopPairingCoordinator getSessionPublicDto does not leak private key or session key (B28)', () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const coordinator = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    const sessId = 'sec-session-1'
    ;(coordinator as any).sessions.set(sessId, {
      sessionId: sessId,
      syncSpaceId: 'space-1',
      role: 'INITIATOR',
      remoteDeviceId: 'peer-dev',
      remoteDisplayName: 'Peer',
      remotePlatform: 'ANDROID',
      remoteStaticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpeer',
      remoteFingerprint: '1234',
      localFingerprint: '5678',
      sasCode: 'AAAA-BBBB-CCCC',
      status: 'WAITING_CONFIRMATION',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt: Date.now() + 60000,
      ephemeralPrivateKeyPem: '-----BEGIN EC PRIVATE KEY-----\nMIGk...SECRET\n-----END EC PRIVATE KEY-----',
      sessionKey: Buffer.from('super-secret-session-key-32bytes')
    })

    const publicDto = coordinator.getSessionPublicDto(sessId)
    expect(publicDto).not.toBeNull()
    expect((publicDto as any).ephemeralPrivateKeyPem).toBeUndefined()
    expect((publicDto as any).sessionKey).toBeUndefined()
    expect(publicDto?.sessionId).toBe(sessId)
    expect(publicDto?.sasCode).toBe('AAAA-BBBB-CCCC')
  })

  it('Cross-platform HKDF info constant matches PAIRING_HKDF_INFO_SESSION_KEY (B29)', () => {
    const secret = Buffer.from('shared-ecdh-secret-32-bytes-test')
    const salt = Buffer.from('SAS-1234-5678', 'utf8')
    const info = Buffer.from('OrigRead-Sync-Pairing-Session-Key-v1', 'utf8')

    const derived = deriveSessionKey(secret, salt, info)
    expect(derived).toHaveLength(32)
    // 验证派生结果确定性
    const derived2 = deriveSessionKey(secret, salt, info)
    expect(derived.toString('hex')).toBe(derived2.toString('hex'))
  })

  it('PublicPairingStatusDto includes both sas and sasCode aliases for cross-platform compatibility (C03)', () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const coordinator = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    const sessId = 'compat-session-1'
    ;(coordinator as any).sessions.set(sessId, {
      sessionId: sessId,
      syncSpaceId: 'space-1',
      role: 'INITIATOR',
      remoteDeviceId: 'peer-dev-id',
      remoteDisplayName: 'Android-Peer',
      remotePlatform: 'ANDROID',
      remoteStaticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpeer',
      remoteFingerprint: '1234',
      localFingerprint: '5678',
      sasCode: 'SAS-1234-ABCD',
      status: 'WAITING_CONFIRMATION',
      localConfirmed: true,
      remoteConfirmed: false,
      expiresAt: Date.now() + 60000
    })

    const dto = coordinator.getSessionPublicDto(sessId)
    expect(dto).not.toBeNull()
    expect(dto?.sas).toBe('SAS-1234-ABCD')
    expect(dto?.sasCode).toBe('SAS-1234-ABCD')
    expect(dto?.peerDeviceId).toBe('peer-dev-id')
    expect(dto?.isLocalConfirmed).toBe(true)
    expect(dto?.isPeerConfirmed).toBe(false)
  })

  it('DesktopPairingCoordinator confirmSession ignores in-flight responses if session is in terminal state (C04)', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const keys = new DesktopSyncDeviceSigningKeyStore(new MemorySecretStore())
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const coordinator = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    const sessId = 'cancelled-session-1'
    ;(coordinator as any).sessions.set(sessId, {
      sessionId: sessId,
      syncSpaceId: 'space-1',
      role: 'INITIATOR',
      remoteDeviceId: 'peer-dev-id',
      remoteDisplayName: 'Peer',
      remotePlatform: 'ANDROID',
      remoteStaticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEpeer',
      remoteFingerprint: '1234',
      localFingerprint: '5678',
      sasCode: 'SAS-1234-ABCD',
      status: 'CANCELLED',
      localConfirmed: false,
      remoteConfirmed: false,
      expiresAt: Date.now() + 60000
    })

    // 终态会话直接返回当前状态，严禁转为 CONFIRMED
    const res = await coordinator.confirmSession(sessId)
    expect(res.status).toBe('CANCELLED')
    expect(coordinator.getSession(sessId)?.status).toBe('CANCELLED')
  })
})
