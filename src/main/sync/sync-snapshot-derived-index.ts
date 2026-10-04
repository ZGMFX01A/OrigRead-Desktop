import type { DatabaseSync } from 'node:sqlite'
import type { SnapshotRecordFilter } from './sync-paged-record-read'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import type { PreparedSnapshotFacts, SnapshotEntityMetadata, SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import { SNAPSHOT_DERIVED_TABLES } from '../database/snapshot-derived-schema'
import { SNAPSHOT_FIELD_PROJECTION, projectedSnapshotField } from './sync-snapshot-field-projection'
import { SyncSnapshotCausalFactsReader } from './sync-snapshot-causal-facts'

/** 轻量记录键批次与文档 P3 初始参数一致，大因果上下文仍逐条读取。 */
const INDEX_ROWS = 256
/** 保持现有 Desktop wire 记录顺序，末尾业务键唯一。 */
const ORDER = ['replication_lane_id', 'kind', 'entity_type', 'entity_sync_id', 'generation', 'record_key'] as const

/** 连接级固定语句只访问字段承诺和关系元数据，绝不解码 record_json。 */
export class SyncSnapshotDerivedIndex {
  private readonly causalFacts = new SyncSnapshotCausalFactsReader()
  private readonly queries = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  private readonly field: ReturnType<DatabaseSync['prepare']>
  private readonly entity: ReturnType<DatabaseSync['prepare']>
  private readonly edges: ReturnType<DatabaseSync['prepare']>
  private readonly copies: readonly ReturnType<DatabaseSync['prepare']>[]
  constructor(private readonly database: DatabaseSync) {
    this.field = database.prepare('INSERT INTO sync_snapshot_field_index VALUES(?,?,?,?,?,?,?,?)')
    this.entity = database.prepare('INSERT INTO sync_snapshot_entity_index VALUES(?,?,?,?)')
    this.edges = database.prepare('INSERT INTO sync_snapshot_entity_edge VALUES(?,?,?,?,?,?,?)')
    this.copies = SNAPSHOT_DERIVED_TABLES.map(table => database.prepare(`INSERT OR REPLACE INTO ${table}
      SELECT ?,${copyColumns(table)} FROM ${table} WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=?`))
  }

  /** 同一个写事务持有原记录、派生事实和调用方断点，失败全部回滚。 */
  write(facts: PreparedSnapshotFacts): void {
    if (facts.field) this.field.run(...facts.field)
    if (facts.entity) this.entity.run(...facts.entity)
    for (const edge of facts.edges) this.edges.run(...edge)
  }

  /** 老索引在版本升级后必须重新派生，缺少轻量事实不能伪装成空候选/无父关系。 */
  requireComplete(bundle: string): void {
    const row = this.query(`SELECT 1 FROM sync_paged_snapshot_record r WHERE r.snapshot_bundle_id=? AND
      ((r.kind='FIELD_VERSION' AND NOT EXISTS(SELECT 1 FROM sync_snapshot_field_index f
        WHERE f.snapshot_bundle_id=r.snapshot_bundle_id AND f.replication_lane_id=r.replication_lane_id AND f.record_key=r.record_key)) OR
       (r.kind='ENTITY' AND NOT EXISTS(SELECT 1 FROM sync_snapshot_entity_index e
        WHERE e.snapshot_bundle_id=r.snapshot_bundle_id AND e.replication_lane_id=r.replication_lane_id AND e.record_key=r.record_key))) LIMIT 1`).get(bundle)
    if (row) throw new Error('SNAPSHOT_CORRUPTED: derived field/relationship index is incomplete')
  }

  /** SQL 原列复制保持同一来源的派生承诺，不重复解析候选值或实体正文。 */
  copy(input: { source: string; target: string; lane: string; key: string }): void {
    for (const copy of this.copies) copy.run(input.target, input.source, input.lane, input.key)
  }

  /** 只取字段组身份，胜者裁决不再扫描候选全文。 */
  *fieldIds(input: { snapshotBundleId: string; lane: string }): Generator<{ entityType: string; entitySyncId: string; generation: number; fieldId: string }> {
    let after: [string, string, number, string] | undefined
    for (;;) {
      const seek = after ? ' AND (entity_type,entity_sync_id,generation,field_id)>(?,?,?,?)' : ''
      const rows = this.query(`SELECT DISTINCT entity_type,entity_sync_id,generation,field_id FROM sync_paged_snapshot_record
        WHERE snapshot_bundle_id=? AND replication_lane_id=? AND kind='FIELD_VERSION' ${seek}
        ORDER BY entity_type,entity_sync_id,generation,field_id LIMIT ${INDEX_ROWS}`).all(input.snapshotBundleId, input.lane, ...(after ?? []))
      if (!rows.length) return
      for (const row of rows) {
        after = [String(row.entity_type), String(row.entity_sync_id), Number(row.generation), String(row.field_id)]
        yield { entityType: after[0], entitySyncId: after[1], generation: after[2], fieldId: after[3] }
      }
    }
  }

  /** 第一遍裁决只取摘要、布尔偏好和因果上下文；原始值在确定胜者后精确读取。 */
  *fields(filter: SnapshotRecordFilter): Generator<SnapshotFieldMetadata> {
    for (const row of this.keys({ ...filter, kind: 'FIELD_VERSION' }, true)) {
      const field = projectedSnapshotField({ database: this.database, bundle: filter.snapshotBundleId,
        lane: String(row.replication_lane_id), row })
      yield { ...field, causalFacts: this.causalFacts.read(field.causalContextJson) }
    }
  }

  /** 父子存在、代次、删除及共享上下文检查只读此关系视图。 */
  *entities(filter: SnapshotRecordFilter): Generator<SnapshotEntityMetadata> {
    for (const key of this.keys({ ...filter, kind: 'ENTITY' })) {
      const args = [filter.snapshotBundleId, key.replication_lane_id!, key.record_key!]
      const row = this.query('SELECT context_json FROM sync_snapshot_entity_index WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=?').get(...args)
      if (!row) throw new Error('SNAPSHOT_CORRUPTED: entity relationship index is missing')
      const parents = this.query(`SELECT parent_type,parent_id,parent_generation FROM sync_snapshot_entity_edge
        WHERE snapshot_bundle_id=? AND replication_lane_id=? AND record_key=? ORDER BY ordinal`).all(...args)
      yield { bundle: filter.snapshotBundleId, lane: String(key.replication_lane_id), key: String(key.record_key),
        entityType: String(key.entity_type), entitySyncId: String(key.entity_sync_id), generation: Number(key.generation),
        context: JSON.parse(String(row.context_json)), parents: parents.map(parent => ({ entityType: String(parent.parent_type),
          entitySyncId: String(parent.parent_id), generation: parent.parent_generation == null ? undefined : Number(parent.parent_generation) })) }
    }
  }

  /** 只按固定业务键预取身份，all 在下游处理和写事务开始前已关闭游标。 */
  private *keys(filter: SnapshotRecordFilter, fields = false): Generator<Record<string, import('node:sqlite').SQLOutputValue>> {
    const values = { replication_lane_id: filter.lane, kind: filter.kind, entity_type: filter.entityType,
      entity_sync_id: filter.entitySyncId, generation: filter.generation, field_id: filter.fieldId }
    const selected = Object.entries(values).filter(([, value]) => value !== undefined)
    const where = ['r.snapshot_bundle_id=?', ...selected.map(([column]) => `r.${column}=?`)].join(' AND ')
    const order = filter.stableKeyOrder ? ['replication_lane_id', 'kind', 'record_key'] : ORDER
    const fixed = new Set(selected.map(([column]) => column))
    const seekColumns = order.filter(column => !fixed.has(column))
    const index = filter.entityType !== undefined && filter.entitySyncId !== undefined ? ' INDEXED BY index_sync_paged_record_business' : ''
    const projection = fields ? `r.replication_lane_id,r.kind,r.record_key,${SNAPSHOT_FIELD_PROJECTION}`
      : `${ORDER.map(column => `r.${column}`).join(',')},r.field_id`
    const join = fields ? ` LEFT JOIN sync_snapshot_field_index f ON f.snapshot_bundle_id=r.snapshot_bundle_id
      AND f.replication_lane_id=r.replication_lane_id AND f.record_key=r.record_key` : ''
    let after: import('node:sqlite').SQLInputValue[] | undefined
    for (;;) {
      snapshotCheckpoint()
      const seek = after ? ` AND (${seekColumns.map(column => `r.${column}`).join(',')})>(${seekColumns.map(() => '?').join(',')})` : ''
      const rows = this.query(`SELECT ${projection} FROM sync_paged_snapshot_record r${index}${join}
        WHERE ${where}${seek} ORDER BY ${order.map(column => `r.${column}`).join(',')} LIMIT ${INDEX_ROWS}`)
        .all(filter.snapshotBundleId, ...selected.map(([, value]) => value!), ...(after ?? []))
      if (!rows.length) return
      after = seekColumns.map(column => rows.at(-1)![column]!)
      for (const row of rows) { snapshotCheckpoint(); yield row }
      // 固定输入的末批已完整读取，不为每个只有一两个候选的字段再查询一次空页。
      if (rows.length < INDEX_ROWS) return
    }
  }

  /** SQL 形状仅由固定列组成；原生语句复用不保留仍活动的迭代游标。 */
  private query(sql: string): ReturnType<DatabaseSync['prepare']> {
    let statement = this.queries.get(sql)
    if (!statement) { statement = this.database.prepare(sql); this.queries.set(sql, statement) }
    return statement
  }
}

/** 复制列来自正式 schema，不接受外部 SQL 标识符。 */
function copyColumns(table: typeof SNAPSHOT_DERIVED_TABLES[number]): string {
  const prefix = 'replication_lane_id,record_key,'
  if (table === 'sync_snapshot_field_index') return prefix + 'version_token,logical_clock,causal_context_json,value_digest,preference_value_json'
  if (table === 'sync_snapshot_entity_index') return prefix + 'context_json'
  return prefix + 'ordinal,parent_type,parent_id,parent_generation'
}
