import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto'
import type { SecretStore } from '../security/secret-store'

const KEY_PREFIX = 'origread.sync.device.p256.v1.'

/**
 * Per-device signing key used by the AUTH/Operation protocol.
 *
 * The private key is stored only through Electron safeStorage in production. Public keys use the
 * same SPKI DER + Base64 representation as Android so either platform can verify the other.
 */
export class DesktopSyncDeviceSigningKeyStore {
  static readonly KEY_ALGORITHM_ID = 'ECDSA_P256_SHA256_V1'

  constructor(private readonly secrets: SecretStore) {}

  publicKeySpkiBase64(deviceId: string): string {
    const privateKey = createPrivateKey(this.ensurePrivateKeyPem(deviceId))
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    return Buffer.from(publicKey).toString('base64')
  }

  signBase64(deviceId: string, material: string): string {
    const privateKey = createPrivateKey(this.ensurePrivateKeyPem(deviceId))
    return cryptoSign('sha256', Buffer.from(material, 'utf8'), privateKey).toString('base64')
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

  private ensurePrivateKeyPem(deviceId: string): string {
    const normalized = deviceId.trim()
    if (!normalized) throw new Error('deviceId must not be blank')
    const key = `${KEY_PREFIX}${normalized}`
    const existing = this.secrets.get(key)
    if (existing) {
      // Parse eagerly so corrupted safeStorage content cannot silently become a different key.
      createPrivateKey(existing)
      return existing
    }

    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    this.secrets.put(key, privateKey)
    return privateKey
  }
}
