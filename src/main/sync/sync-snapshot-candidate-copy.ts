import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { PreparedSnapshotRecord } from './sync-snapshot-record-persistence'
import type { SyncSnapshotSourcePool } from './sync-snapshot-source-pool'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import type { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'

export interface SnapshotCandidateCopyInput { source: string; target: string; lane: string;
  entityType: string; entitySyncId: string; generation: number }
interface Key { rowid: number; record_key: string; content_hash: string; bytes: number; source_bytes: number }
interface Plan { key: Key; conflict: boolean; bytes: number }
interface Prepared { key: Key; bytes: number; conflict?: PreparedSnapshotRecord }
/** 轻量身份批次上限，单条合法大记录可以独占批次。 */
const BATCH_ROWS = 256
/** 复制和冲突 DTO 每批提交的字节预算。 */
const BATCH_BYTES = 2 * 1024 * 1024

/** 固定查询随 Page 连接复用，逐实体复制不产生逐字段原生语句及来源池。 */
export class SyncSnapshotCandidateCopier {
  private readonly queries: Readonly<Record<'keys' | 'existing' | 'read' | 'remove' | 'copy' | 'link', ReturnType<DatabaseSync['prepare']>>>
  constructor(private readonly input: { database: DatabaseSync; store: SyncPagedSnapshotStore; sources: SyncSnapshotSourcePool; derived: SyncSnapshotDerivedIndex }) {
    const database = input.database
    this.queries = {
      keys: database.prepare(`SELECT rowid,record_key,content_hash,length(CAST(record_json AS BLOB)) AS bytes,
        COALESCE((SELECT length(CAST(s.envelope_json AS BLOB)) FROM sync_snapshot_source_link l JOIN sync_snapshot_source s ON s.source_key=l.source_key
          WHERE l.snapshot_bundle_id=r.snapshot_bundle_id AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key),0) AS source_bytes
        FROM sync_paged_snapshot_record r WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind='FIELD_VERSION'
        AND entity_type=? AND entity_sync_id=? AND generation=? AND record_key>? ORDER BY record_key LIMIT ${BATCH_ROWS}`),
      existing: database.prepare(`SELECT content_hash,length(CAST(record_json AS BLOB))+
        COALESCE((SELECT length(CAST(s.envelope_json AS BLOB)) FROM sync_snapshot_source_link l JOIN sync_snapshot_source s ON s.source_key=l.source_key
          WHERE l.snapshot_bundle_id=r.snapshot_bundle_id AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key),0) AS bytes
        FROM sync_paged_snapshot_record r WHERE snapshot_bundle_id=?
        AND replication_lane_id=? AND kind='FIELD_VERSION' AND record_key=?`),
      read: database.prepare('SELECT record_json FROM sync_paged_snapshot_record WHERE rowid=?'),
      remove: database.prepare(`DELETE FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND replication_lane_id=?
        AND kind='FIELD_VERSION' AND record_key=?`),
      copy: database.prepare(`INSERT OR IGNORE INTO sync_paged_snapshot_record SELECT ?,replication_lane_id,kind,record_key,content_hash,
        entity_type,entity_sync_id,generation,field_id,blob_hash,record_json FROM sync_paged_snapshot_record WHERE rowid=?`),
      link: database.prepare(`INSERT OR IGNORE INTO sync_snapshot_source_link SELECT ?,replication_lane_id,record_key,source_key
        FROM sync_snapshot_source_link WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=?`)
    }
  }

  /** SQL 原列复制与来源链接原子提交；冲突 JSON 只在事务外准备。 */
  copy(input: SnapshotCandidateCopyInput): void {
    const { database, store } = this.input
    const phase = `candidates:${JSON.stringify(input)}`
    let after = snapshotBatchCursor(database, { job: input.target, phase }) ?? ''
    for (;;) {
      const keys = this.queries.keys.all(input.source, input.lane, input.entityType,
        input.entitySyncId, input.generation, after) as unknown as Key[]
      if (!keys.length) return
      let pending: Prepared[] = [], bytes = 0
      const commit = () => commitSnapshotBatch(database, { job: input.target, phase,
        cursor: pending.at(-1)!.key.record_key, rows: pending.length, bytes, budget: store.lifecycle.budget },
        () => { for (const entry of pending) this.writeCandidate({ input, entry }) })
      for (const key of keys) {
        const plan = this.preflight({ input, key })
        if (pending.length && bytes + plan.bytes > BATCH_BYTES) { commit(); pending = []; bytes = 0 }
        pending.push(this.prepareCandidate({ input, plan })); bytes += plan.bytes
      }
      if (pending.length) commit()
      after = keys.at(-1)!.record_key
    }
  }

  /** 只读长度与承诺先决定批次，冲突源和目标的完整待解码字节均进入预算。 */
  private preflight(request: { input: SnapshotCandidateCopyInput; key: Key }): Plan {
    snapshotCheckpoint()
    const { input, key } = request
    const row = this.queries.existing.get(input.target, input.lane, key.record_key)
    const conflict = !!row && row.content_hash !== key.content_hash
    return { key, conflict, bytes: conflict ? key.bytes + Number(key.source_bytes) + Number(row!.bytes) : key.bytes }
  }

  /** 大单条冲突独占批次；同键不同承诺仍使用原有完整来源合并规则。 */
  private prepareCandidate(request: { input: SnapshotCandidateCopyInput; plan: Plan }): Prepared {
    snapshotCheckpoint()
    const { input, plan } = request, { key, bytes } = plan
    if (!plan.conflict) return { key, bytes }
    const raw = this.queries.read.get(key.rowid)!
    const record = this.input.sources.unpack(key.rowid, String(raw.record_json))
    return { key, bytes, conflict: this.input.store.prepareMergedField({ snapshotBundleId: input.target, lane: input.lane, record }) }
  }

  /** 一个事务拥有记录、来源链接和稳定游标，重启不会看到断开的引用。 */
  private writeCandidate(request: { input: SnapshotCandidateCopyInput; entry: Prepared }): void {
    snapshotCheckpoint()
    const { input, entry } = request
    if (entry.conflict) {
      this.queries.remove.run(input.target, input.lane, entry.key.record_key)
      this.input.store.writePrepared(entry.conflict)
      return
    }
    this.queries.copy.run(input.target, entry.key.rowid)
    this.queries.link.run(input.target, input.source, input.lane, entry.key.record_key)
    this.input.derived.copy({ source: input.source, target: input.target, lane: input.lane, key: entry.key.record_key })
  }
}
