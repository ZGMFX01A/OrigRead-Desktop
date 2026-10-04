import type { DatabaseSync } from 'node:sqlite'
import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import { requirePagedEntityEvidence } from './sync-paged-entity-evidence'

/** 独立字段和 Blob 引用必须关联同快照中存在的实体/manifest。 */
export function requireSnapshotAssociations(input: { database: DatabaseSync; store: SyncPagedSnapshotStore; bundle: string }): void {
  const { database, store, bundle } = input
  requirePagedEntityEvidence({ store, database, bundleId: bundle })
  const orphan = database.prepare(`SELECT 1 FROM sync_paged_snapshot_record r
    WHERE r.snapshot_bundle_id=? AND r.kind IN ('FIELD_VERSION','BLOB_REFERENCE') AND NOT EXISTS (
      SELECT 1 FROM sync_paged_snapshot_record e WHERE e.snapshot_bundle_id=r.snapshot_bundle_id
        AND e.replication_lane_id=r.replication_lane_id AND e.kind='ENTITY'
        AND e.entity_type=r.entity_type AND e.entity_sync_id=r.entity_sync_id AND e.generation=r.generation)
    LIMIT 1`).get(bundle)
  if (orphan) throw new Error('SNAPSHOT_CORRUPTED: Snapshot metadata has no matching entity generation')
  const missingBlob = database.prepare(`SELECT 1 FROM sync_paged_snapshot_record r
    WHERE r.snapshot_bundle_id=? AND r.kind='BLOB_REFERENCE' AND NOT EXISTS (
      SELECT 1 FROM sync_paged_snapshot_record m WHERE m.snapshot_bundle_id=r.snapshot_bundle_id
        AND m.replication_lane_id=r.replication_lane_id AND m.kind='BLOB_MANIFEST' AND m.blob_hash=r.blob_hash) LIMIT 1`).get(bundle)
  if (missingBlob) throw new Error('SNAPSHOT_CORRUPTED: Snapshot reference has no Blob manifest')
}
