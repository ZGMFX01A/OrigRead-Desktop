import type { SyncPagedSnapshotStore } from './sync-paged-snapshot-store'
import type { DatabaseSync } from 'node:sqlite'

/** 完整固定视图必须为每个业务字段携带候选，合并不能默默偏向有候选的一端。 */
export function requirePagedEntityEvidence(input: { store: SyncPagedSnapshotStore; database: DatabaseSync; bundleId: string }): void {
  const { store, database, bundleId } = input
  const query = database.prepare(`SELECT 1 FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=?
    AND kind='FIELD_VERSION' AND entity_type=? AND entity_sync_id=? AND generation=? AND field_id=? LIMIT 1`)
  for (const entity of store.records({ snapshotBundleId: bundleId, kind: 'ENTITY' })) {
    for (const [field, value] of Object.entries(entity.value.fields as Record<string, unknown>)) {
      if (entity.value.entityType === 'article' && field === 'fullContentHash' && value == null) continue
      const fieldId = entity.value.entityType === 'article' && field === 'fullContentHash' ? 'fullContentHtml' : field
      const candidate = query.get(bundleId, String(entity.value.entityType), String(entity.value.entitySyncId), Number(entity.value.generation), fieldId)
      if (!candidate) throw new Error('SNAPSHOT_CORRUPTED: entity field has no causal candidate ' + entity.value.entityType + '/' + field)
    }
  }
}
