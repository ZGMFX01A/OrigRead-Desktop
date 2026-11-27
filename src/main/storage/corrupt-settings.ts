import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { redactSensitiveText } from '../security/sensitive-text'

/** Keep the first copy of each corrupt value; repeated reads must not overwrite evidence. */
export function backupCorruptSetting(database: DatabaseSync, key: string, value: string, prefix = key): string {
  const pattern = `${prefix}.corrupt.%`
  const existing = database.prepare('SELECT key FROM app_settings WHERE key LIKE ? AND value=? LIMIT 1').get(pattern, value) as { key: string } | undefined
  if (existing) return existing.key
  const backupKey = `${prefix}.corrupt.${Date.now()}.${randomUUID()}`
  database.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(backupKey, value, Date.now())
  return backupKey
}

export function corruptSettingError(label: string, backup: string, cause: unknown): Error {
  return new Error(`${label}损坏，已备份到 ${backup}：${redactSensitiveText(cause instanceof Error ? cause.message : String(cause))}`)
}
