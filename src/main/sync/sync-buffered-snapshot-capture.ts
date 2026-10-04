import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SnapshotWriterStorage } from './sync-snapshot-page-writer'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { PreparedSnapshotRecord } from './sync-snapshot-record-persistence'
import { sameCapturedRecord } from './sync-snapshot-record-persistence'
import { commitSnapshotBatch } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'

interface Entry { snapshotBundleId: string; lane: string; record: SyncSnapshotRecord }

/** 私有 CAPTURING 记录先准备 DTO 再批量提交，不能逐字段 fsync。 */
export class SyncBufferedSnapshotCapture implements SnapshotWriterStorage {
  private pending: PreparedSnapshotRecord[] = []
  private readonly pendingRecords = new Map<string, PreparedSnapshotRecord>()
  private readonly existing: ReturnType<DatabaseSync['prepare']>
  private bytes = 0
  constructor(private readonly database: DatabaseSync, private readonly store: SyncPagedSnapshotStore) {
    this.existing = database.prepare(`SELECT content_hash,record_json,(SELECT source_key FROM sync_snapshot_source_link l
      WHERE l.snapshot_bundle_id=r.snapshot_bundle_id AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key) AS source_key FROM sync_paged_snapshot_record r
      WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind=? AND record_key=?`)
  }

  /** 返回值表示进入私有队列，FROZEN 前必须 flush 并使用真实索引计数。 */
  captureRecord(input: Entry): boolean {
    if (this.store.find(input.snapshotBundleId)?.state !== 'CAPTURING') throw new Error('SNAPSHOT_CONFLICT: capture requires private staging')
    return this.enqueue(input, true)
  }

  /** 私有行只准备紧凑事实；重复身份核对完整内容，正式输出仍比较完整承诺。 */
  private enqueue(input: Entry, frozen = false): boolean {
    snapshotCheckpoint()
    const prepared = this.store.prepareRecord(input, frozen)
    const identity = JSON.stringify([input.lane, input.record.kind, input.record.key])
    const queued = this.pendingRecords.get(identity)
    const old = queued ? { content_hash: queued.hash, record_json: queued.stored, source_key: queued.source.key } : this.existing
      .get(input.snapshotBundleId, input.lane, input.record.kind, input.record.key)
    if (old !== undefined) {
      const equal = frozen ? sameCapturedRecord(String(old.record_json), prepared.stored) : old.content_hash === prepared.hash
      if (!equal || (frozen && prepared.source.key && old.source_key !== prepared.source.key))
        throw new Error('SNAPSHOT_CORRUPTED: conflicting buffered record')
      return false
    }
    const size = Buffer.byteLength(prepared.stored) + Buffer.byteLength(prepared.source.encoded ?? '')
    if (this.pending.length && (this.pending.length === BATCH_ROWS || this.bytes + size > BATCH_BYTES)) this.flushCapture()
    this.pending.push(prepared); this.pendingRecords.set(identity, prepared); this.bytes += size
    if (this.bytes >= BATCH_BYTES) this.flushCapture()
    return true
  }

  /** SQL 数据成功提交后才释放 DTO，事务中不反向读取冻结 Reader。 */
  flushCapture(): void {
    if (!this.pending.length) return
    const last = this.pending.at(-1)!
    commitSnapshotBatch(this.database, { job: last.input.snapshotBundleId, phase: 'capture-records', cursor: last.input.record.key,
      rows: this.pending.length, bytes: this.bytes, budget: this.store.lifecycle.budget },
      () => { for (const entry of this.pending) { snapshotCheckpoint(); this.store.writePrepared(entry) } })
    this.pending = []; this.pendingRecords.clear(); this.bytes = 0
  }

  /** 非延迟输出沿用正式存储契约。 */
  writeRecord(input: Entry): boolean { return this.enqueue(input) }
  writePage(input: Parameters<SyncPagedSnapshotStore['writePage']>[0]): string { return this.store.writePage(input) }
}

/** 捕获准备队列的标准记录批次。 */
const BATCH_ROWS = 256
/** 每批实际 UTF-8 DTO 字节预算，单个合法大字段独占一批。 */
const BATCH_BYTES = 2 * 1024 * 1024
