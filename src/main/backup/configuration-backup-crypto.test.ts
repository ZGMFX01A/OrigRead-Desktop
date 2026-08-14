import { describe,expect,it } from 'vitest'
import { decryptConfigurationSecrets,encryptConfigurationSecrets } from './configuration-backup-crypto'
describe('Android configuration backup crypto parity',()=>{
  it('uses PBKDF2-SHA256 + AES-256-GCM with ciphertext and auth tag concatenated',()=>{const source={translationApiKeys:{DEEPL:'deep-key'},aiApiKeys:{default:'ai-key'}};const encrypted=encryptConfigurationSecrets(source,'password123');expect(encrypted).toMatchObject({kdf:'PBKDF2WithHmacSHA256',cipher:'AES-256-GCM',iterations:210000});expect(Buffer.from(encrypted.ivBase64,'base64')).toHaveLength(12);expect(Buffer.from(encrypted.saltBase64,'base64')).toHaveLength(16);expect(decryptConfigurationSecrets(encrypted,'password123')).toEqual(source);expect(()=>decryptConfigurationSecrets(encrypted,'wrong-pass')).toThrow()})
})

