import type { DatabaseSync } from 'node:sqlite'
import type { SyncSnapshotRecord, SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { snapshotTraceWork } from './sync-snapshot-trace'
import type { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'

interface Phase { manifest: SyncPagedSnapshotManifest; name: string; budget: SyncSnapshotResourceBudget }

/** DTO 准备在写事务外，数据与稳定记录游标在同一业务库短事务提交。 */
export function applySnapshotRecords(database: DatabaseSync, phase: Phase,
  input: { records: Iterable<SyncSnapshotRecord>; write(record: SyncSnapshotRecord): void }): void {
  const progress = { job: phase.manifest.snapshotBundleId, phase: `${phase.manifest.rootHash}:${phase.name}`, budget: phase.budget }
  const after = snapshotBatchCursor(database, progress) ?? ''
  // 恢复游标必须沿用 SQLite BINARY 的 UTF-8 顺序，不能用 JavaScript UTF-16 大小比较。
  const selected = (function* () { for (const record of input.records) if (Buffer.compare(Buffer.from(record.key), Buffer.from(after)) > 0) yield record })()
  for (const batch of batches(selected)) {
    snapshotCheckpoint()
    commitSnapshotBatch(database, { ...progress, cursor: batch.at(-1)!.key }, () => {
      for (const record of batch) {
        snapshotCheckpoint(); input.write(record)
        snapshotTraceWork({ rows: 1 })
      }
    })
  }
}

/** 无记录阶段也有同库断点，重试不会重复清理已经恢复的引用。 */
export function snapshotInstallOnce(database: DatabaseSync, phase: Phase, action: () => void): void {
  const progress = { job: phase.manifest.snapshotBundleId, phase: `${phase.manifest.rootHash}:${phase.name}`, budget: phase.budget }
  if (snapshotBatchCursor(database, progress) === 'DONE') return
  commitSnapshotBatch(database, { ...progress, cursor: 'DONE' }, action)
}

/** 单个合法大字段独占批次，其余 DTO 在触及字节或条数边界前结束。 */
function* batches(records: Iterable<SyncSnapshotRecord>): Generator<readonly SyncSnapshotRecord[]> {
  let batch: SyncSnapshotRecord[] = []
  let bytes = 0
  for (const record of records) {
    snapshotCheckpoint()
    const size = Buffer.byteLength(JSON.stringify(record))
    if (batch.length && (batch.length === BATCH_ROWS || bytes + size > BATCH_BYTES)) {
      yield batch
      batch = []; bytes = 0
    }
    batch.push(record); bytes += size
  }
  if (batch.length) yield batch
}

/** 每个写事务的实体/候选数量上限。 */
const BATCH_ROWS = 256
/** 每批已解码 DTO 的字节预算，大于该预算的单字段单独处理。 */
const BATCH_BYTES = 2 * 1024 * 1024
