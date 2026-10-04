import type { DatabaseSync } from 'node:sqlite'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { SyncEntityType } from '../../shared/sync-identity'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { configRuleSyncId } from './sync-canonical-identity'
import { resolvePagedField, resolveIndexedPagedField } from './sync-paged-field-resolver'
import type { SyncStateRepository, SyncFieldVersionRecord } from './sync-state-repository'
import { SyncVersionToken } from './sync-version-token'
import { canonicalJson } from './sync-operation-canonicalizer'
import type { SyncReplicationLane } from '../../shared/sync-runtime'

/** 单订阅原子配置的寄存器字段；规则列表不随 Feed 别名归并。 */
const FEED_FIELDS: Readonly<Record<string, string>> = { website_parse_preference: 'preference', rsshub_subscription_source: 'source' }

export interface FeedConfigVariant { entitySyncId: string; generation: number; fields: Record<string, unknown> }

/** 父 Feed 同代次别名映射到同一配置槽位，各配置的身份及独立代次仍分别保留。 */
export function feedConfigCaptureVariants(input: { database: DatabaseSync; space: string; type: string; fields: Record<string, unknown> }): FeedConfigVariant[] | null {
  const field = FEED_FIELDS[input.type]
  if (!field) return null
  const content = input.fields[field] as Record<string, unknown>
  const rows = input.database.prepare(`SELECT m.sync_id,m.generation,m.local_id FROM sync_identity_mapping m
    WHERE m.sync_space_id=? AND m.entity_type=? AND (m.local_id=? OR m.local_id IN (
      SELECT alias_sync_id FROM sync_entity_alias WHERE sync_space_id=? AND entity_type='feed' AND generation=?
      AND canonical_sync_id=(SELECT canonical_sync_id FROM sync_entity_alias
        WHERE sync_space_id=? AND entity_type='feed' AND generation=? AND alias_sync_id=?)))
    AND NOT EXISTS(SELECT 1 FROM sync_entity_tombstone t WHERE t.sync_space_id=m.sync_space_id
      AND t.entity_type=m.entity_type AND t.entity_sync_id=m.sync_id AND t.generation>=m.generation)
    ORDER BY m.sync_id`).all(input.space, input.type, String(content.feedSyncId), input.space,
      Number(content.feedGeneration), input.space, Number(content.feedGeneration), String(content.feedSyncId))
  return rows.map(row => ({ entitySyncId: String(row.sync_id), generation: Number(row.generation),
    fields: { ...input.fields, [field]: { ...content, feedSyncId: String(row.local_id) } } }))
}

/** 物化时联合同一父组件的全部真实候选，ENTITY 的排序不能决定原子配置胜者。 */
export function projectPagedFeedConfig(input: { store: SyncPagedSnapshotStore; bundleId: string; entity: SyncSnapshotRecord;
  live(value: Record<string, unknown>): boolean;
  members(parent: { id: string; generation: number }): ReadonlySet<string> }): Record<string, unknown> {
  const type = String(input.entity.value.entityType), field = FEED_FIELDS[type]
  if (!field) return input.entity.value
  const fields = input.entity.value.fields as Record<string, unknown>, parent = fields[field] as Record<string, unknown>
  const ids = [...input.members({ id: String(parent.feedSyncId), generation: Number(parent.feedGeneration) })]
    .map(id => configRuleSyncId(type as SyncEntityType, id))
  const records = function* () {
    for (const id of ids) {
      const filter = { snapshotBundleId: input.bundleId, lane: 'CONFIG', entityType: type, entitySyncId: id }
      const entity = input.store.records({ ...filter, kind: 'ENTITY' }).next().value
      if (!entity || !input.live(entity.value)) continue
      const generation = Number(entity.value.generation)
      if (input.store.records({ ...filter, kind: 'TOMBSTONE', generation }).next().value) continue
      yield* input.store.derived.fields({ ...filter, fieldId: field, generation })
    }
  }
  const winner = JSON.parse(String(resolveIndexedPagedField({ candidates: records, fieldId: field,
    readWinner: field => input.store.fieldRecord(field) }).value.valueJson)) as Record<string, unknown>
  if (Number(winner.feedGeneration) !== Number(parent.feedGeneration) || !input.members({ id: String(parent.feedSyncId),
    generation: Number(parent.feedGeneration) }).has(String(winner.feedSyncId))) throw new Error('SNAPSHOT_CORRUPTED: CONFIG winner references another Feed generation')
  // 父引用仅按已证明的同代次等价关系投影回本身份，原始候选/token 保持不变。
  return { ...input.entity.value, fields: { ...fields, [field]: { ...winner, feedSyncId: parent.feedSyncId } } }
}

/** 增量和 tail 保持各逻辑寄存器独立，只对真实配置槽位进行联合物化。 */
export function projectCurrentFeedConfig(input: { database: DatabaseSync; state: SyncStateRepository; space: string;
  type: SyncEntityType; parent: Record<string, unknown>; members: ReadonlySet<string> }): Record<string, unknown> {
  const field = FEED_FIELDS[input.type]
  if (!field || input.parent.feedGeneration == null) return input.parent
  const records = function* () {
    for (const member of input.members) {
      const id = configRuleSyncId(input.type, member)
      const mapping = input.database.prepare(`SELECT generation FROM sync_identity_mapping m
        WHERE sync_space_id=? AND entity_type=? AND sync_id=? AND NOT EXISTS(
          SELECT 1 FROM sync_entity_tombstone t WHERE t.sync_space_id=m.sync_space_id
            AND t.entity_type=m.entity_type AND t.entity_sync_id=m.sync_id AND t.generation>=m.generation)`)
        .get(input.space, input.type, id)
      if (!mapping) continue
      const scope = { syncSpaceId: input.space, entityType: input.type, entitySyncId: id, generation: Number(mapping.generation) }
      for (const candidate of input.state.iterateEntityFieldCandidates(scope)) if (candidate.fieldId === field) yield fieldRecord(candidate)
      const current = input.state.findFieldVersion(input.space, input.type, id, field)
      if (current?.entityGeneration === scope.generation) yield fieldRecord(current)
      yield* configHistory(input, { id, generation: scope.generation, field })
    }
  }
  const winner = JSON.parse(String(resolvePagedField({ records, fieldId: field }).value.valueJson)) as Record<string, unknown>
  if (Number(winner.feedGeneration) !== Number(input.parent.feedGeneration) || !input.members.has(String(winner.feedSyncId))) {
    throw new Error('CONFIG winner references another Feed generation')
  }
  return { ...winner, feedSyncId: input.parent.feedSyncId }
}

/** 寄存器证据直接转为字段视图，不搬移到另一配置身份或生成虚构操作。 */
function fieldRecord(row: SyncFieldVersionRecord): SyncSnapshotRecord {
  return { kind: 'FIELD_VERSION', key: row.versionToken, value: { fieldId: row.fieldId,
    versionToken: row.versionToken, valueJson: canonicalJson(row.valueJson), causalContextJson: row.causalContextJson ?? null,
    logicalClock: row.logicalClock ?? null } }
}

/** 尚未反映到寄存器的真实已应用日志和本地 pending 也参与裁决，防止尾部覆盖离线修改。 */
function* configHistory(input: { database: DatabaseSync; space: string; type: SyncEntityType }, scope: { id: string; generation: number; field: string }): Generator<SyncSnapshotRecord> {
  const rows = input.database.prepare(`SELECT o.actor_incarnation_id,o.replication_lane_id,o.sequence,o.logical_clock,
    o.operation_type AS mutation_type,o.payload_json,o.causal_context_json FROM sync_operation_log o
    WHERE o.sync_space_id=? AND o.entity_type=? AND o.entity_sync_id=? AND o.entity_generation=? AND o.build_status<>'REJECTED'
    AND NOT EXISTS(SELECT 1 FROM sync_inbox_operation i WHERE i.operation_id=o.operation_id AND i.state<>'APPLIED')
    UNION ALL SELECT actor_incarnation_id,replication_lane_id,sequence,sequence,mutation_type,payload_json,causal_context_json
    FROM sync_outbox WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=?
      AND status='PENDING_BUILD' AND genesis_included_at IS NULL`)
    .iterate(input.space, input.type, scope.id, scope.generation, input.space, input.type, scope.id, scope.generation)
  for (const row of rows) {
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>
    const value = row.mutation_type === 'FIELD_SET' && payload.field === scope.field ? payload.value
      : row.mutation_type === 'UPSERT' ? (payload.fields as Record<string, unknown> ?? payload)[scope.field] : undefined
    if (value === undefined) continue
    const token = SyncVersionToken.operation(String(row.actor_incarnation_id), String(row.replication_lane_id) as SyncReplicationLane, Number(row.sequence))
    yield { kind: 'FIELD_VERSION', key: token, value: { fieldId: scope.field, versionToken: token, valueJson: canonicalJson(JSON.stringify(value)),
      causalContextJson: row.causal_context_json, logicalClock: row.logical_clock } }
  }
}
