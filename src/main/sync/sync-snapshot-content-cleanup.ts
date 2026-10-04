import type { DatabaseSync } from 'node:sqlite'
import { snapshotCheckpoint } from './sync-snapshot-execution'

/** 清理与普通快照 DTO 共用条数预算，不能单事务删除整轮索引。 */
const CLEANUP_ROWS = 256
/** 以实际 UTF-8/BLOB 字节划分清理批次，大单条独占 SQL。 */
const CLEANUP_BYTES = 2 * 1024 * 1024
/** 表名与载荷列来自正式 schema，永不接受网络或用户提供的 SQL 标识符。 */
const CONTENT_TABLES = [
  ['sync_snapshot_source_link', 'record_key'],
  ['sync_paged_snapshot_record', 'record_json'],
  ['sync_paged_snapshot_page', 'bytes']
] as const

/** 调用方已确认私有 capture 或已覆盖且无引用的对象，逐批删除其派生内容。 */
export function clearSnapshotContent(database: DatabaseSync, bundle: string): void {
  for (const [table, column] of CONTENT_TABLES) removeRows(database, {
    table, column, where: 'snapshot_bundle_id=?', args: [bundle]
  })
}

/** 重建索引保留全部不可变原页，INDEXING 状态先阻止消费，删除事实支持中断后重入。 */
export function clearSnapshotIndex(database: DatabaseSync, bundle: string): void {
  for (const [table, column] of CONTENT_TABLES.slice(0, -1)) removeRows(database, {
    table, column, where: 'snapshot_bundle_id=?', args: [bundle]
  })
}

/** 无字段链接的完整来源也按实际载荷字节清理，不能一次删除整库签名对象。 */
export function collectSnapshotSources(database: DatabaseSync): void {
  removeRows(database, { table: 'sync_snapshot_source', column: 'envelope_json', args: [],
    where: 'NOT EXISTS(SELECT 1 FROM sync_snapshot_source_link l WHERE l.source_key=sync_snapshot_source.source_key)' })
}

/** GC 已确认无消费者后才回收大 Tail；私有 capture 重试不动原有 Tail 语义。 */
export function clearSnapshotTail(database: DatabaseSync, bundle: string): void {
  removeRows(database, { table: 'sync_paged_snapshot_tail', column: 'operation_json', where: 'snapshot_bundle_id=?', args: [bundle] })
}

/** 轻量行键读取先结束，再执行独立原子 DELETE；已经删除的真实事实就是重入断点。 */
function removeRows(database: DatabaseSync, input: { table: string; column: string; where: string; args: string[] }): void {
  const select = database.prepare(`SELECT rowid,length(CAST(${input.column} AS BLOB)) AS bytes FROM ${input.table}
    WHERE ${input.where} ORDER BY rowid LIMIT ${CLEANUP_ROWS}`)
  const deletes = new Map<number, ReturnType<DatabaseSync['prepare']>>()
  while (true) {
    snapshotCheckpoint()
    const rows = select.all(...input.args)
    if (!rows.length) return
    const selected: number[] = []
    let bytes = 0
    for (const row of rows) {
      const size = Number(row.bytes)
      if (selected.length && bytes + size > CLEANUP_BYTES) break
      selected.push(Number(row.rowid)); bytes += size
    }
    let statement = deletes.get(selected.length)
    if (!statement) {
      statement = database.prepare(`DELETE FROM ${input.table} WHERE rowid IN (${selected.map(() => '?').join(',')})`)
      deletes.set(selected.length, statement)
    }
    statement.run(...selected)
  }
}
