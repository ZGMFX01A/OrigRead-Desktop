import type { DatabaseSync } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { resolveIndexedPagedField } from './sync-paged-field-resolver'
import { snapshotRecordKey } from './sync-snapshot-records'
import { canonicalJson } from './sync-operation-canonicalizer'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import type { PreparedSnapshotRecord } from './sync-snapshot-record-persistence'
import { snapshotCheckpoint } from './sync-snapshot-execution'

/** 一次只读取轻量实体身份，正文和字段候选逐实体处理。 */
const IDENTITY_BATCH_ROWS = 256
/** 计算结果按实际紧凑 DTO 字节提交，单个合法大实体独占一批。 */
const ENTITY_BATCH_BYTES = 2 * 1024 * 1024
/** SQL 形状只有身份页、代次和字段页，连接关闭后缓存随之回收。 */
const statements = new WeakMap<DatabaseSync, Map<string, ReturnType<DatabaseSync['prepare']>>>()

export interface RecoveryIndex {
  database: DatabaseSync
  store: SyncPagedSnapshotStore
  localId: string
  targetId: string
  workId: string
  lanes: readonly string[]
}

/** 轻量身份索引驱动每实体合并；代次、删除和字段候选都由两个完整输入决定。 */
export function mergePagedEntities(input: RecoveryIndex): void {
  for (const lane of input.lanes.filter(value => value !== 'AUTH')) mergeLane(input, lane)
}

/** 同 lane 的实体结果批量提交，候选仍先以各自原子断点完成，崩溃后只重算未发布实体。 */
function mergeLane(input: RecoveryIndex, lane: string): void {
  const phase = `entities:${lane}`
  const saved = snapshotBatchCursor(input.database, { job: input.workId, phase })
  let after = saved ? JSON.parse(saved) as { type: string; id: string } : undefined
  for (;;) {
    const seek = after ? ' AND (entity_type,entity_sync_id)>(?,?)' : ''
    const identities = query(input.database, `SELECT DISTINCT entity_type,entity_sync_id
      FROM sync_paged_snapshot_record WHERE snapshot_bundle_id IN (?,?) AND replication_lane_id=?
        AND kind IN ('ENTITY','TOMBSTONE') AND (replication_lane_id<>'CORE_META' OR entity_type='alias_edge')
        ${seek} ORDER BY entity_type,entity_sync_id LIMIT ${IDENTITY_BATCH_ROWS}`).all(input.localId, input.targetId, lane, ...(after ? [after.type, after.id] : []))
    if (!identities.length) return
    writeEntities(input, { phase, lane, identities })
    const last = identities.at(-1)!
    after = { type: String(last.entity_type), id: String(last.entity_sync_id) }
  }
}

/** 规范化、因果裁决和完整准备均在事务外；一批输出与最后的逻辑实体键共同提交。 */
function writeEntities(input: RecoveryIndex, batch: { phase: string; lane: string; identities: readonly Record<string, import('node:sqlite').SQLOutputValue>[] }): void {
  let pending: PreparedSnapshotRecord[] = [], bytes = 0, cursor = ''
  const flush = () => {
    if (!pending.length) return
    commitSnapshotBatch(input.database, { job: input.workId, phase: batch.phase, cursor,
      rows: pending.length, bytes, budget: input.store.lifecycle.budget }, () => {
      for (const record of pending) { snapshotCheckpoint(); input.store.writePrepared(record) }
    })
    pending = []; bytes = 0
  }
  for (const row of batch.identities) {
    snapshotCheckpoint()
    const identity = { lane: batch.lane, entityType: String(row.entity_type), entitySyncId: String(row.entity_sync_id) }
    const record = input.store.prepareRecord({ snapshotBundleId: input.workId, lane: batch.lane, record: mergeEntity(input, identity) })
    const size = Buffer.byteLength(record.stored) + Buffer.byteLength(record.source.encoded ?? '')
    if (pending.length && (pending.length === IDENTITY_BATCH_ROWS || bytes + size > ENTITY_BATCH_BYTES)) flush()
    pending.push(record); bytes += size
    cursor = JSON.stringify({ type: identity.entityType, id: identity.entitySyncId })
    if (bytes >= ENTITY_BATCH_BYTES) flush()
  }
  flush()
}

/** delete-wins 覆盖同一代次；重建的新代次不继承旧代次的字段候选或正文引用。 */
function mergeEntity(input: RecoveryIndex, identity: { lane: string; entityType: string; entitySyncId: string }): SyncSnapshotRecord {
  const generation = query(input.database, `SELECT MAX(generation) AS generation FROM sync_paged_snapshot_record
    WHERE snapshot_bundle_id IN (?,?) AND replication_lane_id=? AND entity_type=? AND entity_sync_id=? AND kind IN ('ENTITY','TOMBSTONE')`)
    .get(input.localId, input.targetId, identity.lane, identity.entityType, identity.entitySyncId)!
  const filter = { ...identity, generation: Number(generation.generation) }
  const deleted = chooseDeletion(input, filter)
  if (deleted) return deleted
  const entity = firstEntity(input, filter)
  if (!entity) throw new Error('SNAPSHOT_CORRUPTED: current recovery generation has no entity or deletion')
  retainCandidates(input, filter)
  const fields = mergedFields(input, { ...filter, fields: entity.value.fields as Record<string, unknown> })
  const value = { ...entity.value, fields }
  return { kind: 'ENTITY', key: snapshotRecordKey('ENTITY', value), value }
}

interface EntityFilter { lane: string; entityType: string; entitySyncId: string; generation: number }

/** 多个同代次删除都保留 delete-wins 事实，代表见证使用 token/时间的确定性顺序。 */
function chooseDeletion(input: RecoveryIndex, filter: EntityFilter): SyncSnapshotRecord | undefined {
  let winner: SyncSnapshotRecord | undefined
  for (const id of [input.localId, input.targetId]) for (const record of input.store.records({ snapshotBundleId: id, ...filter, kind: 'TOMBSTONE' })) {
    if (!winner || canonicalJson(JSON.stringify(record)) > canonicalJson(JSON.stringify(winner))) winner = record
  }
  return winner
}

/** 基础字段仅来自当前代次的真实 ENTITY；两侧不同值必须有完整字段候选来裁决。 */
function firstEntity(input: RecoveryIndex, filter: EntityFilter): SyncSnapshotRecord | undefined {
  for (const id of [input.localId, input.targetId]) {
    const record = input.store.records({ snapshotBundleId: id, ...filter, kind: 'ENTITY' }).next().value
    if (record) return record
  }
  return undefined
}

/** 相同 token 的不同值是协议冲突，不能在恢复时用来源顺序吞掉。 */
function retainCandidates(input: RecoveryIndex, filter: EntityFilter): void {
  for (const source of [input.localId, input.targetId]) input.store.copyCandidates({ ...filter, source, target: input.workId })
}

/** 保留全部候选，以完整因果极大集重建 ENTITY 值；正文 Hash 字段使用产品投影名称。 */
function mergedFields(input: RecoveryIndex, filter: EntityFilter & { fields: Record<string, unknown> }): Record<string, unknown> {
  const fields = { ...filter.fields }
  const group = { snapshotBundleId: input.workId, lane: filter.lane, entityType: filter.entityType,
    entitySyncId: filter.entitySyncId, generation: filter.generation, kind: 'FIELD_VERSION' as const }
  for (const fieldId of entityFieldIds(input, filter)) {
    const winner = resolveIndexedPagedField({ candidates: () => input.store.derived.fields({ ...group, fieldId }),
      fieldId, readWinner: field => input.store.fieldRecord(field) })
    const name = filter.entityType === 'article' && fieldId === 'fullContentHtml' ? 'fullContentHash' : fieldId
    fields[name] = JSON.parse(String(winner.value.valueJson))
  }
  return fields
}

/** 身份批次游标在解析 winner 前关闭，避免将整个实体字段扫描挂在写事务期间。 */
function *entityFieldIds(input: RecoveryIndex, filter: EntityFilter): Generator<string> {
  let after: string | undefined
  for (;;) {
    const seek = after === undefined ? '' : ' AND field_id>?'
    const rows = query(input.database, `SELECT DISTINCT field_id FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=?
      AND replication_lane_id=? AND entity_type=? AND entity_sync_id=? AND generation=? AND kind='FIELD_VERSION' ${seek}
      ORDER BY field_id LIMIT ${IDENTITY_BATCH_ROWS}`)
      .all(input.workId, filter.lane, filter.entityType, filter.entitySyncId, filter.generation, ...(after === undefined ? [] : [after]))
    if (!rows.length) return
    for (const row of rows) { after = String(row.field_id); yield after }
  }
}

/** 固定列查询复用原生语句，逐实体合并不积累数千份同形 SQL。 */
function query(database: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
  let queries = statements.get(database)
  if (!queries) { queries = new Map(); statements.set(database, queries) }
  let statement = queries.get(sql)
  if (!statement) { statement = database.prepare(sql); queries.set(sql, statement) }
  return statement
}
