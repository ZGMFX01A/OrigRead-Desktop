import type { RecoveryIndex } from './sync-paged-recovery-entities'
import type { SyncSnapshotRecord } from '../../shared/sync-paged-snapshot'
import { PAGED_ENTITY_DEPENDENCY_ORDER } from './sync-paged-entity-dependencies'
import type { SnapshotEntityMetadata } from './sync-snapshot-derived-facts'
import { snapshotRecordKey } from './sync-snapshot-records'
import { commitSnapshotBatch } from './sync-snapshot-batch-progress'

/** 删除父实体的恢复不能留下失效子实体；真实父删除见证逐层传播并清理候选。 */
export function reconcilePagedRecoveryGraph(index: RecoveryIndex): void {
  for (const type of PAGED_ENTITY_DEPENDENCY_ORDER) {
    for (const entity of index.store.derived.entities({ snapshotBundleId: index.workId, entityType: type })) {
      const deletion = parentDeletion(index, entity)
      if (!deletion) continue
      const value = { entityType: entity.entityType, entitySyncId: entity.entitySyncId,
        generation: entity.generation, versionToken: deletion.value.versionToken, deletedAt: deletion.value.deletedAt }
      const lane = entity.lane
      const prepared = index.store.prepareRecord({ snapshotBundleId: index.workId, lane,
        record: { kind: 'TOMBSTONE', key: snapshotRecordKey('TOMBSTONE', value), value } })
      commitSnapshotBatch(index.database, { job: index.workId, phase: `graph-delete:${type}`, cursor: String(value.entitySyncId),
        budget: index.store.lifecycle.budget }, () => {
      index.database.prepare(`DELETE FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND replication_lane_id=?
        AND entity_type=? AND entity_sync_id=? AND kind IN ('ENTITY','FIELD_VERSION')`)
        .run(index.workId, lane, value.entityType as string, value.entitySyncId as string)
      index.store.writePrepared(prepared)
      })
    }
  }
}

/** 代次不匹配必须有输入里的真实删除证明，缺失父实体不能靠任意默认实体补齐。 */
function parentDeletion(index: RecoveryIndex, entity: SnapshotEntityMetadata): SyncSnapshotRecord | undefined {
  for (const dependency of entity.parents) {
    const filter = { snapshotBundleId: index.workId, entityType: dependency.entityType, entitySyncId: dependency.entitySyncId }
    const parent = index.store.derived.entities(filter).next().value
    if (parent && (dependency.generation == null || parent.generation === dependency.generation)) continue
    for (const bundleId of [index.workId, index.localId, index.targetId]) {
      const deletion = index.store.records({ ...filter, snapshotBundleId: bundleId, kind: 'TOMBSTONE', generation: dependency.generation }).next().value
      if (deletion) return deletion
    }
    throw new Error('SNAPSHOT_CORRUPTED: recovery entity has missing parent or mismatched generation')
  }
  return undefined
}
