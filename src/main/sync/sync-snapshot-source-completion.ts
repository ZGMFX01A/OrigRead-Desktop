import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { SyncStateRepository } from './sync-state-repository'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { canonicalJson, canonicalJsonValue, sha256Hex } from './sync-operation-canonicalizer'
import { SyncVersionToken } from './sync-version-token'

interface Input { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore; now: number; requirePrepared(): void }
interface Effect { readonly field: SnapshotFieldMetadata; readValue(): string }
interface Completion extends Input { requireEffect(space: string, effect: Effect): void }
interface Prepared { readonly source: SyncOperationEnvelope; readonly key: string; readonly bytes: number }
/** 来源完成也沿用文档 P3/P5 的标准短写批次。 */
const BATCH_ROWS = 256
/** 实际来源 DTO 的 UTF-8 预算；合法超大单条独占批次。 */
const BATCH_BYTES = 2 * 1024 * 1024

/** baseline、尾部和真实正文全部完成后，逐来源确认全部承诺字段已按因果规则处理。 */
export function completeSnapshotSources(database: DatabaseSync, state: SyncStateRepository, input: Input): void {
  const completion = { ...input, requireEffect: snapshotEffectVerifier(database) }
  for (const lane of input.manifest.lanes) {
    const progress = { job: input.manifest.snapshotBundleId, phase: `${input.manifest.rootHash}:source-complete:v2:${lane.replicationLaneId}`,
      budget: input.store.lifecycle.budget }
    const after = snapshotBatchCursor(database, progress)
    const sources = preparedSources({ ...completion, lane: lane.replicationLaneId, after })
    for (const batch of sourceBatches(sources)) {
      commitSnapshotBatch(database, { ...progress, cursor: batch.at(-1)!.key, rows: batch.length,
        bytes: batch.reduce((sum, row) => sum + row.bytes, 0) }, () => {
        input.requirePrepared()
        state.markAppliedBatch({ operationIds: batch.map(row => row.source.operationId), completedAt: input.now })
      })
    }
  }
}

/** 已提交来源从轻键直接续读；每个新来源的快照字段及完整签名载荷承诺都须通过。 */
function* preparedSources(input: Completion & { lane: string; after?: string }): Generator<Prepared> {
  let current: Prepared | undefined
  for (const field of input.store.evidenceFields({ bundle: input.manifest.snapshotBundleId, lane: input.lane, sourceAfter: input.after })) {
    snapshotCheckpoint()
    if (!field.source) continue
    if (current && current.key !== field.sourceKey) {
      requirePromisedEffects({ ...input, source: current.source }); yield current; current = undefined
    }
    input.requireEffect(input.manifest.syncSpaceId, { field: field.field,
      readValue: () => String(input.store.fieldRecord(field.field).value.valueJson) })
    if (!current) current = { source: field.source, key: field.sourceKey, bytes: Buffer.byteLength(JSON.stringify(field.source)) }
  }
  if (current) { requirePromisedEffects({ ...input, source: current.source }); yield current }
}

/** 仅保留当前有界准备批，字节或来源数任一达到预算便提交。 */
function* sourceBatches(sources: Iterable<Prepared>): Generator<readonly Prepared[]> {
  let batch: Prepared[] = [], bytes = 0
  for (const source of sources) {
    snapshotCheckpoint()
    if (batch.length && bytes + source.bytes > BATCH_BYTES) { yield batch; batch = []; bytes = 0 }
    batch.push(source); bytes += source.bytes
    if (batch.length === BATCH_ROWS || bytes >= BATCH_BYTES) { yield batch; batch = []; bytes = 0 }
  }
  if (batch.length) yield batch
}

/** 旧字段只能由高代映射/墓碑消解；普通冲突仍须真实候选和已裁决 winner 同时存在。 */
function snapshotEffectVerifier(database: DatabaseSync): Completion['requireEffect'] {
  const resolvedQuery = database.prepare(`SELECT EXISTS(SELECT 1 FROM sync_entity_tombstone WHERE sync_space_id=?
    AND entity_type=? AND entity_sync_id=? AND generation>=?) OR EXISTS(SELECT 1 FROM sync_identity_mapping
    WHERE sync_space_id=? AND entity_type=? AND sync_id=? AND generation>?) AS ok`)
  const candidateQuery = database.prepare(`SELECT value_json,EXISTS(SELECT 1 FROM sync_field_version WHERE sync_space_id=?
    AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND field_id=?) AS winner
    FROM sync_field_candidate WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=?
    AND field_id=? AND version_token=?`)
  // 数万字段复用查询；每次执行仍读取当前高代映射、墓碑、候选和值，绝不缓存裁决事实。
  return (space, effect) => {
    const field = effect.field
    const identity = [space, field.entityType, field.entitySyncId, field.generation]
    const resolved = resolvedQuery.get(...identity, ...identity)
    if (Number(resolved?.ok)) return
    const candidate = candidateQuery.get(...identity, field.fieldId, ...identity, field.fieldId, field.versionToken)
    if (!candidate || !Number(candidate.winner)) throw new Error(`SNAPSHOT_EFFECT_PENDING: ${field.key}`)
    if (sha256Hex(String(candidate.value_json)) === field.valueDigest) return
    // 只对字节承诺不同的字段读取原值，以保留同义 JSON 的属性顺序和空白兼容。
    if (canonicalJson(String(candidate.value_json)) !== canonicalJson(effect.readValue()))
      throw new Error(`SNAPSHOT_EFFECT_PENDING: ${field.key}`)
  }
}

/** 完整签名 UPSERT 的所有 effect 均须有真实候选和 winner，不能按字段来源出现次数推算完成。 */
function requirePromisedEffects(input: Completion & { source: SyncOperationEnvelope }): void {
  const source = input.source, payload = JSON.parse(source.payloadJson) as Record<string, unknown>
  if (!['FIELD_SET', 'UPSERT', 'RELATION_SET'].includes(source.operationType)) throw new Error(`SNAPSHOT_EFFECT_SOURCE_UNSUPPORTED: ${source.operationType}`)
  const fields = source.operationType === 'FIELD_SET' ? { [String(payload.field)]: payload.value } : payload.fields ?? payload
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('SNAPSHOT_EFFECT_SOURCE_INVALID')
  for (const [field, value] of Object.entries(fields)) {
    const encoded = canonicalJsonValue(value)
    input.requireEffect(input.manifest.syncSpaceId, { field: { bundle: input.manifest.snapshotBundleId, lane: source.replicationLaneId,
      key: `source-effect:${source.operationId}:${field}`, entityType: source.entityType, entitySyncId: source.entitySyncId,
      generation: source.entityGeneration, fieldId: field,
      versionToken: SyncVersionToken.operation(source.actorIncarnationId, source.replicationLaneId as SyncReplicationLane, source.sequence),
      logicalClock: source.logicalClock, causalContextJson: source.causalContextJson, valueDigest: sha256Hex(encoded), preferenceValueJson: '' },
      readValue: () => encoded })
  }
}
