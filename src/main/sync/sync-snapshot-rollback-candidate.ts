import type { DatabaseSync } from 'node:sqlite'
import { canonicalJson, sha256Hex } from './sync-operation-canonicalizer'
import { SyncVersionToken } from './sync-version-token'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import { toSyncOperationEnvelope, type SyncOperationEnvelope } from '../../shared/sync-protocol'
import { operationRecordFromWire } from './sync-operation-wire'

/** 真实旧值作为独立 Genesis 候选保留，避免不同本机 predecessor 污染同一个原操作 token。 */
export function snapshotRollbackCandidate(input: { database: DatabaseSync; space: string; lane: SyncReplicationLane; value: Record<string, unknown> }): Record<string, unknown> | null {
  const value = input.value
  const row = input.database.prepare(`SELECT value_json FROM sync_field_rollback_baseline
    WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND entity_generation=? AND field_id=?`)
    .get(input.space, String(value.entityType), String(value.entitySyncId), Number(value.entityGeneration), String(value.fieldId))
  if (!row) return null
  const raw = String(row.value_json), parsed = JSON.parse(raw)
  const valueJson = parsed?.__syncRollbackBaselineV2 === true ? String(parsed.valueJson) : canonicalJson(raw)
  // 基线身份由真实旧值和字段身份确定；它不是原作者 Operation，也不伪造作者签名。
  const baselineId = 'rollback-' + sha256Hex(canonicalJson(JSON.stringify([input.space, value.entityType,
    value.entitySyncId, value.entityGeneration, value.fieldId, valueJson])))
  return { entityType: value.entityType, entitySyncId: value.entitySyncId, entityGeneration: value.entityGeneration,
    fieldId: value.fieldId, valueJson, versionToken: SyncVersionToken.genesis(baselineId, input.lane, String(value.entitySyncId), String(value.fieldId)),
    causalContextJson: null, logicalClock: null }
}

/** 同 token 的业务承诺严格一致；原日志已 GC 的一端可以接受另一端补齐真实签名。 */
export function mergeSnapshotFieldEvidence(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const { sourceOperation: leftSource, ...leftField } = left
  const { sourceOperation: rightSource, ...rightField } = right
  if (canonicalJson(JSON.stringify(leftField)) !== canonicalJson(JSON.stringify(rightField))) throw new Error('SNAPSHOT_CORRUPTED: conflicting field commitment')
  // 原始操作经过正式 wire 验证和投影；本机公钥提示的 null/缺失不属于签名承诺。
  const normalizedLeft = leftSource ? toSyncOperationEnvelope(operationRecordFromWire(leftSource as SyncOperationEnvelope)) : null
  const normalizedRight = rightSource ? toSyncOperationEnvelope(operationRecordFromWire(rightSource as SyncOperationEnvelope)) : null
  if (normalizedLeft && normalizedRight && canonicalJson(JSON.stringify(normalizedLeft)) !== canonicalJson(JSON.stringify(normalizedRight))) throw new Error('SNAPSHOT_CORRUPTED: conflicting original operation')
  const sourceOperation = normalizedLeft ?? normalizedRight
  return sourceOperation ? { ...leftField, sourceOperation } : leftField
}
