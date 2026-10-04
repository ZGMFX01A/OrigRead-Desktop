import type { DatabaseSync } from 'node:sqlite'

/** 实际派生页/记录的字节计数由同库 SQL 触发器维护，每批只读取小型累计值。 */
export function prepareSnapshotResourceUsage(database: DatabaseSync): void {
  database.exec('CREATE TABLE IF NOT EXISTS sync_snapshot_resource_usage(bundle TEXT PRIMARY KEY,bytes INTEGER NOT NULL)')
  database.exec('CREATE TABLE IF NOT EXISTS sync_snapshot_resource_usage_version(bundle TEXT PRIMARY KEY,version INTEGER NOT NULL)')
  for (const [table, length] of USAGE_TABLES) {
    for (const event of ['INSERT', 'DELETE', 'UPDATE'] as const) {
      const before = event === 'INSERT' ? '' : adjustment('OLD', `-(${length('OLD')})`)
      const after = event === 'DELETE' ? '' : adjustment('NEW', length('NEW'))
      database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_usage_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN ${before}${after} END`)
    }
  }
}

/** 旧输入按需初始化一次，不在构造阶段对几万行执行全库转换。 */
export function initializeSnapshotResourceUsage(database: DatabaseSync, bundle: string): void {
  if (database.prepare('SELECT 1 FROM sync_snapshot_resource_usage_version WHERE bundle=? AND version=?').get(bundle, USAGE_VERSION)) return
  const sums = USAGE_TABLES.map(([table, length]) => `COALESCE((SELECT SUM(${length(table)}) FROM ${table} WHERE snapshot_bundle_id=?),0)`)
  database.prepare(`INSERT OR REPLACE INTO sync_snapshot_resource_usage SELECT ?,${sums.join('+')}`).run(bundle, ...sums.map(() => bundle))
  database.prepare('INSERT OR REPLACE INTO sync_snapshot_resource_usage_version VALUES(?,?)').run(bundle, USAGE_VERSION)
}

/** 已存在的物理分配由文件系统计数；此表只抵扣尚需预约的派生增量。 */
const USAGE_TABLES: readonly (readonly [string, (scope: string) => string])[] = [
  ['sync_paged_snapshot_page', scope => `length(${scope}.bytes)`],
  ['sync_paged_snapshot_record', scope => `length(CAST(${scope}.record_json AS BLOB))`],
  ['sync_snapshot_field_index', scope => textBytes(scope, ['snapshot_bundle_id', 'replication_lane_id', 'record_key', 'version_token', 'causal_context_json', 'value_digest', 'preference_value_json'])],
  ['sync_snapshot_entity_index', scope => textBytes(scope, ['snapshot_bundle_id', 'replication_lane_id', 'record_key', 'context_json'])],
  ['sync_snapshot_entity_edge', scope => textBytes(scope, ['snapshot_bundle_id', 'replication_lane_id', 'record_key', 'parent_type', 'parent_id'])]
]

/** v2 将 P3 的字段和关系轻索引纳入已分配计数。 */
const USAGE_VERSION = 2

/** 固定 schema 文本列计入 UTF-8 实际长度，SQL 形状不包含外部输入。 */
function textBytes(scope: string, columns: readonly string[]): string {
  return columns.map(column => `COALESCE(length(CAST(${scope}.${column} AS BLOB)),0)`).join('+')
}

/** 触发器与数据改变共用事务，回滚后实际计数也回滚。 */
function adjustment(scope: string, delta: string): string {
  return `INSERT OR IGNORE INTO sync_snapshot_resource_usage VALUES(${scope}.snapshot_bundle_id,0);
    UPDATE sync_snapshot_resource_usage SET bytes=bytes+${delta} WHERE bundle=${scope}.snapshot_bundle_id;`
}
