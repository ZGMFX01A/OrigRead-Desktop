import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  constructor(private readonly file: string) {}

  get(key: string): string {
    const encoded = this.load()[key]
    if (!encoded) return ''
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用')
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      return ''
    }
  }

  put(key: string, value: string): void {
    const data = this.load()
    const normalized = value.trim()
    if (!normalized) {
      delete data[key]
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用，无法保存凭据')
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
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {}
    } catch {
      return {}
    }
  }

  private write(value: Record<string, string>): void {
    writeFileSync(this.file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
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

