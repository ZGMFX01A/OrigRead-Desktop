import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest, SyncSnapshotLanePages } from '../../shared/sync-paged-snapshot'
import type { PreparedSnapshotRecord } from './sync-snapshot-record-persistence'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { decodeSnapshotRecord, snapshotRecordLines } from './sync-snapshot-records'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { snapshotTraceWork } from './sync-snapshot-trace'
import { clearSnapshotIndex } from './sync-snapshot-content-cleanup'

interface Entry { position: number; record: PreparedSnapshotRecord; bytes: number }

/** 未完成索引留在 INDEXING，固定页转换与恢复游标以短事务原子提交。 */
export class SyncSnapshotReceivedIndex {
  constructor(private readonly database: DatabaseSync, private readonly store: SyncPagedSnapshotStore) {}

  /** 只有同一固定 root 的 INDEXING 可以沿用断点，失效的 VERIFIED 必须重新建立索引。 */
  build(manifest: SyncPagedSnapshotManifest): void {
    this.initialize(manifest)
    for (const lane of manifest.lanes) this.indexLane(manifest, lane)
  }

  /** 先提交不可安装状态，再有界清理；CLEARING/DONE 回执区分清理中断与真正可续读。 */
  private initialize(manifest: SyncPagedSnapshotManifest): void {
    const progress = { job: manifest.snapshotBundleId, phase: `index-init:v2:${manifest.rootHash}`, budget: this.store.lifecycle.budget }
    if (this.store.find(manifest.snapshotBundleId)?.state === 'INDEXING' && snapshotBatchCursor(this.database, progress) === 'DONE') return
    commitSnapshotBatch(this.database, { ...progress, cursor: 'CLEARING' }, () => {
      this.database.prepare("UPDATE sync_paged_snapshot SET state='INDEXING' WHERE snapshot_bundle_id=?").run(manifest.snapshotBundleId)
    })
    clearSnapshotIndex(this.database, manifest.snapshotBundleId)
    commitSnapshotBatch(this.database, { ...progress, cursor: 'DONE' }, () => {
      this.database.prepare("DELETE FROM sync_snapshot_batch_progress WHERE job_id=? AND phase LIKE 'index:%'").run(manifest.snapshotBundleId)
    })
  }

  /** 一次仅准备有界 DTO，线性位置绑定固定页面而非可能变化的数据库 rowid。 */
  private indexLane(manifest: SyncPagedSnapshotManifest, lane: SyncSnapshotLanePages): void {
    const progress = { job: manifest.snapshotBundleId, phase: `index:v2:${manifest.rootHash}:${lane.replicationLaneId}`,
      budget: this.store.lifecycle.budget }
    const after = Number(snapshotBatchCursor(this.database, progress) ?? 0)
    let pending: Entry[] = [], bytes = 0, position = 0
    const pages = this.store.pageChunks({ bundle: manifest.snapshotBundleId, lane: lane.replicationLaneId, count: lane.pageHashes.length })
    const commit = () => commitSnapshotBatch(this.database, { ...progress, cursor: String(pending.at(-1)!.position) }, () => {
      for (const entry of pending) {
        snapshotCheckpoint()
        if (!this.store.writePrepared(entry.record)) {
          throw new Error('SNAPSHOT_CORRUPTED: duplicate Snapshot business record')
        }
        snapshotTraceWork({ rows: 1, bytes: entry.bytes })
      }
    })
    for (const line of snapshotRecordLines(pages)) {
      snapshotCheckpoint()
      if (++position <= after) continue
      const size = Buffer.byteLength(line)
      if (pending.length && (pending.length === BATCH_ROWS || bytes + size > BATCH_BYTES)) {
        commit(); pending = []; bytes = 0
      }
      const record = this.store.prepareRecord({ snapshotBundleId: manifest.snapshotBundleId,
        lane: lane.replicationLaneId, record: decodeSnapshotRecord(line) })
      pending.push({ position, record, bytes: size }); bytes += size
    }
    if (pending.length) commit()
    if (position !== lane.recordCount) throw new Error('SNAPSHOT_CORRUPTED: Snapshot record count mismatch')
  }
}

/** 原生索引提交的标准记录数量。 */
const BATCH_ROWS = 256
/** 标准 DTO 批次字节预算，单个合法大记录独占提交。 */
const BATCH_BYTES = 2 * 1024 * 1024
