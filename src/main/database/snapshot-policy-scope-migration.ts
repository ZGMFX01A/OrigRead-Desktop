import type { DatabaseSync } from 'node:sqlite'
import { PAGED_SNAPSHOT_STORE_SCHEMA } from './paged-snapshot-schema'

/** 同一固定基线允许不同 lane 策略的独立签名视图，历史基线和签名摘要全部原样保留。 */
export function migrateSnapshotPolicyScope(database: DatabaseSync): void {
  database.exec(PAGED_SNAPSHOT_STORE_SCHEMA)
  database.exec(`CREATE TABLE sync_snapshot_bundle_scoped (
    snapshot_bundle_id TEXT PRIMARY KEY, sync_space_id TEXT NOT NULL, genesis_session_id TEXT NOT NULL,
    genesis_baseline_id TEXT NOT NULL,
    snapshot_class TEXT NOT NULL CHECK(snapshot_class IN ('WORKING','GC_BASELINE','BOOTSTRAP_RECOVERY')),
    root_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, captured_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    auth_stability_checkpoint_id TEXT,
    UNIQUE(sync_space_id,genesis_baseline_id,snapshot_class,policy_hash)) STRICT;
    INSERT INTO sync_snapshot_bundle_scoped(snapshot_bundle_id,sync_space_id,genesis_session_id,genesis_baseline_id,
      snapshot_class,root_hash,policy_hash,captured_at,created_at,auth_stability_checkpoint_id)
    SELECT snapshot_bundle_id,sync_space_id,genesis_session_id,genesis_baseline_id,
      snapshot_class,root_hash,policy_hash,captured_at,created_at,auth_stability_checkpoint_id FROM sync_snapshot_bundle;
    DROP TABLE sync_snapshot_bundle;
    ALTER TABLE sync_snapshot_bundle_scoped RENAME TO sync_snapshot_bundle;
    CREATE INDEX sync_snapshot_bundle_space_created_idx ON sync_snapshot_bundle(sync_space_id,created_at);`)
}
