import type { DatabaseSync } from 'node:sqlite'
import { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'
import { snapshotTraceSql, snapshotTracePhase, snapshotTraceWork } from './sync-snapshot-trace'

interface Batch { job: string; phase: string; cursor: string; budget: SyncSnapshotResourceBudget; rows?: number; bytes?: number }
/** 断点语句随写连接复用，不逐批分配相同原生 prepared statement。 */
const statements = new WeakMap<DatabaseSync, { read: ReturnType<DatabaseSync['prepare']>; write: ReturnType<DatabaseSync['prepare']> }>()

/** 私有索引批次与稳定断点同事务，跨重启仍只恢复相同固定输入。 */
export function snapshotBatchCursor(database: DatabaseSync, batch: Pick<Batch, 'job' | 'phase'>): string | undefined {
  const row = queries(database).read.get(batch.job, batch.phase)
  return row ? String(row.cursor) : undefined
}

/** 当前线程拥有整笔短事务，不在 SQL 事务内让出事件循环。 */
export function commitSnapshotBatch(database: DatabaseSync, batch: Batch, action: () => void): void {
  snapshotTracePhase(`batch.${batch.phase}`, () => commitTimed(database, batch, action))
}

/** 锁等待与真正提交/回滚退出分开测量，不把事务请求时间当成持锁时间。 */
function commitTimed(database: DatabaseSync, batch: Batch, action: () => void): void {
  batch.budget.requireRemaining(batch.job)
  snapshotTraceWork({ rows: batch.rows, bytes: batch.bytes })
  const requested = process.hrtime.bigint()
  database.exec('BEGIN IMMEDIATE')
  const acquired = process.hrtime.bigint()
  snapshotTraceSql({ lockNanos: acquired - requested })
  try {
    action()
    queries(database).write.run(batch.job, batch.phase, batch.cursor)
    database.exec('COMMIT')
  } catch (error) {
    // 失败时数据与断点共同回滚，已完成批次保持可恢复。
    database.exec('ROLLBACK')
    throw error
  } finally {
    snapshotTraceSql({ transactionNanos: process.hrtime.bigint() - acquired })
  }
}

/** 只保留固定形状的两个小型语句，数据与断点仍由实际事务拥有。 */
function queries(database: DatabaseSync) {
  let cached = statements.get(database)
  if (!cached) {
    cached = { read: database.prepare('SELECT cursor FROM sync_snapshot_batch_progress WHERE job_id=? AND phase=?'),
      write: database.prepare('INSERT OR REPLACE INTO sync_snapshot_batch_progress VALUES(?,?,?)') }
    statements.set(database, cached)
  }
  return cached
}
