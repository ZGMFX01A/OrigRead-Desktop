import type { DatabaseSync } from 'node:sqlite'
import type { DesktopGenesisCut } from './sync-runtime-coordinator'
import type { SyncReplicationLane } from '../../shared/sync-runtime'
import { snapshotCheckpoint } from './sync-snapshot-execution'

/** 固定 cut 的前沿核对只读取真实 APPLIED 操作的 Dot，不展开操作和 Inbox 正文。 */
export function requireGenesisCutFrontiers(input: { database: DatabaseSync; cut: DesktopGenesisCut }): void {
  const rows = input.database.prepare(`SELECT o.replication_lane_id,o.actor_incarnation_id,o.sequence
    FROM sync_operation_log o JOIN sync_inbox_operation i ON i.operation_id=o.operation_id
    WHERE o.sync_space_id=? AND i.state='APPLIED'
    ORDER BY o.replication_lane_id,o.actor_incarnation_id,o.sequence`).iterate(input.cut.syncSpaceId)
  for (const row of rows) {
    snapshotCheckpoint()
    const lane = String(row.replication_lane_id) as SyncReplicationLane, actor = String(row.actor_incarnation_id)
    const frontier = input.cut.laneFrontiers[lane]?.[actor] ?? 0
    if (Number(row.sequence) > frontier) throw new Error(
      `REBASE_UNSAFE: Snapshot materialized state contains applied Operation ${lane}/${actor}/${row.sequence} beyond declared cut frontier ${frontier}`)
  }
}
