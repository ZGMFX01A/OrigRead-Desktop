import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotManifest, SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { SyncCoverage, SyncOperationEnvelope } from '../../shared/sync-protocol'
import { toSyncOperationEnvelope } from '../../shared/sync-protocol'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncRuntimeRepository } from './sync-runtime-repository'
import type { SyncStateRepository } from './sync-state-repository'
import type { SyncApplyCoordinator } from './sync-apply-coordinator'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { canonicalJson, canonicalJsonValue, sha256Hex } from './sync-operation-canonicalizer'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import { parseOperationVersionToken } from './sync-version-token'
import { actorIsolated } from './sync-actor-integrity'
import { commitSnapshotBatch, snapshotBatchCursor } from './sync-snapshot-batch-progress'
import { snapshotTraceWork } from './sync-snapshot-trace'

interface Dependencies {
  database: DatabaseSync
  runtime: SyncRuntimeRepository
  state: SyncStateRepository
  apply: SyncApplyCoordinator
}

/** 字段携带原始作者签名；本地时间与构建状态不能进入跨端证据。 */
export function captureFieldOperationEvidence(input: { database: DatabaseSync; runtime: SyncRuntimeRepository; space: string; value: Record<string, unknown> }): Record<string, unknown> {
  const original = captureOriginalOperation({ runtime: input.runtime, space: input.space, token: String(input.value.versionToken) })
  return original ? { sourceOperation: original } : {}
}

/** 固定来源按完整 Dot 读取一次；来源缺失仍由原稳定覆盖规则在验证阶段裁决。 */
export function captureOriginalOperation(input: { runtime: SyncRuntimeRepository; space: string; token: string }): SyncOperationEnvelope | null {
  const dot = parseOperationVersionToken(input.token)
  if (!dot) return null
  const original = input.runtime.findOperationByDot(dot.actorIncarnationId, dot.replicationLaneId as SyncReplicationLane, dot.sequence)
  if (!original) return null
  if (original.syncSpaceId !== input.space) throw new Error('SNAPSHOT_CORRUPTED: original operation belongs to another space')
  if (original.buildStatus !== 'SIGNED' || !original.authorSignature) throw new Error('REBASE_UNSAFE: Snapshot original operation is not signed')
  // 正式 wire 投影排除本机时间、构建状态和数据库公钥提示，保留完整原作者签名材料。
  return { ...toSyncOperationEnvelope(original) }
}

/** 在任何业务清理前验证所有原作者、cutoff、字段载荷和 predecessor 证据。 */
export function verifyPagedOperationEvidence(deps: Dependencies, input: { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore }): void {
  const stable = stableCoverage(deps.runtime, input.manifest.syncSpaceId)
  let previous: SyncOperationEnvelope | null = null
  let payload: Record<string, unknown> | null = null
  for (const lane of input.manifest.lanes) for (const evidence of input.store.evidenceFields({ bundle: input.manifest.snapshotBundleId, lane: lane.replicationLaneId })) {
    const field = evidence.field
    snapshotTraceWork({ rows: 1 })
    const dot = parseOperationVersionToken(field.versionToken)
    if (!dot) continue
    if (actorIsolated(deps.database, { space: input.manifest.syncSpaceId, actor: dot.actorIncarnationId })) throw new Error('DOT_COLLISION: Snapshot carries isolated actor history')
    if (dot.sequence > (input.manifest.coverage[dot.replicationLaneId]?.[dot.actorIncarnationId] ?? 0)) throw new Error('SNAPSHOT_CORRUPTED: field operation exceeds signed coverage')
    const stableDot = dot.sequence <= (stable[dot.replicationLaneId]?.[dot.actorIncarnationId] ?? 0)
    const envelope = evidence.source
    if (!envelope) {
      if (!stableDot) throw new Error('REBASE_UNSAFE: provisional Snapshot field lacks original signed operation')
      continue
    }
    if (previous !== envelope) {
      const peer = deps.state.findPeer(envelope.syncSpaceId, envelope.authorDeviceId)
      if (!peer) throw new Error('AUTH_FAILED: unknown Snapshot original author')
      deps.apply.verifySnapshotOperation(envelope, peer.publicKeySpkiBase64)
      previous = envelope
      payload = JSON.parse(envelope.payloadJson) as Record<string, unknown>
      snapshotTraceWork({ sources: 1, bytes: Buffer.byteLength(envelope.payloadJson) })
    }
    requireMatchingField({ space: input.manifest.syncSpaceId, field, operation: envelope, payload: payload!, store: input.store })
    if (!stableDot) requirePredecessor({ ...input, field, lane: lane.replicationLaneId, stable })
  }
}

/** baseline 物化事务内恢复原操作与 Inbox；候选保留 sourceOperationId 供撤销定位。 */
export function restoreFieldOperationEvidence(deps: Dependencies, input: { space: string; record: SyncSnapshotRecord; now: number }): string | null {
  const envelope = sourceOperation(input.record)
  if (!envelope) return null
  deps.apply.restoreSnapshotOperation(envelope, { now: input.now, resolvePeerKey: (space, device) => deps.state.findPeer(space, device) })
  return envelope.operationId
}

/** 每个完整来源只恢复一次，原操作进入真实 Inbox 而不是逐字段宣告 APPLIED。 */
export function stagePagedSources(deps: Dependencies, input: { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore; now: number }): void {
  for (const source of uniqueSources(input)) {
    const receipt = { job: input.manifest.snapshotBundleId, phase: `${input.manifest.rootHash}:source-ingest:${source.operationId}` }
    if (snapshotBatchCursor(deps.database, receipt) === 'IMPORTED') continue
    deps.apply.stageSnapshotOperation(source, { now: input.now, resolvePeerKey: (space, device) => deps.state.findPeer(space, device) })
    // ingest 已有幂等原操作约束；此处崩溃只能重查原事实，不改签名或提前确认应用。
    commitSnapshotBatch(deps.database, { ...receipt, cursor: 'IMPORTED', budget: input.store.lifecycle.budget }, () => {})
  }
}

/** 字段恢复只查询轻量原操作 ID，既有稳定且已 GC 的来源仍允许为空。 */
export function snapshotFieldSourceId(database: DatabaseSync, input: { space: string; record: SyncSnapshotRecord }): string | null {
  const dot = parseOperationVersionToken(String(input.record.value.versionToken))
  if (!dot) return null
  const row = database.prepare(`SELECT operation_id FROM sync_operation_log WHERE sync_space_id=?
    AND actor_incarnation_id=? AND replication_lane_id=? AND sequence=?`).get(input.space, dot.actorIncarnationId, dot.replicationLaneId, dot.sequence)
  return row ? String(row.operation_id) : null
}

/** 来源序列只保留当前签名对象，字段验证和因果裁决使用独立轻量索引。 */
function* uniqueSources(input: { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore }): Generator<SyncOperationEnvelope> {
  for (const lane of input.manifest.lanes) {
    let previous: SyncOperationEnvelope | null = null
    for (const field of input.store.evidenceFields({ bundle: input.manifest.snapshotBundleId, lane: lane.replicationLaneId })) {
      const source = field.source
      if (!source || source === previous) continue
      previous = source
      yield source
    }
  }
}

/** 仅 verified OWNER checkpoint 能使原始日志已 GC 的旧候选免除 provisional 证据。 */
function stableCoverage(runtime: SyncRuntimeRepository, space: string): SyncCoverage {
  const coverage: SyncCoverage = {}
  for (const object of runtime.listAuthObjects(space)) {
    if (object.objectType !== 'AUTH_STABILITY_CHECKPOINT') continue
    const accepted = JSON.parse(object.payloadJson).acceptedPrefixByActorLane as SyncCoverage
    for (const [lane, actors] of Object.entries(accepted)) for (const [actor, prefix] of Object.entries(actors)) {
      coverage[lane] ??= {}; coverage[lane]![actor] = Math.max(coverage[lane]![actor] ?? 0, prefix)
    }
  }
  return coverage
}

/** 跨端 payload 必须仍是原始签名操作对象，null 不代表验证成功。 */
function sourceOperation(record: SyncSnapshotRecord): SyncOperationEnvelope | null {
  const value = record.value.sourceOperation
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('SNAPSHOT_CORRUPTED: original operation evidence is malformed')
  return value as SyncOperationEnvelope
}

/** Dot、实体代次、时钟、因果上下文和字段值全部与原作者承诺一致。 */
function requireMatchingField(input: { space: string; field: SnapshotFieldMetadata; operation: SyncOperationEnvelope;
  payload: Record<string, unknown>; store: SyncPagedSnapshotStore }): void {
  const { space, field, operation } = input
  const dot = parseOperationVersionToken(field.versionToken)!
  if (space !== operation.syncSpaceId || dot.actorIncarnationId !== operation.actorIncarnationId || dot.replicationLaneId !== operation.replicationLaneId || dot.sequence !== operation.sequence ||
    field.entityType !== operation.entityType || field.entitySyncId !== operation.entitySyncId || field.generation !== operation.entityGeneration) throw new Error('SNAPSHOT_CORRUPTED: field identity differs from original signed operation')
  if (field.logicalClock !== operation.logicalClock || field.causalContextJson !== operation.causalContextJson) throw new Error('SNAPSHOT_CORRUPTED: field causal metadata differs from original signed operation')
  // 旧轻索引把缺省时钟映射为零；签名的真实零时钟必须精确确认，不能把缺省/null 当作零。
  if (field.logicalClock === 0 && input.store.fieldRecord(field).value.logicalClock !== operation.logicalClock)
    throw new Error('SNAPSHOT_CORRUPTED: field causal metadata differs from original signed operation')
  requireMatchingValue(input)
}

/** 只核对当前字段，不能用同实体另一个已签名字段给伪造值背书。 */
function requireMatchingValue(input: { field: SnapshotFieldMetadata; operation: SyncOperationEnvelope;
  payload: Record<string, unknown>; store: SyncPagedSnapshotStore }): void {
  const { field, operation, payload } = input
  const fields = (payload.fields ?? payload) as Record<string, unknown>
  const actual = operation.operationType === 'FIELD_SET' ? payload.value : fields[field.fieldId]
  if ((operation.operationType === 'FIELD_SET' && field.fieldId !== payload.field) || actual === undefined)
    throw new Error('SNAPSHOT_CORRUPTED: field does not match its original signed operation')
  const expected = canonicalJsonValue(actual)
  if (sha256Hex(expected) === field.valueDigest) return
  // wire 允许同义 JSON 的属性顺序/空白不同；摘要不相等时只精确读取这个字段，不能直接豁免校验。
  const record = input.store.fieldRecord(field)
  if (canonicalJson(String(record.value.valueJson)) !== expected)
    throw new Error('SNAPSHOT_CORRUPTED: field does not match its original signed operation')
}

/** 保留稳定 predecessor 或真实 rollback baseline，不能拿当前 provisional winner 充当旧值。 */
function requirePredecessor(input: { manifest: SyncPagedSnapshotManifest; store: SyncPagedSnapshotStore; field: SnapshotFieldMetadata; lane: string; stable: SyncCoverage }): void {
  const field = input.field
  const records = input.store.derived.fields({ snapshotBundleId: input.manifest.snapshotBundleId, lane: input.lane, kind: 'FIELD_VERSION',
    entityType: field.entityType, entitySyncId: field.entitySyncId, generation: field.generation, fieldId: field.fieldId })
  for (const previous of records) {
    const token = previous.versionToken, dot = parseOperationVersionToken(token)
    if (token.startsWith('GENESIS_V1|') || (dot && dot.sequence <= (input.stable[dot.replicationLaneId]?.[dot.actorIncarnationId] ?? 0))) return
  }
  throw new Error('REBASE_UNSAFE: provisional Snapshot field lacks predecessor evidence')
}
