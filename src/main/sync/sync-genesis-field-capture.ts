import type { DatabaseSync } from 'node:sqlite'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import type { SyncStateRepository, SyncFieldVersionRecord } from './sync-state-repository'
import type { DesktopGenesisCut } from './sync-runtime-coordinator'
import { canonicalJson, canonicalJsonValue } from './sync-operation-canonicalizer'
import { parseOperationVersionToken, SyncVersionToken } from './sync-version-token'

export interface GenesisFieldVersionSnapshot {
  entityType: string; entitySyncId: string; entityGeneration: number; fieldId: string
  valueJson: string; versionToken: string; causalContextJson: string | null; logicalClock: number | null
}
export interface GenesisFieldCaptureInput {
  lane: SyncReplicationLane; entityType: string; entitySyncId: string; entityGeneration: number; fieldId: string; value: unknown
}
interface CaptureContext { database: DatabaseSync; state: SyncStateRepository; cut: DesktopGenesisCut }
interface CausalMetadata { causalContextJson: string | null; logicalClock: number | null }

/** 当前字段保留原 token 和原值编码；只在代次、值与完整因果证据一致时复用。 */
export function captureGenesisFieldVersion(context: CaptureContext, input: GenesisFieldCaptureInput): GenesisFieldVersionSnapshot {
  const valueJson = fieldValueJson(input.value)
  const current = context.state.findFieldVersion(context.cut.syncSpaceId, input.entityType, input.entitySyncId, input.fieldId)
  const causal = current ? causalMetadata(context, current) : { causalContextJson: null, logicalClock: null }
  const source = current ? versionSource(current.versionToken) : null
  // 已规范且逐字相同的值无需再次解析；旧同义 JSON 仍按原规范算法比较。
  const reusable = current && current.entityGeneration === input.entityGeneration &&
    (current.valueJson === valueJson || canonicalJson(current.valueJson) === valueJson) &&
    (source === 'GENESIS' || (source === 'OPERATION' && causal.causalContextJson != null && causal.logicalClock != null))
  return {
    entityType: input.entityType, entitySyncId: input.entitySyncId, entityGeneration: input.entityGeneration, fieldId: input.fieldId,
    valueJson: reusable ? current.valueJson : valueJson,
    versionToken: reusable ? current.versionToken : SyncVersionToken.genesis(context.cut.genesisBaselineId, input.lane, input.entitySyncId, input.fieldId),
    causalContextJson: reusable ? causal.causalContextJson : null, logicalClock: reusable ? causal.logicalClock : null
  }
}

/** 字符串和空/布尔标量直接规范编码；对象保留原 JSON 序列化的缺省属性语义。 */
function fieldValueJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return canonicalJsonValue(value)
  return canonicalJson(JSON.stringify(value))
}

/** 寄存器缺少因果信息时从同一固定来源补读轻列，不加载来源载荷。 */
function causalMetadata(context: CaptureContext, current: SyncFieldVersionRecord): CausalMetadata {
  let causalContextJson = current.causalContextJson ?? null, logicalClock = current.logicalClock ?? null
  if ((!causalContextJson || logicalClock == null) && current.sourceOperationId) {
    const retained = context.database.prepare('SELECT causal_context_json,logical_clock FROM sync_operation_log WHERE operation_id=? LIMIT 1')
      .get(current.sourceOperationId)
    causalContextJson = retained?.causal_context_json == null ? causalContextJson : String(retained.causal_context_json)
    logicalClock = retained?.logical_clock == null ? logicalClock : Number(retained.logical_clock)
  }
  if (causalContextJson && logicalClock != null) return { causalContextJson, logicalClock }
  const dot = parseOperationVersionToken(current.versionToken)
  if (!dot) return { causalContextJson, logicalClock }
  const pending = context.database.prepare(`SELECT causal_context_json,sequence AS logical_clock FROM sync_outbox
    WHERE sync_space_id=? AND actor_incarnation_id=? AND replication_lane_id=? AND sequence=? LIMIT 1`)
    .get(context.cut.syncSpaceId, dot.actorIncarnationId, dot.replicationLaneId, dot.sequence)
  return { causalContextJson: pending?.causal_context_json == null ? causalContextJson : String(pending.causal_context_json),
    logicalClock: pending?.logical_clock == null ? logicalClock : Number(pending.logical_clock) }
}

/** 沿用原捕获规则：非法旧 token 不可复用，正式字段验证继续决定其可接受性。 */
function versionSource(token: string): 'GENESIS' | 'OPERATION' | null {
  try { return SyncVersionToken.source(token) } catch {
    // 旧寄存器没有合法来源身份，不能把它作为当前 cut 的可复用证据。
    return null
  }
}
