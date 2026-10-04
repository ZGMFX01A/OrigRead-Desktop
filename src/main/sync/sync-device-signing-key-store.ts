import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto'
import type { SecretStore } from '../security/secret-store'

/** 各设备 P-256 私钥槽；旧名称保留以读取已配对身份。 */
const KEY_PREFIX = 'origread.sync.device.p256.v1.'

/**
 * Per-device signing key used by the AUTH/Operation protocol.
 *
 * The private key is stored only through Electron safeStorage in production. Public keys use the
 * same SPKI DER + Base64 representation as Android so either platform can verify the other.
 */
export class DesktopSyncDeviceSigningKeyStore {
  static readonly KEY_ALGORITHM_ID = 'ECDSA_P256_SHA256_V1'

  constructor(
    private readonly secrets: SecretStore,
    private readonly expectedPublicKey: (deviceId: string) => string | null = () => null,
    private readonly rememberPublicKey: (deviceId: string, publicKey: string) => void = () => {}
  ) {}

  publicKeySpkiBase64(deviceId: string): string {
    const privateKey = createPrivateKey(this.ensurePrivateKeyPem(deviceId))
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    return Buffer.from(publicKey).toString('base64')
  }

  signBase64(deviceId: string, material: string): string {
    const privateKey = createPrivateKey(this.ensurePrivateKeyPem(deviceId))
    return cryptoSign('sha256', Buffer.from(material, 'utf8'), privateKey).toString('base64')
  }

  signChunksBase64(deviceId: string, chunks: Iterable<string | Uint8Array>): string {
    const signer = createSign('sha256')
    for (const chunk of chunks) signer.update(chunk)
    return signer.sign(createPrivateKey(this.ensurePrivateKeyPem(deviceId))).toString('base64')
  }

  /**
   * Returns the existing safeStorage-backed P-256 identity pair for the LAN TLS certificate.
   * The private PEM remains in the main process and is never returned over IPC or written to disk.
   */
  lanTlsKeyPairPem(deviceId: string): { privateKeyPem: string; publicKeyPem: string } {
    const privateKey = createPrivateKey(this.ensurePrivateKeyPem(deviceId))
    return {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    }
  }

  verifyBase64(publicKeySpkiBase64: string, material: string, signatureBase64: string): boolean {
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

  verifyChunksBase64(
    publicKeySpkiBase64: string,
    chunks: Iterable<string | Uint8Array>,
    signatureBase64: string
  ): boolean {
    try {
      const verifier = createVerify('sha256')
      for (const chunk of chunks) verifier.update(chunk)
      const publicKey = createPublicKey({
        key: Buffer.from(publicKeySpkiBase64, 'base64'),
        format: 'der',
        type: 'spki'
      })
      return verifier.verify(publicKey, Buffer.from(signatureBase64, 'base64'))
    } catch {
      return false
    }
  }

  private ensurePrivateKeyPem(deviceId: string): string {
    const normalized = deviceId.trim()
    if (!normalized) throw new Error('deviceId must not be blank')
    const key = `${KEY_PREFIX}${normalized}`
    const existing = this.secrets.get(key)
    if (existing) {
      // Parse eagerly so corrupted safeStorage content cannot silently become a different key.
      const privateKey = createPrivateKey(existing)
      const expected = this.expectedPublicKey(normalized)
      const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64')
      if (expected && publicKey !== expected) throw new Error('SYNC_IDENTITY_UNREADABLE: private key does not match paired identity')
      // 已有持久见证仍每次比对，但签名/状态请求不能重复写业务库争用安装锁。
      // 首次缺少见证时沿用原初始化写入；身份损坏或不匹配仍直接失败。
      if (!expected) this.rememberPublicKey(normalized, publicKey)
      return existing
    }

    if (this.secrets.contains(key) || this.expectedPublicKey(normalized)) {
      throw new Error('SYNC_IDENTITY_UNREADABLE: existing device signing key is missing or unreadable')
    }
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    this.secrets.put(key, privateKey)
    this.rememberPublicKey(normalized, createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' }).toString('base64'))
    return privateKey
  }
}
