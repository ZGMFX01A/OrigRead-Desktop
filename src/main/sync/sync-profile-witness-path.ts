import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { ElectronSecretStore } from '../security/secret-store'

/** 每个 profile 在业务目录之外保留独立见证文件，避免其他实例覆盖设备和序号身份。 */
export function createProfileWitnessStore(input: { appDataPath: string; userDataPath: string; hasPersistentDevice: boolean }): ElectronSecretStore {
  const profileHash = createHash('sha256').update(input.userDataPath).digest('hex')
  const destination = join(input.appDataPath, `origread-sync-rollback-witness-${profileHash}.secrets.json`)
  const store = new ElectronSecretStore(destination, true, true)
  if (existsSync(destination)) return store
  // 新 profile 没有可迁移的设备；safeStorage 的旧密文也不能跨 Chromium profile 解密。
  if (!input.hasPersistentDevice) return store
  const legacy = new ElectronSecretStore(join(input.appDataPath, 'origread-sync-rollback-witness.secrets.json'), true, true)
  const raw = legacy.get('sync.rollback-witness.v1')
  if (!raw && legacy.contains('sync.rollback-witness.v1')) throw new Error('Sync rollback witness cannot be decrypted')
  if (!raw) return store
  // 只迁移路径完全匹配的旧见证；另一个 profile 的见证不能成为本机身份。
  const value = JSON.parse(raw) as { schemaVersion?: number; profileBinding?: string }
  if (value.schemaVersion !== 1 || typeof value.profileBinding !== 'string' || !value.profileBinding) {
    throw new Error('Invalid legacy sync rollback witness schema or profile binding')
  }
  if (value.profileBinding === input.userDataPath) {
    store.put('sync.rollback-witness.v1', raw)
  }
  return store
}
