import type { SyncSnapshotLanePages } from '../../shared/sync-paged-snapshot'

/** 分页格式只接受一个真实 lane 的规范 frontier 行，不沿用历史短期对象格式。 */
export function decodePagedFrontier(lane: SyncSnapshotLanePages): Readonly<Record<string, number>> {
  const rows: unknown = JSON.parse(lane.frontierJson)
  if (!Array.isArray(rows) || rows.length !== 1) fail()
  const row = rows[0]
  if (!row || typeof row !== 'object' || row.replicationLaneId !== lane.replicationLaneId ||
    !row.actorFrontiers || typeof row.actorFrontiers !== 'object' || Array.isArray(row.actorFrontiers)) fail()
  for (const [actor, prefix] of Object.entries(row.actorFrontiers)) {
    if (!actor.trim() || typeof prefix !== 'number' || !Number.isSafeInteger(prefix) || prefix < 0) fail()
  }
  return row.actorFrontiers as Readonly<Record<string, number>>
}

/** 输入不完整或重复 lane 时拒绝，不能由 associate/覆盖赋值掩盖冲突。 */
function fail(): never { throw new Error('SNAPSHOT_CORRUPTED: invalid paged Snapshot logical frontier') }
