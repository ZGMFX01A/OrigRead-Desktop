import type { DatabaseSync } from 'node:sqlite'

/** 本机 LAN 开关仅记录用户意图，不进入跨设备业务配置同步。 */
const LAN_REQUESTED_KEY = 'sync.lan.requested'

/** 无记录表示首次使用；损坏设置明确失败，不能悄悄关闭已启用的监听。 */
export function readLanRequested(database: DatabaseSync): boolean {
  const row = database.prepare('SELECT value FROM app_settings WHERE key=?').get(LAN_REQUESTED_KEY)
  if (!row) return false
  const value: unknown = JSON.parse(String(row.value))
  if (typeof value !== 'boolean') throw new Error('Invalid persisted LAN sync preference')
  return value
}

/** 在启停监听前保存意图，网络暂不可用不能改变用户开关。 */
export function writeLanRequested(database: DatabaseSync, enabled: boolean): void {
  database.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(LAN_REQUESTED_KEY, JSON.stringify(enabled), Date.now())
}
