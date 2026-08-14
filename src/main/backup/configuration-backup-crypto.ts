import { createCipheriv,createDecipheriv,pbkdf2Sync,randomBytes } from 'node:crypto'
import type { ConfigurationBackupSecrets,EncryptedBackupSecrets } from '../../shared/configuration-backup'

const ITERATIONS=210_000;const KEY_BYTES=32;const TAG_BYTES=16;const AAD=Buffer.from('OrigReadConfigurationBackup:v1','utf8')

export function encryptConfigurationSecrets(value:ConfigurationBackupSecrets,password:string):EncryptedBackupSecrets{
  if(password.length<6)throw new Error('备份密码至少需要 6 个字符')
  const salt=randomBytes(16),iv=randomBytes(12),key=pbkdf2Sync(password,salt,ITERATIONS,KEY_BYTES,'sha256')
  const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD)
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()])
  return{kdf:'PBKDF2WithHmacSHA256',cipher:'AES-256-GCM',iterations:ITERATIONS,saltBase64:salt.toString('base64'),ivBase64:iv.toString('base64'),ciphertextBase64:encrypted.toString('base64')}
}

export function decryptConfigurationSecrets(value:EncryptedBackupSecrets,password:string):ConfigurationBackupSecrets{
  if(value.kdf!=='PBKDF2WithHmacSHA256'||value.cipher!=='AES-256-GCM')throw new Error('不支持的备份加密算法')
  if(value.iterations<100_000||value.iterations>2_000_000)throw new Error('备份 KDF 迭代次数无效')
  const salt=Buffer.from(value.saltBase64,'base64'),iv=Buffer.from(value.ivBase64,'base64'),payload=Buffer.from(value.ciphertextBase64,'base64')
  if(salt.length<16||salt.length>64||iv.length!==12||payload.length<=TAG_BYTES)throw new Error('加密凭据参数无效')
  const ciphertext=payload.subarray(0,-TAG_BYTES),tag=payload.subarray(-TAG_BYTES),key=pbkdf2Sync(password,salt,value.iterations,KEY_BYTES,'sha256')
  try{const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);const plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');const parsed=JSON.parse(plain) as ConfigurationBackupSecrets;return{translationApiKeys:parsed.translationApiKeys??{},aiApiKeys:parsed.aiApiKeys??{}}}catch{throw new Error('备份密码错误或加密凭据已损坏')}
}

