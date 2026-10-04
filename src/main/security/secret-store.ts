import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { writeDurableFile } from './durable-file'
import { requireSecureStorageBackend } from './secure-storage-backend'
import { safeStorage } from 'electron'

export interface SecretStore {
  get(key: string): string
  put(key: string, value: string): void
  contains(key: string): boolean
  delete(key: string): void
  snapshot(): Readonly<Record<string, string>>
  restoreSnapshot(snapshot: Readonly<Record<string, string>>): void
}

export class ElectronSecretStore implements SecretStore {
  constructor(private readonly file: string, private readonly strict = false, private readonly requireSlot = false) {}

  get(key: string): string {
    const encoded = this.load()[key]
        if (!encoded && this.requireSlot && existsSync(this.file)) throw new Error('Existing Sync witness file is missing its ciphertext')
    if (!encoded) return ''
    requireSecureStorageBackend()
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch (error) {
      // 同步见证不能把解密失败当作空值，否则设备与操作序号会被静默重置。
      if (this.strict) throw error
      return ''
    }
  }

  put(key: string, value: string): void {
    const data = this.load()
    const normalized = value.trim()
    if (!normalized) {
      delete data[key]
    } else {
      requireSecureStorageBackend()
      data[key] = safeStorage.encryptString(normalized).toString('base64')
    }
    this.write(data)
  }

  contains(key: string): boolean {
    return Boolean(this.load()[key])
  }

  delete(key: string): void {
    const data = this.load()
    delete data[key]
    this.write(data)
  }

  /** Opaque ciphertext snapshot used only for transactional rollback. */
  snapshot(): Readonly<Record<string, string>> {
    return { ...this.load() }
  }

  restoreSnapshot(snapshot: Readonly<Record<string, string>>): void {
    this.write({ ...snapshot })
  }

  private load(): Record<string, string> {
    try {
      if (!existsSync(this.file)) return {}
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (this.strict && (this.requireSlot && Object.keys(value).length === 0 ||
          Object.values(value).some(encoded => typeof encoded !== 'string' || !encoded.trim()))) {
          throw new Error('Invalid encrypted Sync witness content')
        }
        return value as Record<string, string>
      }
      if (this.strict) throw new Error('Invalid encrypted Sync witness file')
      return {}
    } catch (error) {
      // 见证专用读取保留 I/O 和 JSON 错误；其他已有凭据调用保持原行为。
      if (this.strict) throw error
      return {}
    }
  }

  private write(value: Record<string, string>): void {
    // 只保留已成功读取的上一代密文；恢复必须显式核验，不能自动回退并重置身份。
    if (this.strict && existsSync(this.file)) writeDurableFile(this.file + '.previous', readFileSync(this.file))
    writeDurableFile(this.file, JSON.stringify(value, null, 2))
    try { chmodSync(this.file, 0o600) } catch { /* safeStorage ciphertext remains protected if chmod is unsupported */ }
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  get(key: string): string { return this.values.get(key) ?? '' }
  put(key: string, value: string): void { value.trim() ? this.values.set(key, value.trim()) : this.values.delete(key) }
  contains(key: string): boolean { return this.values.has(key) }
  delete(key: string): void { this.values.delete(key) }
  snapshot(): Readonly<Record<string, string>> { return Object.fromEntries(this.values) }
  restoreSnapshot(snapshot: Readonly<Record<string, string>>): void {
    this.values.clear()
    for (const [key, value] of Object.entries(snapshot)) this.values.set(key, value)
  }
}

