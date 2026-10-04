import type { DatabaseSync } from 'node:sqlite'
import type { SyncCoverageVector } from '../../shared/sync-protocol'
import type { SyncPagedSnapshotManifest } from '../../shared/sync-paged-snapshot'

export interface PagedInstallJournal {
  rootHash: string
  installedLanes: readonly string[]
  previous: SyncCoverageVector
  baselineReady: boolean
}

/** 可恢复记录绑定固定根哈希与安装域，正文保存在专用 records/tail 表。 */
export function readPagedInstallJournal(database: DatabaseSync, manifest: SyncPagedSnapshotManifest): PagedInstallJournal | null {
  const row = database.prepare(`SELECT recovery_state_json,coverage_json,reason FROM sync_recovery_capsule
    WHERE capsule_id=? AND sync_space_id=? AND target_snapshot_bundle_id=?`)
    .get(`paged-install:${manifest.syncSpaceId}:${manifest.snapshotBundleId}`, manifest.syncSpaceId, manifest.snapshotBundleId)
  if (!row) return null
  const state = JSON.parse(String(row.recovery_state_json)) as { rootHash: string; installedLanes: string[] }
  const lanes = manifest.lanes.map(lane => lane.replicationLaneId).sort()
  if (state.rootHash !== manifest.rootHash || JSON.stringify(state.installedLanes) !== JSON.stringify(lanes)) {
    throw new Error('SNAPSHOT_CONFLICT: paged installation retry changed its fixed scope')
  }
  return { ...state, previous: JSON.parse(String(row.coverage_json)) as SyncCoverageVector,
    baselineReady: row.reason === 'SNAPSHOT_BASELINE_READY' || row.reason === 'SNAPSHOT_INSTALL_READY' }
}

/** baseline 完成位必须与真实业务投影提交在同一事务。 */
export function writePagedInstallJournal(database: DatabaseSync, input: {
  manifest: SyncPagedSnapshotManifest; previous: SyncCoverageVector; baselineReady: boolean; now: number
}): void {
  const { manifest } = input
  database.prepare(`INSERT INTO sync_recovery_capsule(capsule_id,sync_space_id,target_snapshot_bundle_id,
    coverage_json,operation_ids_json,pending_outbox_ids_json,recovery_state_json,reason,created_at)
    VALUES(?,?,?,?,'[]','[]',?,?,?) ON CONFLICT(capsule_id) DO UPDATE SET
      coverage_json=excluded.coverage_json,recovery_state_json=excluded.recovery_state_json,reason=excluded.reason`)
    .run(`paged-install:${manifest.syncSpaceId}:${manifest.snapshotBundleId}`, manifest.syncSpaceId, manifest.snapshotBundleId,
      JSON.stringify(input.previous), JSON.stringify({ rootHash: manifest.rootHash,
        installedLanes: manifest.lanes.map(lane => lane.replicationLaneId).sort() }),
      input.baselineReady ? 'SNAPSHOT_BASELINE_READY' : 'SNAPSHOT_INSTALL_STARTED', input.now)
}
