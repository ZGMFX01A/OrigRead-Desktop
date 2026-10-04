import type { DatabaseSync } from 'node:sqlite'

/** 每个 Space 每日一个维护机会，不随 Peer 数量或网络轮询次数重复生成快照。 */
export function claimSyncMaintenance(database: DatabaseSync, input: { space: string; now: number }): boolean {
  const key = `sync-maintenance:${input.space}`
  const last = Number(database.prepare('SELECT value FROM local_config_document WHERE key=?').get(key)?.value ?? 0)
  if (last && input.now - last < MAINTENANCE_INTERVAL_MS) return false
  database.prepare('INSERT INTO local_config_document VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(input.now))
  return true
}
/** 与暂存保留策略一致的低频维护窗口，普通同步批次不承担全量压缩。 */
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
