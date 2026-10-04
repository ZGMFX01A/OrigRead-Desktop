import type { DatabaseSync } from 'node:sqlite'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { snapshotTracePhase, snapshotTraceSql, snapshotTraceWork } from './sync-snapshot-trace'

export interface SourceCopyProgress { beforeBatch(): void; committed(bytes: number): void }
interface Input { cut: string; version: number; table: string; ddl: string; progress?: SourceCopyProgress }
/** SQL 私有副本的标准记录和字节批次，合法大单条独占提交。 */
const COPY_ROWS = 256
/** native SQL 复制也受实际源行字节预算约束。 */
const COPY_BYTES = 2 * 1024 * 1024

/** 同一固定 raw cut 逐批恢复到私有副本，来源连接不承担目标写事务。 */
export function copyRawSnapshotTable(target: DatabaseSync, input: Input): void {
  prepareProgress(target)
  reconcileProgress(target, input)
  input.progress?.committed(copiedBytes(target, input.cut))
  const progress = target.prepare('SELECT CAST(after_id AS TEXT) AS after_id,state FROM sync_snapshot_copy_progress WHERE cut=? AND table_name=?').get(input.cut, input.table)
  if (progress?.state === 'DONE') return
  if (!target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(input.table)) target.exec(input.ddl)
  if (!progress || progress.state === 'CLEARING') clearTable(target, input)
  const columns = target.prepare(`PRAGMA table_info(${quote(input.table)})`).all().map(row => quote(String(row.name)))
  const raw = `raw_source.${quote(`sync_raw_v${input.version}_${input.table}`)}`
  const size = columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')
  let after = progress?.state === 'COPYING' && progress.after_id != null ? BigInt(String(progress.after_id)) : null
  for (;;) {
    snapshotCheckpoint()
    const candidates = target.prepare(`SELECT CAST(raw_rowid AS TEXT) AS id,${size} AS bytes FROM ${raw}
      WHERE raw_cut=? AND (raw_rowid>? OR ? IS NULL) ORDER BY raw_rowid LIMIT ${COPY_ROWS}`).all(input.cut, after, after)
    const batch = bounded(candidates)
    if (!batch.length) break
    const last = BigInt(String(batch.at(-1)!.id))
    input.progress?.beforeBatch()
    transaction(target, () => {
      target.prepare(`INSERT INTO ${quote(input.table)}(${columns.join(',')}) SELECT ${columns.join(',')} FROM ${raw}
        WHERE raw_cut=? AND (raw_rowid>? OR ? IS NULL) AND raw_rowid<=? ORDER BY raw_rowid`).run(input.cut, after, after, last)
      target.prepare(`INSERT INTO sync_snapshot_copy_progress VALUES(?,?,?,'COPYING',?) ON CONFLICT(cut,table_name)
        DO UPDATE SET after_id=excluded.after_id,state=excluded.state,copied_bytes=copied_bytes+excluded.copied_bytes`)
        .run(input.cut, input.table, last, batch.reduce((sum, row) => sum + Number(row.bytes), 0))
    })
    input.progress?.committed(copiedBytes(target, input.cut))
    snapshotTraceWork({ rows: batch.length, bytes: batch.reduce((sum, row) => sum + Number(row.bytes), 0) })
    after = last
  }
  target.prepare("UPDATE sync_snapshot_copy_progress SET state='DONE' WHERE cut=? AND table_name=?").run(input.cut, input.table)
}

/** 清理旧私有副本也逐批提交，崩溃后仍处于 CLEARING，不误认为开始复制。 */
function clearTable(target: DatabaseSync, input: Input): void {
  target.prepare("INSERT OR REPLACE INTO sync_snapshot_copy_progress VALUES(?,?,NULL,'CLEARING',0)").run(input.cut, input.table)
  for (;;) {
    snapshotCheckpoint()
    const result = target.prepare(`DELETE FROM ${quote(input.table)} WHERE rowid IN (SELECT rowid FROM ${quote(input.table)} LIMIT ${COPY_ROWS})`).run()
    if (Number(result.changes) === 0) break
  }
  target.prepare("UPDATE sync_snapshot_copy_progress SET state='COPYING' WHERE cut=? AND table_name=?").run(input.cut, input.table)
}

/** 副本累计字节是 cursor 同事务事实，跨库预算失败后可在下一次空间检查前重新对账。 */
function copiedBytes(target: DatabaseSync, cut: string): number {
  return Number(target.prepare('SELECT COALESCE(SUM(copied_bytes),0) AS bytes FROM sync_snapshot_copy_progress WHERE cut=?').get(cut)!.bytes)
}

/** 显式升级旧派生进度；不会重置已复制数据、cursor 或原始 cut。 */
function prepareProgress(target: DatabaseSync): void {
  target.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_copy_progress(cut TEXT,table_name TEXT,after_id INTEGER,state TEXT,
    copied_bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(cut,table_name))`)
  if (!target.prepare('PRAGMA table_info(sync_snapshot_copy_progress)').all().some(row => row.name === 'copied_bytes')) {
    target.exec('ALTER TABLE sync_snapshot_copy_progress ADD COLUMN copied_bytes INTEGER NOT NULL DEFAULT 0')
  }
}

/** 旧 cursor 缺少累计字节时，只从同一固定 raw 前缀重建数字，不解码正文或读当前活表。 */
function reconcileProgress(target: DatabaseSync, input: Input): void {
  const previous = target.prepare('SELECT CAST(after_id AS TEXT) AS after_id,copied_bytes FROM sync_snapshot_copy_progress WHERE cut=? AND table_name=?').get(input.cut, input.table)
  if (previous?.after_id == null || Number(previous.copied_bytes) !== 0) return
  const columns = target.prepare(`PRAGMA table_info(${quote(input.table)})`).all()
    .map(row => `COALESCE(length(CAST(${quote(String(row.name))} AS BLOB)),0)`)
  const raw = `raw_source.${quote(`sync_raw_v${input.version}_${input.table}`)}`
  const bytes = Number(target.prepare(`SELECT COALESCE(SUM(${columns.join('+')}),0) AS bytes FROM ${raw} WHERE raw_cut=? AND raw_rowid<=?`)
    .get(input.cut, BigInt(String(previous.after_id)))!.bytes)
  target.prepare('UPDATE sync_snapshot_copy_progress SET copied_bytes=? WHERE cut=? AND table_name=?').run(bytes, input.cut, input.table)
}

/** 只预取行号和字节数，不把原始正文放进 JS 数组。 */
function bounded(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const selected: Record<string, unknown>[] = []
  let bytes = 0
  for (const row of rows) {
    if (selected.length && bytes + Number(row.bytes) > COPY_BYTES) break
    selected.push(row); bytes += Number(row.bytes)
  }
  return selected
}

/** 每个 SQL 写批次在同一线程取得及退出，计时覆盖真实提交/回滚。 */
function transaction(database: DatabaseSync, action: () => void): void {
  snapshotTracePhase('capture.copy_batch', () => {
    const requested = process.hrtime.bigint()
    database.exec('BEGIN IMMEDIATE')
    const acquired = process.hrtime.bigint()
    snapshotTraceSql({ lockNanos: acquired - requested })
    try { action(); database.exec('COMMIT') }
    catch (error) {
      // 本批数据和断点一起回滚，完整原始 cut 保持不变。
      database.exec('ROLLBACK'); throw error
    } finally { snapshotTraceSql({ transactionNanos: process.hrtime.bigint() - acquired }) }
  })
}

/** 标识符来自固定来源 schema，值仍通过参数绑定。 */
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"` }
