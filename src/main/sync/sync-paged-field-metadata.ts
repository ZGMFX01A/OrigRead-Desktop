import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import { parseOperationVersionToken, SyncVersionToken } from './sync-version-token'

/** 因果元数据沿用协议的六个逻辑 lane，不接受页面编号或未知域。 */
const LANES = ['CORE_META', 'LIBRARY', 'ARTICLE_STATE', 'CONFIG', 'AI_HISTORY', 'AUTH'] as const

/** FV token 与真实实体/字段/lane 绑定；Operation 候选必须携带完整因果证据。 */
export function validatePagedFieldMetadata(lane: string, record: SyncSnapshotRecord): void {
  const value = record.value
  const token = String(value.versionToken)
  if (token.startsWith('GENESIS_V1|')) {
    const parts = token.split('|')
    if (parts.length !== 6 || token !== SyncVersionToken.genesis(parts[1]!, lane as SyncReplicationLane,
      String(value.entitySyncId), String(value.fieldId))) fail()
    return
  }
  const dot = parseOperationVersionToken(token)
  if (!dot || dot.replicationLaneId !== lane || token !== SyncVersionToken.operation(dot.actorIncarnationId,
    lane as SyncReplicationLane, dot.sequence) || typeof value.logicalClock !== 'number' ||
    !Number.isSafeInteger(value.logicalClock) || value.logicalClock < 0 || typeof value.causalContextJson !== 'string') fail()
  validateContext(JSON.parse(value.causalContextJson))
}

/** 禁止重复 lane/actor 被 Map 转换静默折叠，保留作者实际承诺的唯一因果向量。 */
function validateContext(value: unknown): void {
  const context = object(value)
  if (context.schemaVersion !== 1 || !Array.isArray(context.lanes)) fail()
  const lanes = new Set<string>()
  for (const item of context.lanes) {
    const lane = object(item)
    if (!LANES.includes(lane.replicationLaneId as SyncReplicationLane) || lanes.has(String(lane.replicationLaneId)) || !Array.isArray(lane.actors)) fail()
    lanes.add(String(lane.replicationLaneId))
    validateActors(lane.actors)
  }
  if (context.observedGenesisBaselinesByLane != null) validateObserved(context.observedGenesisBaselinesByLane)
}

/** actor 前缀只接受两端精确表示的非负数字。 */
function validateActors(values: unknown[]): void {
  const actors = new Set<string>()
  for (const item of values) {
    const actor = object(item)
    const id = actor.actorIncarnationId
    if (typeof id !== 'string' || !id.trim() || actors.has(id) || typeof actor.prefix !== 'number' ||
      !Number.isSafeInteger(actor.prefix) || actor.prefix < 0) fail()
    actors.add(id)
  }
}

/** 基线观察必须属于真实 lane 且身份唯一，不能用无效 JSON 退化为未观察。 */
function validateObserved(value: unknown): void {
  for (const [lane, ids] of Object.entries(object(value))) {
    if (!LANES.includes(lane as SyncReplicationLane) || !Array.isArray(ids) ||
      ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail()
  }
}

/** JSON 容器必须是对象，不将 null、数组或标量当作空向量。 */
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

/** 缺失因果证据在完整索引发布前显式失败。 */
function fail(): never { throw new Error('SNAPSHOT_CORRUPTED: paged field version has invalid causal metadata') }
