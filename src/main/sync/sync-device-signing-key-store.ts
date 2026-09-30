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
