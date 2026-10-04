import type { DatabaseSync } from 'node:sqlite'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import type { SyncSnapshotDerivedIndex } from './sync-snapshot-derived-index'
import type { SyncSnapshotResourceBudget } from './sync-snapshot-resource-budget'
import { canonicalSnapshotSource, type CanonicalSnapshotSource, type PreparedSnapshotSource,
  type SyncSnapshotSourcePool } from './sync-snapshot-source-pool'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { prepareSnapshotFacts, type PreparedSnapshotFacts } from './sync-snapshot-derived-facts'
import { prepareSnapshotRecordEncoding, snapshotRecordHash } from './sync-snapshot-record-fragments'
import { decodeSnapshotRecord } from './sync-snapshot-records'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { parseOperationVersionToken } from './sync-version-token'
import { snapshotTraceWork } from './sync-snapshot-trace'
import { validateSnapshotRecordLane } from './sync-snapshot-record-lane'

interface Dependencies { database: DatabaseSync; sources: SyncSnapshotSourcePool; derived: SyncSnapshotDerivedIndex; budget: SyncSnapshotResourceBudget }
export interface CapturedSourceInput { bundle: string; space: string; original: (token: string) => SyncOperationEnvelope | null }
interface Key { id: number; lane: string; token: string; key: string; sourceKey?: string; bytes: number }
interface Prepared { id: number; hash: string; stored?: string; source: PreparedSnapshotSource; facts?: PreparedSnapshotFacts; cursor: string; bytes: number }
/** 断点绑定轻字段来源关联算法，逻辑键与原始 bundle 一起持久化。 */
const PHASE = 'capture-sources:v1'
/** 来源读取只预取轻量业务键，不把整页正文搬进内存。 */
const BATCH_ROWS = 256
/** 实际紧凑记录及完整来源 UTF-8 预算，合法大单条独占批次。 */
const BATCH_BYTES = 2 * 1024 * 1024

/** 固定来源连接仍存活时按 token 分组，一份原操作只读取和规范编码一次。 */
export function associateCapturedSources(deps: Dependencies, input: CapturedSourceInput): void {
  const keys = deps.database.prepare(`SELECT r.rowid,f.replication_lane_id,f.version_token,f.record_key,l.source_key,length(CAST(r.record_json AS BLOB)) AS bytes
    FROM sync_snapshot_field_index f JOIN sync_paged_snapshot_record r ON r.snapshot_bundle_id=f.snapshot_bundle_id
      AND r.replication_lane_id=f.replication_lane_id AND r.record_key=f.record_key AND r.kind='FIELD_VERSION'
    LEFT JOIN sync_snapshot_source_link l ON l.snapshot_bundle_id=f.snapshot_bundle_id
      AND l.replication_lane_id=f.replication_lane_id AND l.record_key=f.record_key
    WHERE f.snapshot_bundle_id=? AND (f.replication_lane_id,f.version_token,f.record_key)>(?,?,?)
    ORDER BY f.replication_lane_id,f.version_token,f.record_key LIMIT ${BATCH_ROWS}`)
  const read = deps.database.prepare('SELECT record_json FROM sync_paged_snapshot_record WHERE rowid=?')
  const update = deps.database.prepare('UPDATE sync_paged_snapshot_record SET record_json=?,content_hash=? WHERE rowid=?')
  const hashOnly = deps.database.prepare('UPDATE sync_paged_snapshot_record SET content_hash=? WHERE rowid=?')
  const grouping = new CapturedSourceGrouping(input)
  let after: string[] = JSON.parse(snapshotBatchCursor(deps.database, { job: input.bundle, phase: PHASE }) ?? '["","",""]')
  let persistedSource: string | undefined
  for (;;) {
    snapshotCheckpoint()
    const rows = keys.all(input.bundle, ...after)
    if (!rows.length) return
    const batch = prepareBatch(rows.map(row => ({ id: Number(row.rowid), lane: String(row.replication_lane_id),
      token: String(row.version_token), key: String(row.record_key), bytes: Number(row.bytes),
      sourceKey: row.source_key == null ? undefined : String(row.source_key) })), {
        size: key => key.bytes + Buffer.byteLength(grouping.material(key, key.sourceKey ? () => deps.sources.readCanonical(key.sourceKey!) : undefined)?.encoded ?? ''),
        prepare: key => prepareField({ deps, input, grouping, key, raw: String(read.get(key.id)!.record_json) }) })
    const bytes = batch.reduce((sum, row) => sum + row.bytes, 0)
    deps.budget.requireRemaining(input.bundle, bytes)
    let committedSource = persistedSource
    commitSnapshotBatch(deps.database, { job: input.bundle, phase: PHASE, cursor: batch.at(-1)!.cursor,
      rows: batch.length, bytes, budget: deps.budget }, () => {
      for (const row of batch) {
        snapshotCheckpoint()
        if (row.source.key && row.source.key !== committedSource) deps.sources.persist(row.source)
        else deps.sources.link(row.source)
        committedSource = row.source.key
        if (row.stored === undefined) hashOnly.run(row.hash, row.id)
        else { update.run(row.stored, row.hash, row.id); deps.derived.write(row.facts!) }
      }
    })
    persistedSource = committedSource
    after = JSON.parse(batch.at(-1)!.cursor)
  }
}

/** 只准备本次提交的 DTO；达到字节预算后不继续解码后续记录。 */
function prepareBatch(keys: readonly Key[], operations: { size: (key: Key) => number; prepare: (key: Key) => Prepared }): Prepared[] {
  const result: Prepared[] = []
  let bytes = 0
  for (const key of keys) {
    snapshotCheckpoint()
    const size = operations.size(key)
    if (result.length && bytes + size > BATCH_BYTES) break
    const row = operations.prepare(key)
    result.push(row); bytes += row.bytes
    if (bytes >= BATCH_BYTES) break
  }
  return result
}

/** 字段全文只解码当前一条；已有来源冲突不能被新的关联结果覆盖。 */
function prepareField(context: { deps: Dependencies; input: CapturedSourceInput; grouping: CapturedSourceGrouping; key: Key; raw: string }): Prepared {
  const { deps, input, grouping, key } = context, record = decodeSnapshotRecord(context.raw)
  validateSnapshotRecordLane(key.lane, record)
  if (record.key !== key.key || record.value.versionToken !== key.token) throw new Error('SNAPSHOT_CORRUPTED: field index differs from captured fact')
  const inline = deps.sources.prepare({ bundle: input.bundle, lane: key.lane, record })
  if (key.sourceKey && inline.key && key.sourceKey !== inline.key) throw new Error('SNAPSHOT_CORRUPTED: retained field sources differ')
  const retained = key.sourceKey ?? inline.key
  const material = grouping.material(key, retained ? () => inline.key === retained && inline.encoded
    ? { key: retained, encoded: inline.encoded } : deps.sources.readCanonical(retained) : undefined)
  if (retained && material?.key !== retained) throw new Error('DOT_COLLISION: fixed source differs from retained field source')
  const source = deps.sources.prepareCanonical({ bundle: input.bundle, lane: key.lane, record }, material)
  const encoding = { record: source.compact, source: source.encoded }
  // 轻事实已在原始捕获批次提交；只有旧内嵌来源需要改文本并同步重建派生列。
  const encoded: { hash: string; stored?: string } = record.value.sourceOperation == null ? { hash: snapshotRecordHash(encoding) }
    : prepareSnapshotRecordEncoding(encoding)
  const stored = encoded.stored
  return { hash: encoded.hash, stored, id: key.id, source,
    facts: stored === undefined ? undefined : prepareSnapshotFacts({ bundle: input.bundle, lane: key.lane, record: source.compact }),
    cursor: JSON.stringify([key.lane, key.token, key.key]), bytes: Buffer.byteLength(stored ?? context.raw) + Buffer.byteLength(source.encoded ?? '') }
}

/** 当前分组只持有一个完整规范来源，不建立全库来源对象缓存。 */
class CapturedSourceGrouping {
  private identity = ''
  private source?: CanonicalSnapshotSource
  constructor(private readonly input: CapturedSourceInput) {}

  /** 重入从逻辑键重新读取当前原来源，旧池材料也必须与同一个 Dot/空间绑定。 */
  material(key: Key, retained?: () => CanonicalSnapshotSource): CanonicalSnapshotSource | undefined {
    const identity = JSON.stringify([key.lane, key.token])
    if (this.identity !== identity) {
      this.identity = identity
      const original = this.input.original(key.token)
      this.source = original ? canonicalSnapshotSource(original) : undefined
      if (original) snapshotTraceWork({ sources: 1, bytes: Buffer.byteLength(this.source!.encoded) })
    }
    if (!this.source && retained) {
      const source = retained()
      requireSourceBinding({ key, space: this.input.space, record: JSON.parse(source.encoded) as SyncOperationEnvelope })
      this.source = source
    }
    return this.source
  }
}

/** 旧签名材料只能恢复它自己的字段来源，不能把其他 token 的池命中当作证据。 */
function requireSourceBinding(input: { key: Key; space: string; record: SyncOperationEnvelope }): void {
  const dot = parseOperationVersionToken(input.key.token), source = input.record
  if (!dot || source.syncSpaceId !== input.space || source.actorIncarnationId !== dot.actorIncarnationId ||
      source.replicationLaneId !== dot.replicationLaneId || source.sequence !== dot.sequence || !source.authorSignature)
    throw new Error('SNAPSHOT_CORRUPTED: retained source does not match field Dot')
}
