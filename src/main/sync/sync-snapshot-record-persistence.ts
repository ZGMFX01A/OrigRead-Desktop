import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { prepareSnapshotRecordEncoding } from './sync-snapshot-record-fragments'
import { validateSnapshotRecord } from './sync-snapshot-record-validation'
import { validateSnapshotRecordLane } from './sync-snapshot-record-lane'
import { SyncSnapshotSourcePool, type PreparedSnapshotSource } from './sync-snapshot-source-pool'
import { prepareSnapshotFacts, type PreparedSnapshotFacts } from './sync-snapshot-derived-facts'
import type { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'
import { canonicalJson } from './sync-operation-canonicalizer'

interface RecordInput { readonly snapshotBundleId: string; readonly lane: string; readonly record: SyncSnapshotRecord }
export interface PreparedSnapshotRecord {
  readonly input: RecordInput
  readonly hash: string
  readonly stored: string
  readonly source: PreparedSnapshotSource
  readonly facts: PreparedSnapshotFacts
  readonly columns: readonly SQLInputValue[]
}

/** 完整承诺与紧凑表示在事务外准备，事务内仅比较索引及执行 SQL。 */
export class SyncSnapshotRecordPersistence {
  private readonly existing: ReturnType<DatabaseSync['prepare']>
  private readonly insert: ReturnType<DatabaseSync['prepare']>
  constructor(private readonly database: DatabaseSync, private readonly sources: SyncSnapshotSourcePool,
    private readonly derived: SyncSnapshotDerivedIndex) {
    // 固定批处理复用原生语句，避免每条大文本的绑定副本滞留到 JavaScript GC。
    this.existing = database.prepare(`SELECT content_hash,record_json,(SELECT source_key FROM sync_snapshot_source_link l
      WHERE l.snapshot_bundle_id=r.snapshot_bundle_id AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key) AS source_key FROM sync_paged_snapshot_record r
      WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind=? AND record_key=?`)
    this.insert = database.prepare('INSERT INTO sync_paged_snapshot_record VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  }

  /** 捕获私有行可暂缺摘要；发布前仍须规范化，不能把空摘要当作已验证。 */
  prepare(input: RecordInput, frozen = false): PreparedSnapshotRecord {
    validateSnapshotRecord(input.record)
    validateSnapshotRecordLane(input.lane, input.record)
    const source = this.sources.prepare({ bundle: input.snapshotBundleId, lane: input.lane, record: input.record })
    // 同一次紧凑编码用于落盘和完整承诺；来源片段只进入摘要，不复制到字段全文。
    const { hash, stored } = frozen ? { hash: '', stored: JSON.stringify(source.compact) }
      : prepareSnapshotRecordEncoding({ record: source.compact, source: source.encoded })
    const value = input.record.value
    const columns = [input.snapshotBundleId, input.lane, input.record.kind, input.record.key, hash,
      String(value.entityType ?? value.ownerEntityType ?? ''), String(value.entitySyncId ?? value.ownerEntitySyncId ?? ''),
      Number(value.entityGeneration ?? value.generation ?? value.ownerEntityGeneration ?? 0),
      String(value.fieldId ?? ''), String(value.hash ?? ''), stored]
    return { input, hash, stored, source, columns, facts: prepareSnapshotFacts({ bundle: input.snapshotBundleId, lane: input.lane, record: input.record }) }
  }

  /** 来源、记录与调用方游标必须共同提交；冲突不降级为忽略。 */
  write(prepared: PreparedSnapshotRecord): boolean {
    if (this.database.isTransaction) return this.writeLocked(prepared)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const inserted = this.writeLocked(prepared)
      this.database.exec('COMMIT')
      return inserted
    } catch (error) {
      // 嵌入式单条写入也必须保持记录、来源和轻索引原子一致。
      this.database.exec('ROLLBACK'); throw error
    }
  }

  /** 调用方已有批次时沿用该事务，绝不提前提交持久恢复断点。 */
  private writeLocked(prepared: PreparedSnapshotRecord): boolean {
    const { input, hash, stored } = prepared
    const existing = this.existing.get(input.snapshotBundleId, input.lane, input.record.kind, input.record.key)
    if (existing) {
      if (!hash && prepared.source.key && existing.source_key !== prepared.source.key) throw new Error('DOT_COLLISION: captured field sources differ')
      if (hash ? existing.content_hash === hash : sameCapturedRecord(String(existing.record_json), stored)) return false
      throw new Error(`SNAPSHOT_CORRUPTED: conflicting Snapshot record key ${input.lane}/${input.record.kind}/${input.record.key}`)
    }
    this.sources.persist(prepared.source)
    this.insert.run(...prepared.columns)
    this.derived.write(prepared.facts)
    return true
  }
}

/** 私有空摘要不能作为去重承诺；只在文本不同的重复键上比较完整规范内容。 */
export function sameCapturedRecord(first: string, second: string): boolean {
  return first === second || canonicalJson(first) === canonicalJson(second)
}
