import type { DatabaseSync } from 'node:sqlite'

export interface SnapshotInstallReady {
  snapshotBundleId: string
  rootHash: string
  installedLanes: string[]
}

/** Local recovery journal, committed together with the STAGING transition. */
export function recordSnapshotInstallReady(database: DatabaseSync, space: string, ready: SnapshotInstallReady, now: number): void {
  database.prepare(`INSERT INTO sync_recovery_capsule(capsule_id,sync_space_id,target_snapshot_bundle_id,
    coverage_json,operation_ids_json,pending_outbox_ids_json,recovery_state_json,reason,created_at)
    VALUES(?,?,?,'{}','[]','[]',?,'SNAPSHOT_INSTALL_READY',?)
    ON CONFLICT(capsule_id) DO UPDATE SET target_snapshot_bundle_id=excluded.target_snapshot_bundle_id,
      recovery_state_json=excluded.recovery_state_json,created_at=excluded.created_at`)
    .run(`snapshot-install:${space}`, space, ready.snapshotBundleId,
      JSON.stringify({ rootHash: ready.rootHash, installedLanes: [...ready.installedLanes].sort() }), now)
}

export function readSnapshotInstallReady(database: DatabaseSync, space: string): SnapshotInstallReady | null {
  const row = database.prepare(`SELECT target_snapshot_bundle_id,recovery_state_json FROM sync_recovery_capsule
    WHERE capsule_id=? AND sync_space_id=? AND reason='SNAPSHOT_INSTALL_READY'`)
    .get(`snapshot-install:${space}`, space) as { target_snapshot_bundle_id: string; recovery_state_json: string } | undefined
  if (!row) return null
  const state = JSON.parse(row.recovery_state_json) as { rootHash: string; installedLanes: string[] }
  if (typeof state.rootHash !== 'string' || !Array.isArray(state.installedLanes) ||
    !state.installedLanes.every(lane => typeof lane === 'string')) throw new Error('Invalid Snapshot install journal')
  return { snapshotBundleId: row.target_snapshot_bundle_id, rootHash: state.rootHash, installedLanes: state.installedLanes }
}
