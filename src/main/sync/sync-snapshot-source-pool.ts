import type { DatabaseSync } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { canonicalJsonValue, sha256Hex } from './sync-operation-canonicalizer'
import { decodeSnapshotRecord } from './sync-snapshot-records'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import { snapshotRecordFragments, prepareSnapshotRecordEncoding } from './sync-snapshot-record-fragments'

interface Entry { readonly bundle: string; readonly lane: string; readonly record: SyncSnapshotRecord }
export interface CanonicalSnapshotSource { readonly key: string; readonly encoded: string }
export interface PreparedSnapshotSource {
  readonly input: Entry
  readonly compact: SyncSnapshotRecord
  readonly key?: string
  readonly encoded?: string
}

/** 来源池只改变本地派生表示，网络页和原始签名对象不被重写。 */
export class SyncSnapshotSourcePool {
  /** 只缓存紧邻的一个完整来源，命中必须逐字节相同。 */
  private recent?: { raw: string; encoded: string; key: string }
  private readonly statements: Readonly<Record<'read' | 'remove' | 'conflict' | 'insert' | 'link' | 'unpack' | 'key', ReturnType<DatabaseSync['prepare']>>>
  private outputSource?: { key: string; revision: number; encoded: string }
  constructor(private readonly database: DatabaseSync) {
    // 来源和字段链接的固定 SQL 随连接复用，最后一次绑定不会扩张成整库原生副本。
    this.statements = {
      read: database.prepare('SELECT envelope_json FROM sync_snapshot_source WHERE source_key=?'),
      remove: database.prepare('DELETE FROM sync_snapshot_source_link WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=?'),
      conflict: database.prepare('SELECT 1 FROM sync_snapshot_source WHERE source_key=? AND envelope_json<>?'),
      insert: database.prepare('INSERT OR IGNORE INTO sync_snapshot_source VALUES(?,?)'),
      link: database.prepare('INSERT OR REPLACE INTO sync_snapshot_source_link VALUES(?,?,?,?)'),
      key: database.prepare(`SELECT source_key,COALESCE(v.revision,0) AS revision FROM sync_snapshot_source_link l JOIN sync_paged_snapshot_record r
        ON l.snapshot_bundle_id=r.snapshot_bundle_id AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key
        LEFT JOIN sync_snapshot_revision v ON v.bundle_id=r.snapshot_bundle_id WHERE r.rowid=? AND r.kind='FIELD_VERSION'`),
      unpack: database.prepare(`SELECT l.source_key,s.envelope_json FROM sync_paged_snapshot_record r
        JOIN sync_snapshot_source_link l ON l.snapshot_bundle_id=r.snapshot_bundle_id
          AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key
        LEFT JOIN sync_snapshot_source s ON s.source_key=l.source_key WHERE r.rowid=?`)
    }
  }

  /** 读取来源必须验证池键与完整规范签名对象相符，损坏不退化为无来源。 */
  read(key: string): SyncOperationEnvelope {
    const raw = this.statements.read.get(key)
    if (!raw || sha256Hex(String(raw.envelope_json)) !== key) throw new Error('SNAPSHOT_CORRUPTED: signed source digest differs')
    return JSON.parse(String(raw.envelope_json)) as SyncOperationEnvelope
  }

  /** 完整签名对象的摘要是池键，operationId 相同不能替代完整内容比较。 */
  pack(input: Entry): SyncSnapshotRecord {
    const prepared = this.prepare(input)
    this.persist(prepared)
    return prepared.compact
  }

  /** 规范化与摘要在 DTO 准备阶段完成，写事务只接收已准备列。 */
  prepare(input: Entry): PreparedSnapshotSource {
    const source = input.record.value.sourceOperation
    if (source == null) return { input, compact: input.record }
    const raw = JSON.stringify(source)
    const encoded = this.recent?.raw === raw ? this.recent.encoded : canonicalJsonValue(source)
    const key = this.recent?.raw === raw ? this.recent.key : sha256Hex(encoded)
    this.recent = { raw, encoded, key }
    const { sourceOperation: _source, ...value } = input.record.value
    return { input, compact: { ...input.record, value }, key, encoded }
  }

  /** 来源分组已生成完整规范材料，字段只关联该材料，不重新序列化完整操作。 */
  prepareCanonical(input: Entry, source?: CanonicalSnapshotSource): PreparedSnapshotSource {
    if (!source) return { input, compact: input.record }
    const { sourceOperation: _source, ...value } = input.record.value
    return { input, compact: { ...input.record, value }, key: source?.key, encoded: source?.encoded }
  }

  /** 恢复旧私有来源时读取真实完整字节并核对摘要，不能默默移除已有签名。 */
  readCanonical(key: string): CanonicalSnapshotSource {
    const row = this.statements.read.get(key), encoded = row && String(row.envelope_json)
    if (encoded == null || sha256Hex(encoded) !== key) throw new Error('SNAPSHOT_CORRUPTED: signed source digest differs')
    return { key, encoded }
  }

  /** 来源对象与字段链接由调用方的同一短事务提交，禁止暴露半条引用。 */
  persist(prepared: PreparedSnapshotSource): void {
    const { key, encoded } = prepared
    if (key == null || encoded == null) {
      this.link(prepared)
      return
    }
    const conflict = this.statements.conflict.get(key, encoded)
    if (conflict) throw new Error('SNAPSHOT_CORRUPTED: source digest names another envelope')
    this.statements.insert.run(key, encoded)
    this.link(prepared)
  }

  /** 同一分组的完整来源已经提交后只写轻量链接，调用方必须与记录同事务提交。 */
  link(prepared: PreparedSnapshotSource): void {
    const { input, key } = prepared
    if (key == null) this.statements.remove.run(input.bundle, input.lane, input.record.key)
    else this.statements.link.run(input.bundle, input.lane, input.record.key, key)
  }

  /** 只有输出或完整证据读取才展开来源；旧版内嵌字段保持原有语义。 */
  unpack(rowId: number, raw: string): SyncSnapshotRecord {
    const record = decodeSnapshotRecord(raw)
    if (record.kind !== 'FIELD_VERSION') return record
    const source = this.statements.unpack.get(rowId)
    if (!source) return record
    if (source.envelope_json == null) throw new Error('SNAPSHOT_CORRUPTED: field source is missing')
    return { ...record, value: { ...record.value, sourceOperation: JSON.parse(String(source.envelope_json)) } }
  }

  /** 完整来源片段直接交给页面编码器，既有排序和签名字节不经整条字符串拼接。 */
  *fragments(rowId: number, raw: string): Generator<string> {
    yield* snapshotRecordFragments({ record: decodeSnapshotRecord(raw), source: this.outputMaterial(rowId) })
  }

  /** 同一紧凑编码直接生成落盘文本和完整承诺，规范化不再分配一份完整 wire 文本。 */
  encoding(rowId: number, record: SyncSnapshotRecord): { hash: string; stored: string } {
    return prepareSnapshotRecordEncoding({ record, source: this.outputMaterial(rowId) })
  }

  /** 当前派生修订一致时复用一个来源片段；变化后重新检查真实完整摘要。 */
  private outputMaterial(rowId: number): string | undefined {
    const link = this.statements.key.get(rowId)
    if (!link) return undefined
    const key = String(link.source_key), revision = Number(link.revision)
    if (this.outputSource?.key !== key || this.outputSource.revision !== revision) {
      const row = this.statements.read.get(key), encoded = row && String(row.envelope_json)
      if (encoded == null || sha256Hex(encoded) !== key) throw new Error('SNAPSHOT_CORRUPTED: signed source digest differs')
      this.outputSource = { key, revision, encoded }
    }
    return this.outputSource.encoded
  }

}

/** 池键承诺完整签名对象；同一分组只进行一次规范编码和摘要。 */
export function canonicalSnapshotSource(source: SyncOperationEnvelope): CanonicalSnapshotSource {
  const encoded = canonicalJsonValue(source)
  return { encoded, key: sha256Hex(encoded) }
}
