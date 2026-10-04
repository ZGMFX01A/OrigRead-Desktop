import { safeStorage } from 'electron'

/** 同步私钥必须使用真实系统密钥后端；Linux basic_text 不能承担身份保护责任。 */
export function requireSecureStorageBackend(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用')
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('CREDENTIAL_REQUIRED: Linux 系统密钥环不可用，请配置密钥环后恢复同步')
  }
}
