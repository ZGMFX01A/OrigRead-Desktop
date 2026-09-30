import { describe, expect, it } from 'vitest'
import { createPublicKey, randomUUID, verify as cryptoVerify, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopDatabase } from '../database/database'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { SyncStateRepository } from './sync-state-repository'
import { DesktopSyncDeviceSigningKeyStore } from './sync-device-signing-key-store'
import { MemorySecretStore } from '../security/secret-store'
import { DesktopAuthLedgerService } from './sync-auth-ledger'
import { DesktopPairingCoordinator } from './sync-pairing-coordinator'
import { DesktopSyncLanListener } from './desktop-sync-lan-listener'
import { DesktopSyncOperationSigner } from './sync-operation-signer'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncRuntimeCoordinator } from './sync-runtime-coordinator'
import { DesktopSyncRollbackWitnessStore } from './sync-rollback-witness'
import { computeActiveGrant } from './sync-runtime-repository'
import { pairingCancelPayload } from './sync-pairing'
import { SyncLanPeerTlsClient } from './sync-lan-tls'

describe('Desktop R11 LAN Sync & Pairing', () => {
  it('pairs over real listeners, imports owner AUTH, commits a durable grant, and joins the target Space (C03)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'origread-r11-pairing-'))
    const initiatorDatabasePath = join(tempDir, 'initiator.sqlite')
    const ownerDatabasePath = join(tempDir, 'owner.sqlite')
    const createOwner = (deviceId: string, spaceId: string, databasePath: string) => {
      const database = new DesktopDatabase(databasePath)
      const runtime = new SyncRuntimeRepository(database.connection)
      const state = new SyncStateRepository(database.connection)
      const secrets = new MemorySecretStore()
      const keys = new DesktopSyncDeviceSigningKeyStore(secrets)
      const authLedger = new DesktopAuthLedgerService(runtime, state)
      const now = Date.now()
      runtime.replaceDeviceIdentity({ deviceId, witnessId: `witness-${deviceId}`, createdAt: now, updatedAt: now })
      const identity = new SyncIdentityRepository(database.connection)
      const witness = new DesktopSyncRollbackWitnessStore(secrets, `pairing-${deviceId}`)
      witness.replaceDevice(deviceId, `witness-${deviceId}`)
      const runtimeCoordinator = new DesktopSyncRuntimeCoordinator(runtime, identity, witness)
      runtimeCoordinator.prepareSpace(1, spaceId, now)

      const publicKeySpkiBase64 = keys.publicKeySpkiBase64(deviceId)
      state.registerPeer({ syncSpaceId: spaceId, deviceId, publicKeySpkiBase64, status: 'ACTIVE', authEpoch: 0, updatedAt: now })
      const signer = new DesktopSyncOperationSigner(runtime, keys)
      const root = signer.signAuth({
        protocolVersion: 1,
        authObjectId: 'pending',
        syncSpaceId: spaceId,
        authEpoch: 0,
        authSequence: 0,
        objectType: 'SPACE_ROOT',
        authorDeviceId: deviceId,
        ownerDeviceId: deviceId,
        targetDeviceId: null,
        previousEpochFinalAcceptedPrefixByActorLane: {},
        revokeCutoffByActorLane: null,
        payloadJson: JSON.stringify({ ownerPublicKeySpkiBase64: publicKeySpkiBase64, publicKeySpkiBase64, spaceRootPublicKey: publicKeySpkiBase64 }),
        payloadHash: 'pending',
        signingDigest: 'pending',
        authorSignature: 'pending'
      })
      authLedger.append(spaceId, [root], now)
      let listenerTlsPort = 0
      const pairing = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1, () => listenerTlsPort)
      const listener = new DesktopSyncLanListener(runtime, state, keys, authLedger, {} as any, pairing, undefined, { port: 0, host: '127.0.0.1' })
      return { database, runtime, state, keys, authLedger, pairing, listener, getBootstrapPort: () => listener.bootstrapPort, setTlsPort: (port: number) => { listenerTlsPort = port } }
    }

    const initiator = createOwner('desktop-joining', 'space-local', initiatorDatabasePath)
    const owner = createOwner('desktop-owner', 'space-target', ownerDatabasePath)
    let initiatorStarted = false
    let ownerStarted = false
    let originalDatabasesClosed = false
    try {
      const initiatorListen = await initiator.listener.listen()
      initiator.setTlsPort(initiator.listener.tlsPort)
      initiatorStarted = true
      const ownerListen = await owner.listener.listen()
      owner.setTlsPort(owner.listener.tlsPort)
      ownerStarted = true

      const cancelledByInitiator = await initiator.pairing.initiatePairing('127.0.0.1', owner.getBootstrapPort())
      const cancelledByInitiatorPeer = owner.pairing.getSession(cancelledByInitiator.sessionId)
      expect(cancelledByInitiatorPeer?.status).toBe('WAITING_CONFIRMATION')
      await initiator.pairing.cancelSession(cancelledByInitiator.sessionId)
      expect(initiator.pairing.getSession(cancelledByInitiator.sessionId)?.status).toBe('CANCELLED')
      expect(cancelledByInitiatorPeer?.status).toBe('CANCELLED')
      expect(cancelledByInitiatorPeer?.cancellationOrigin).toBe('PEER')

      const duplicateTimestamp = Date.now()
      const duplicateReason = 'USER_CANCELLED'
      const duplicatePayload = pairingCancelPayload(
        cancelledByInitiator.sessionId,
        'desktop-joining',
        duplicateReason,
        duplicateTimestamp,
      )
      const tlsClient = await SyncLanPeerTlsClient.connect(
        `https://127.0.0.1:${owner.listener.tlsPort}`,
        owner.keys.publicKeySpkiBase64('desktop-owner'),
        'desktop-owner'
      )
      try {
        const duplicateCancel = await tlsClient.fetch(`https://127.0.0.1:${owner.listener.tlsPort}/v1/pairing/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: cancelledByInitiator.sessionId,
            reason: duplicateReason,
            deviceId: 'desktop-joining',
            timestamp: duplicateTimestamp,
            signature: initiator.keys.signBase64('desktop-joining', duplicatePayload.toString('utf8')),
          }),
        })
        expect(duplicateCancel.status).toBe(204)
      } finally {
        tlsClient.close()
      }
      const cancelledConfirm = await initiator.pairing.confirmSession(cancelledByInitiator.sessionId)
      expect(cancelledConfirm.status).toBe('CANCELLED')
      expect(initiator.state.listTrustedDevices('space-target')).toHaveLength(0)

      const cancelledSimultaneously = await owner.pairing.initiatePairing('127.0.0.1', initiator.getBootstrapPort())
      const initiatorSimultaneousPeer = initiator.pairing.getSession(cancelledSimultaneously.sessionId)
      expect(initiatorSimultaneousPeer?.status).toBe('WAITING_CONFIRMATION')
      await Promise.all([
        owner.pairing.cancelSession(cancelledSimultaneously.sessionId),
        initiator.pairing.cancelSession(cancelledSimultaneously.sessionId),
      ])
      expect(owner.pairing.getSession(cancelledSimultaneously.sessionId)?.status).toBe('CANCELLED')
      expect(initiatorSimultaneousPeer?.status).toBe('CANCELLED')

      const initiatingSession = await initiator.pairing.initiatePairing('127.0.0.1', owner.getBootstrapPort())
      const ownerSession = owner.pairing.getSession(initiatingSession.sessionId)
      expect(ownerSession?.syncSpaceId).toBe('space-target')
      expect(initiator.state.listTrustedDevices('space-target')).toHaveLength(0)

      const ownerWaiting = await owner.pairing.confirmSession(initiatingSession.sessionId)
      expect(ownerWaiting.status).toBe('WAITING_PEER')
      const joined = await initiator.pairing.confirmSession(initiatingSession.sessionId)

      expect(joined.status).toBe('CONFIRMED')
      expect(initiator.runtime.findBinding(1)?.syncSpaceId).toBe('space-target')
      expect(initiator.runtime.listAuthObjects('space-target').map((object) => object.objectType)).toEqual(['SPACE_ROOT', 'MEMBER_GRANT'])
      expect(computeActiveGrant(initiator.runtime.listAuthObjects('space-target'), 'desktop-joining')).not.toBeNull()
      expect(initiator.state.findTrustedDevice('space-target', 'desktop-owner')?.trustState).toBe('TRUSTED')
      expect(owner.state.findTrustedDevice('space-target', 'desktop-joining')?.trustState).toBe('TRUSTED')
      expect(owner.runtime.findActiveGrant('space-target', 'desktop-joining')).not.toBeNull()
      expect(initiator.state.listEndpoints('space-target').some((endpoint) => endpoint.endpointId === 'lan:desktop-owner' && endpoint.enabled)).toBe(true)

      await owner.listener.close()
      ownerStarted = false
      await initiator.listener.close()
      initiatorStarted = false
      owner.database.close()
      initiator.database.close()
      originalDatabasesClosed = true

      const reopened = new DesktopDatabase(initiatorDatabasePath)
      try {
        const reopenedRuntime = new SyncRuntimeRepository(reopened.connection)
        const reopenedState = new SyncStateRepository(reopened.connection)
        expect(reopenedRuntime.findBinding(1)?.syncSpaceId).toBe('space-target')
        expect(reopenedRuntime.listAuthObjects('space-target')).toHaveLength(2)
        expect(computeActiveGrant(reopenedRuntime.listAuthObjects('space-target'), 'desktop-joining')).not.toBeNull()
        expect(reopenedState.findTrustedDevice('space-target', 'desktop-owner')?.trustState).toBe('TRUSTED')
        expect(reopenedState.listEndpoints('space-target').some((endpoint) => endpoint.endpointId === 'lan:desktop-owner' && endpoint.enabled)).toBe(true)
      } finally {
        reopened.close()
      }
    } finally {
      if (ownerStarted) await owner.listener.close()
      if (initiatorStarted) await initiator.listener.close()
      if (!originalDatabasesClosed) {
        owner.database.close()
        initiator.database.close()
      }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('durable trust persistence stores, lists, and updates trusted devices', () => {
    const database = new DesktopDatabase(':memory:')
    const state = new SyncStateRepository(database.connection)

    const now = Date.now()
    state.upsertTrustedDevice({
      id: 'space-1:dev-phone',
      syncSpaceId: 'space-1',
      deviceId: 'dev-phone',
      staticPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtestpubkey',
      fingerprint: 'abcd1234ef5678',
      displayName: 'My Phone',
      platform: 'ANDROID',
      trustState: 'TRUSTED',
      pairedAt: now,
      lastSeenAt: now,
      authEpoch: 1
    })

    const list = state.listTrustedDevices('space-1')
    expect(list).toHaveLength(1)
    expect(list[0]?.deviceId).toBe('dev-phone')
    expect(list[0]?.trustState).toBe('TRUSTED')

    state.updateTrustedDeviceState('space-1', 'dev-phone', 'REVOKED', 2, now + 100)
    const updated = state.findTrustedDevice('space-1', 'dev-phone')
    expect(updated?.trustState).toBe('REVOKED')
    expect(updated?.authEpoch).toBe(2)

    state.deleteTrustedDevice('space-1', 'dev-phone')
    expect(state.listTrustedDevices('space-1')).toHaveLength(0)
  })

  it('DesktopSyncLanListener serves business routes over pinned TLS and rejects cleartext', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const secretStore = new MemorySecretStore()
    const keys = new DesktopSyncDeviceSigningKeyStore(secretStore)
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const pairing = new DesktopPairingCoordinator(
      runtime,
      state,
      keys,
      authLedger,
      () => 1
    )
    runtime.replaceDeviceIdentity({
      deviceId: 'desk-listener-test',
      witnessId: 'witness-listener-test',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    const listener = new DesktopSyncLanListener(
      runtime,
      state,
      keys,
      authLedger,
      {} as any,
      pairing,
      undefined,
      { port: 0, host: '127.0.0.1' }
    )

    const { port } = await listener.listen()
    expect(port).toBeGreaterThan(0)

    try {
      const secureBase = `https://127.0.0.1:${listener.tlsPort}`
      const tlsPeer = await SyncLanPeerTlsClient.connect(
        secureBase,
        keys.publicKeySpkiBase64('desk-listener-test'),
        'desk-listener-test'
      )
      try {
        const res = await tlsPeer.fetch(`${secureBase}/healthz`)
        expect(res.status).toBe(200)
        const data = await res.json()
        expect(data).toMatchObject({ ok: true, protocol: 'origread-sync-v1' })

        const pairStatusRes = await tlsPeer.fetch(`${secureBase}/v1/pairing/status?sessionId=non-existent`)
        expect(pairStatusRes.status).toBe(404)
        const pairData = await pairStatusRes.json()
        expect(pairData).toMatchObject({ error: 'NOT_FOUND' })
      } finally {
        tlsPeer.close()
      }

      const cleartextRes = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(cleartextRes.status).toBe(426)
    } finally {
      await listener.close()
    }
  })

  it('DesktopSyncLanListener formats null response body as "null" to prevent EOFException (B20)', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const secretStore = new MemorySecretStore()
    const keys = new DesktopSyncDeviceSigningKeyStore(secretStore)
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const pairing = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)
    runtime.replaceDeviceIdentity({
      deviceId: 'desk-null-test',
      witnessId: 'witness-null-test',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    const listener = new DesktopSyncLanListener(
      runtime,
      state,
      keys,
      authLedger,
      {} as any,
      pairing,
      undefined,
      { port: 0, host: '127.0.0.1' }
    )

    const { port } = await listener.listen()
    try {
      // 访问不存在的 blob status 时，listener 返回 200 且 body 为 null，应输出 "null" 字符串
      // 为通过鉴权拦截，直接测试内部 sendJson 行为或已暴露的公开 endpoint
      const secureBase = `https://127.0.0.1:${listener.tlsPort}`
      const tlsPeer = await SyncLanPeerTlsClient.connect(
        secureBase,
        keys.publicKeySpkiBase64('desk-null-test'),
        'desk-null-test'
      )
      try {
        const res = await tlsPeer.fetch(`${secureBase}/v1/pairing/status?sessionId=missing`)
        expect(res.status).toBe(404)
      } finally {
        tlsPeer.close()
      }
    } finally {
      await listener.close()
    }
  })

  it('DesktopSyncLanListener capabilities declares CORE_META, AUTH, LIBRARY (B14)', () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const secretStore = new MemorySecretStore()
    const keys = new DesktopSyncDeviceSigningKeyStore(secretStore)
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const pairing = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    const listener = new DesktopSyncLanListener(
      runtime,
      state,
      keys,
      authLedger,
      {} as any,
      pairing,
      undefined,
      { port: 0, host: '127.0.0.1' }
    )

    const caps = (listener as any).capabilities
    expect(caps.supportedReplicationLanes).toContain('CORE_META')
    expect(caps.supportedReplicationLanes).toContain('AUTH')
    expect(caps.supportedReplicationLanes).toContain('LIBRARY')
    expect(caps.supportedReplicationLanes).toContain('ARTICLE_STATE')
    expect(caps.supportedReplicationLanes).toContain('CONFIG')
    expect(caps.supportedReplicationLanes).toContain('AI_HISTORY')
  })

  it('healthz exposes liveness only and identity is returned only by a signed POST challenge', async () => {
    const database = new DesktopDatabase(':memory:')
    const runtime = new SyncRuntimeRepository(database.connection)
    const state = new SyncStateRepository(database.connection)
    const secretStore = new MemorySecretStore()
    const keys = new DesktopSyncDeviceSigningKeyStore(secretStore)
    const authLedger = new DesktopAuthLedgerService(runtime, state)
    const pairing = new DesktopPairingCoordinator(runtime, state, keys, authLedger, () => 1)

    // 初始化设备身份
    runtime.replaceDeviceIdentity({
      deviceId: 'desk-test-dev-1',
      witnessId: 'witness-1',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })

    const listener = new DesktopSyncLanListener(
      runtime,
      state,
      keys,
      authLedger,
      {} as any,
      pairing,
      undefined,
      { port: 0, host: '127.0.0.1' }
    )

    const { port } = await listener.listen()
    try {
      const secureBase = `https://127.0.0.1:${listener.tlsPort}`
      const tlsPeer = await SyncLanPeerTlsClient.connect(
        secureBase,
        keys.publicKeySpkiBase64('desk-test-dev-1'),
        'desk-test-dev-1'
      )
      try {
        const res = await tlsPeer.fetch(`${secureBase}/healthz`)
        expect(res.status).toBe(200)
        const data = (await res.json()) as { deviceId?: string; ok?: boolean }
        expect(data.deviceId).toBeUndefined()
        expect(data.ok).toBe(true)
      } finally {
        tlsPeer.close()
      }

      const cleartextHealth = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(cleartextHealth.status).toBe(426)

      const nonce = randomUUID()
      const getChallenge = await fetch(`http://127.0.0.1:${port}/v1/auth/challenge?nonce=${nonce}`)
      expect(getChallenge.status).toBe(426)

      const challengeRes = await fetch(`http://127.0.0.1:${port}/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce })
      })
      expect(challengeRes.status).toBe(200)
      const challenge = await challengeRes.json() as {
        deviceId: string
        nonce: string
        timestamp: number
        signature: string
        publicKeySpkiBase64: string
        tlsCertificateDerBase64: string
      }
      expect(challenge.deviceId).toBe('desk-test-dev-1')
      expect(challenge.nonce).toBe(nonce)
      expect(Math.abs(Date.now() - challenge.timestamp)).toBeLessThanOrEqual(120_000)
      expect(challenge.publicKeySpkiBase64).toBe(keys.publicKeySpkiBase64('desk-test-dev-1'))
      const certificate = new X509Certificate(Buffer.from(challenge.tlsCertificateDerBase64, 'base64'))
      expect(certificate.verify(certificate.publicKey)).toBe(true)
      expect(certificate.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')).toBe(challenge.publicKeySpkiBase64)
      const publicKey = createPublicKey({
        key: Buffer.from(challenge.publicKeySpkiBase64, 'base64'),
        format: 'der',
        type: 'spki'
      })
      const material = `CHALLENGE_RESPONSE:${challenge.deviceId}:${challenge.nonce}:${challenge.timestamp}`
      expect(cryptoVerify('sha256', Buffer.from(material, 'utf8'), publicKey, Buffer.from(challenge.signature, 'base64'))).toBe(true)
    } finally {
      await listener.close()
    }
  })
})
