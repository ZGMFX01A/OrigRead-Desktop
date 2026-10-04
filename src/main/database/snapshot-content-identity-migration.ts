import type { DatabaseSync } from 'node:sqlite'

/** 同一 Genesis/策略可产生多个不可变内容版本；bundle 主键保持唯一，所有历史引用及签名原样复制。 */
export function migrateSnapshotContentIdentity(database: DatabaseSync): void {
  database.exec(`CREATE TABLE sync_snapshot_bundle_content (
    snapshot_bundle_id TEXT PRIMARY KEY, sync_space_id TEXT NOT NULL, genesis_session_id TEXT NOT NULL,
    genesis_baseline_id TEXT NOT NULL,
    snapshot_class TEXT NOT NULL CHECK(snapshot_class IN ('WORKING','GC_BASELINE','BOOTSTRAP_RECOVERY')),
    root_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, captured_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    auth_stability_checkpoint_id TEXT) STRICT;
    INSERT INTO sync_snapshot_bundle_content(snapshot_bundle_id,sync_space_id,genesis_session_id,genesis_baseline_id,
      snapshot_class,root_hash,policy_hash,captured_at,created_at,auth_stability_checkpoint_id)
    SELECT snapshot_bundle_id,sync_space_id,genesis_session_id,genesis_baseline_id,
      snapshot_class,root_hash,policy_hash,captured_at,created_at,auth_stability_checkpoint_id FROM sync_snapshot_bundle;
    DROP TABLE sync_snapshot_bundle;
    ALTER TABLE sync_snapshot_bundle_content RENAME TO sync_snapshot_bundle;
    CREATE INDEX sync_snapshot_bundle_space_created_idx ON sync_snapshot_bundle(sync_space_id,created_at);`)
}
