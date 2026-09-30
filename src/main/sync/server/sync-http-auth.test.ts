import { describe, expect, it, afterEach } from 'vitest'
import { SyncServerHttp } from './sync-server-http'
import { SyncHttpEndpointSession } from '../sync-http-session'
import { DesktopSyncDeviceSigningKeyStore } from '../sync-device-signing-key-store'
import { MemorySecretStore } from '../../security/secret-store'

describe('SyncServerHttp and SyncHttpEndpointSession authentication and anti-replay', () => {
  let server: SyncServerHttp | null = null

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('allows authenticated requests and rejects replay, expired, or forged requests', async () => {
    server = new SyncServerHttp({ databasePath: ':memory:', host: '127.0.0.1', port: 0, adminToken: 'secret-admin' })
    const { port } = await server.listen()
    const baseUrl = `http://127.0.0.1:${port}`

    const spaceId = 'space-test-auth'
    const deviceA = 'device-alpha'
    const secretsA = new MemorySecretStore()
    const keysA = new DesktopSyncDeviceSigningKeyStore(secretsA)
    const pubKeyA = keysA.publicKeySpkiBase64(deviceA)

    // 通过管理接口注册 deviceA 为 active member
    const regRes = await fetch(`${baseUrl}/v1/spaces/${spaceId}/members/${deviceA}`, {
      method: 'PUT',
      headers: {
        'authorization': 'Bearer secret-admin',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ publicKeySpkiBase64: pubKeyA, status: 'ACTIVE', authEpoch: 0 })
    })
    expect(regRes.status).toBe(204)

    // 1. 合法客户端使用合法私钥签名发起会话协商
    const sessionA = new SyncHttpEndpointSession({
      baseUrl,
      syncSpaceId: spaceId,
      deviceId: deviceA,
      signer: (material) => keysA.signBase64(deviceA, material)
    })

    const negotiation = await sessionA.negotiateProtocolAndCapabilities()
    expect(negotiation.syncSpaceId).toBe(spaceId)
    expect(negotiation.localDeviceId).toBe(deviceA)

    // 2. 缺少签名头应当被拒绝 (401)
    const noSignRes = await fetch(`${baseUrl}/v1/spaces/${spaceId}/state`, {
      method: 'GET',
      headers: { 'x-sync-device-id': deviceA }
    })
    expect(noSignRes.status).toBe(401)

    // 3. 冒名攻击：攻击者 deviceB 使用 deviceA 的 ID，但使用自己的私钥签名
    const secretsB = new MemorySecretStore()
    const keysB = new DesktopSyncDeviceSigningKeyStore(secretsB)
    const sessionImpostor = new SyncHttpEndpointSession({
      baseUrl,
      syncSpaceId: spaceId,
      deviceId: deviceA, // 伪装成 deviceA
      signer: (material) => keysB.signBase64('device-beta', material) // 但持有的是 deviceB 的私钥
    })
    await expect(sessionImpostor.getRemoteStateVector()).rejects.toThrow(/Sync endpoint 401/)

    // 4. 未配对设备直接发起请求被拒绝 (403)
    const sessionUnpaired = new SyncHttpEndpointSession({
      baseUrl,
      syncSpaceId: spaceId,
      deviceId: 'device-unpaired',
      signer: (material) => keysB.signBase64('device-unpaired', material)
    })
    await expect(sessionUnpaired.getRemoteStateVector()).rejects.toThrow(/Sync endpoint 403/)

    // 5. 防重放攻击：手动重放已签名的相同请求
    const timestamp = String(Date.now())
    const nonce = 'unique-nonce-1234567890abcdef'
    const path = `/v1/spaces/${spaceId}/state`
    const bodySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const material = `GET\n${path}\n${timestamp}\n${nonce}\n${bodySha256}`
    const signature = keysA.signBase64(deviceA, material)

    // 首次发送应当成功
    const firstRes = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'x-sync-device-id': deviceA,
        'x-sync-timestamp': timestamp,
        'x-sync-nonce': nonce,
        'x-sync-signature': signature
      }
    })
    expect(firstRes.status).toBe(200)

    // 重放发送应当被 401 REPLAY_DETECTED 拒绝
    const replayRes = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'x-sync-device-id': deviceA,
        'x-sync-timestamp': timestamp,
        'x-sync-nonce': nonce,
        'x-sync-signature': signature
      }
    })
    expect(replayRes.status).toBe(401)
    const replayBody = await replayRes.json() as { error?: string }
    expect(replayBody.error).toBe('REPLAY_DETECTED')

    // 6. 过期请求（时间戳超过 5 分钟前）
    const expiredTimestamp = String(Date.now() - 10 * 60 * 1000)
    const expiredNonce = 'expired-nonce-1234567890abcdef'
    const expiredMaterial = `GET\n${path}\n${expiredTimestamp}\n${expiredNonce}\n${bodySha256}`
    const expiredSig = keysA.signBase64(deviceA, expiredMaterial)

    const expiredRes = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'x-sync-device-id': deviceA,
        'x-sync-timestamp': expiredTimestamp,
        'x-sync-nonce': expiredNonce,
        'x-sync-signature': expiredSig
      }
    })
    expect(expiredRes.status).toBe(401)
    const expiredBody = await expiredRes.json() as { error?: string }
    expect(expiredBody.error).toBe('REQUEST_EXPIRED')
  })
})
