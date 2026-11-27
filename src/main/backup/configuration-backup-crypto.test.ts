import type * as Crypto from 'node:crypto'
const derived = vi.hoisted(() => [] as Buffer[])
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual,
    pbkdf2Sync: () => { throw new Error('Synchronous PBKDF2 must never run') },
    pbkdf2: (password: Crypto.BinaryLike, salt: Crypto.BinaryLike, iterations: number, size: number, digest: string, callback: (error: Error | null, key: Buffer) => void) => {
      actual.pbkdf2(password, salt, iterations, size, digest, (error, key) => {
        if (!error) derived.push(key)
        callback(error, key)
      })
    }
  }
})
import { describe,expect,it,vi } from 'vitest'
import { decryptConfigurationSecrets,encryptConfigurationSecrets } from './configuration-backup-crypto'
describe('Android configuration backup crypto parity',()=>{
  it('uses PBKDF2-SHA256 + AES-256-GCM with ciphertext and auth tag concatenated',async ()=>{const source={translationApiKeys:{DEEPL:'deep-key'},aiApiKeys:{default:'ai-key'}};const encrypted=await encryptConfigurationSecrets(source,'password123');expect(encrypted).toMatchObject({kdf:'PBKDF2WithHmacSHA256',cipher:'AES-256-GCM',iterations:210000});expect(Buffer.from(encrypted.ivBase64,'base64')).toHaveLength(12);expect(Buffer.from(encrypted.saltBase64,'base64')).toHaveLength(16);expect(await decryptConfigurationSecrets(encrypted,'password123')).toEqual(source);await expect(decryptConfigurationSecrets(encrypted,'wrong-pass')).rejects.toThrow()})
})


describe('asynchronous derivation and key disposal', () => {
  it('yields to the event loop and clears keys on success and authentication failure', async () => {
    const source = { translationApiKeys: {}, aiApiKeys: { test: 'secret' }, editionSecrets: { preserved: true } }
    derived.length = 0
    let settled = false
    const pending = encryptConfigurationSecrets(source, 'password123').then(result => { settled = true; return result })
    expect(pending).toBeInstanceOf(Promise)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    const encrypted = await pending
    expect(await decryptConfigurationSecrets(encrypted, 'password123')).toEqual(source)
    await expect(decryptConfigurationSecrets(encrypted, 'wrong-password')).rejects.toThrow('密码错误')
    expect(derived).toHaveLength(3)
    for (const key of derived) expect([...key]).toEqual(Array(32).fill(0))
  })
  it.each([NaN, Infinity, -1, 0, 99_999, 2_000_001, 210_000.5, '210000', undefined])('rejects invalid iterations %s before derivation', async iterations => {
    const encrypted = { kdf: 'PBKDF2WithHmacSHA256', cipher: 'AES-256-GCM', iterations, saltBase64: '', ivBase64: '', ciphertextBase64: '' }
    const before = derived.length
    await expect(decryptConfigurationSecrets(encrypted as Parameters<typeof decryptConfigurationSecrets>[0], 'password123')).rejects.toThrow('迭代次数')
    expect(derived.length).toBe(before)
  })
})
