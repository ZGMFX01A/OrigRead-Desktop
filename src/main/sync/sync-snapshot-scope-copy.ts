import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'
import { canonicalJson } from './sync-operation-canonicalizer'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'

export interface SnapshotScopeCopy { sourceBundleId: string; manifest: SyncPagedSnapshotManifest; now: number }
interface RecordKey { kind: string; record_key: string; bytes: number }
/** 轻量身份页的上限，正文由 SQLite 原列复制。 */
const BATCH_ROWS = 256
/** 原始页和记录复制均按两 MiB 提交；大单条独占一批。 */
const BATCH_BYTES = 2 * 1024 * 1024

/** 收窄只改变清单身份，保留原始页面、来源和派生事实的精确对应。 */
export class SyncSnapshotScopeCopier {
  private readonly queries: Readonly<Record<'pages' | 'page' | 'records' | 'record' | 'link', ReturnType<DatabaseSync['prepare']>>>
  constructor(private readonly input: { database: DatabaseSync; store: SyncPagedSnapshotStore; derived: SyncSnapshotDerivedIndex }) {
    const db = input.database
    this.queries = {
      pages: db.prepare(`SELECT page_index,length(bytes) AS size FROM sync_paged_snapshot_page
        WHERE snapshot_bundle_id=? AND replication_lane_id=? AND page_index>? ORDER BY page_index LIMIT ${BATCH_ROWS}`),
      page: db.prepare(`INSERT OR IGNORE INTO sync_paged_snapshot_page SELECT ?,replication_lane_id,page_index,content_hash,bytes
        FROM sync_paged_snapshot_page WHERE snapshot_bundle_id=? AND replication_lane_id=? AND page_index=?`),
      records: db.prepare(`SELECT kind,record_key,length(CAST(record_json AS BLOB)) AS bytes FROM sync_paged_snapshot_record
        WHERE snapshot_bundle_id=? AND replication_lane_id=? AND (kind,record_key)>(?,?) ORDER BY kind,record_key LIMIT ${BATCH_ROWS}`),
      record: db.prepare(`INSERT OR IGNORE INTO sync_paged_snapshot_record SELECT ?,replication_lane_id,kind,record_key,content_hash,
        entity_type,entity_sync_id,generation,field_id,blob_hash,record_json FROM sync_paged_snapshot_record
        WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind=? AND record_key=?`),
      link: db.prepare(`INSERT OR IGNORE INTO sync_snapshot_source_link SELECT ?,replication_lane_id,record_key,source_key
        FROM sync_snapshot_source_link WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=?`)
    }
  }

  /** 固定源受持久依赖保护，所有复制断点只属于这一清单身份。 */
  copy(request: SnapshotScopeCopy): void {
    const { store, derived } = this.input, target = request.manifest.snapshotBundleId
    const existing = store.find(target)
    if (existing?.state === 'VERIFIED') {
      if (existing.manifestJson !== canonicalJson(JSON.stringify(request.manifest))) throw new Error('SNAPSHOT_CONFLICT: scope ID names another manifest')
      return
    }
    if (store.find(request.sourceBundleId)?.state !== 'VERIFIED') throw new Error('SNAPSHOT_CORRUPTED: scope source is not verified')
    derived.requireComplete(request.sourceBundleId)
    store.lifecycle.protectInputs(target, new Set([request.sourceBundleId]))
    store.lifecycle.budget.reserve(target, 0)
    store.beginReceive(request.manifest, request.now)
    for (const lane of request.manifest.lanes) {
      this.pages({ source: request.sourceBundleId, target, lane: lane.replicationLaneId })
      this.records({ source: request.sourceBundleId, target, lane: lane.replicationLaneId })
    }
    store.publish(request.manifest, request.now)
  }

  /** Recovery 私有索引原列复制到输出身份，页面在锁外按既有顺序编码。 */
  copyIndex(input: { source: string; target: string; lanes: readonly string[] }): void {
    this.input.derived.requireComplete(input.source)
    for (const lane of input.lanes) this.records({ source: input.source, target: input.target, lane })
  }

  /** 仅完整页及其页号一起提交，重启从上一完整页继续。 */
  private pages(scope: { source: string; target: string; lane: string }): void {
    const phase = `scope.pages:${scope.source}:${scope.lane}`
    let after = Number(snapshotBatchCursor(this.input.database, { job: scope.target, phase }) ?? -1)
    for (;;) {
      const keys = this.queries.pages.all(scope.source, scope.lane, after)
      if (!keys.length) return
      let pending: typeof keys = [], bytes = 0
      const commit = () => this.commit({ job: scope.target, phase, cursor: String(pending.at(-1)!.page_index), rows: pending.length, bytes }, () => {
        for (const key of pending) { snapshotCheckpoint(); this.queries.page.run(scope.target, scope.source, scope.lane, key.page_index!) }
      })
      for (const key of keys) {
        if (pending.length && bytes + Number(key.size) > BATCH_BYTES) { commit(); pending = []; bytes = 0 }
        pending.push(key); bytes += Number(key.size)
      }
      if (pending.length) commit()
      after = Number(keys.at(-1)!.page_index)
    }
  }

  /** 原记录、来源链接、字段承诺和关系元数据属于同一批事务。 */
  private records(scope: { source: string; target: string; lane: string }): void {
    const phase = `scope.records:${scope.source}:${scope.lane}`
    let after = JSON.parse(snapshotBatchCursor(this.input.database, { job: scope.target, phase }) ?? '["",""]') as [string, string]
    for (;;) {
      const keys = this.queries.records.all(scope.source, scope.lane, ...after) as unknown as RecordKey[]
      if (!keys.length) return
      let pending: RecordKey[] = [], bytes = 0
      const commit = () => this.commit({ job: scope.target, phase, cursor: JSON.stringify([pending.at(-1)!.kind, pending.at(-1)!.record_key]), rows: pending.length, bytes },
        () => { for (const key of pending) this.write({ scope, key }) })
      for (const key of keys) {
        if (pending.length && bytes + key.bytes > BATCH_BYTES) { commit(); pending = []; bytes = 0 }
        pending.push(key); bytes += key.bytes
      }
      if (pending.length) commit()
      after = [keys.at(-1)!.kind, keys.at(-1)!.record_key]
    }
  }

  /** 容量扩张核对在事务前，提交时不读取文件或解码 JSON。 */
  private commit(batch: { job: string; phase: string; cursor: string; rows: number; bytes: number }, action: () => void): void {
    this.input.store.lifecycle.budget.requireRemaining(batch.job, batch.bytes)
    commitSnapshotBatch(this.input.database, { ...batch, budget: this.input.store.lifecycle.budget }, action)
  }

  /** 派生表复制沿用原始逻辑键，不重新编码历史值或签名。 */
  private write(request: { scope: { source: string; target: string; lane: string }; key: RecordKey }): void {
    snapshotCheckpoint()
    const { scope, key } = request
    this.queries.record.run(scope.target, scope.source, scope.lane, key.kind, key.record_key)
    this.queries.link.run(scope.target, scope.source, scope.lane, key.record_key)
    this.input.derived.copy({ ...scope, key: key.record_key })
  }
}
