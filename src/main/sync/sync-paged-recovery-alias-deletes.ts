import type { RecoveryIndex } from './sync-paged-recovery-entities'
import { snapshotRecordKey } from './sync-snapshot-records'
import { commitSnapshotBatch } from './sync-snapshot-batch-progress'
import { decodeSnapshotRecord } from './sync-snapshot-records'

/** 别名输入只预取轻量、独立冻结的删除见证。 */
const DELETION_BATCH_ROWS = 256

/** 别名组件同代次 delete-wins 先于依赖图传播，不能留下另一个逻辑身份的活行。 */
export function reconcilePagedAliasDeletes(index: RecoveryIndex): void {
  index.database.exec(`CREATE TEMP TABLE IF NOT EXISTS sync_recovery_alias_index(
    entity_type TEXT,generation INTEGER,left_id TEXT,right_id TEXT,PRIMARY KEY(entity_type,generation,left_id,right_id))`)
  index.database.exec('DELETE FROM sync_recovery_alias_index')
  for (const edge of index.store.records({ snapshotBundleId: index.workId, kind: 'ALIAS_EDGE' })) {
    const value = edge.value
    index.database.prepare('INSERT OR IGNORE INTO sync_recovery_alias_index VALUES(?,?,?,?)')
      .run(String(value.targetEntityType), Number(value.leftGeneration), String(value.leftSyncId), String(value.rightSyncId))
  }
  frozenDeletions(index)
  index.database.exec('DELETE FROM sync_recovery_alias_index')
}

/** 工作墓碑的原地重建不能改变尚未消费的删除输入。 */
function frozenDeletions(index: RecoveryIndex): void {
  index.database.exec('CREATE TEMP TABLE IF NOT EXISTS sync_recovery_alias_seed(record_json TEXT NOT NULL)')
  index.database.exec('DELETE FROM sync_recovery_alias_seed')
  index.database.prepare("INSERT INTO sync_recovery_alias_seed SELECT record_json FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=? AND kind='TOMBSTONE' ORDER BY replication_lane_id,record_key").run(index.workId)
  let after = 0
  try {
    for (;;) {
      const rows = index.database.prepare(`SELECT rowid,record_json FROM sync_recovery_alias_seed WHERE rowid>? ORDER BY rowid LIMIT ${DELETION_BATCH_ROWS}`).all(after)
      if (!rows.length) break
      for (const row of rows) reconcileComponent(index, decodeSnapshotRecord(String(row.record_json)).value)
      after = Number(rows.at(-1)!.rowid)
    }
  } finally {
    // 临时输入不进入输出，失败的真实工作索引和断点保持可恢复。
    index.database.exec('DELETE FROM sync_recovery_alias_seed')
  }
}

/** 临时索引只有轻量端点，连通组件不读取正文或全部历史字段。 */
function reconcileComponent(index: RecoveryIndex, deletion: Record<string, unknown>): void {
  const type = String(deletion.entityType), generation = Number(deletion.generation)
  const members = index.database.prepare(`WITH RECURSIVE members(id) AS (
    SELECT ? UNION SELECT CASE WHEN a.left_id=m.id THEN a.right_id ELSE a.left_id END
      FROM sync_recovery_alias_index a JOIN members m ON a.left_id=m.id OR a.right_id=m.id
      WHERE a.entity_type=? AND a.generation=?) SELECT id FROM members ORDER BY id`)
    .all(String(deletion.entitySyncId), type, generation).map(row => String(row.id))
  if (members.length === 1) return
  let witness = deletion
  for (const id of members) {
    const record = index.store.records({ snapshotBundleId: index.workId, entityType: type,
      entitySyncId: id, generation, kind: 'TOMBSTONE' }).next().value
    if (record && String(record.value.versionToken) > String(witness.versionToken)) witness = record.value
  }
  for (const entitySyncId of members) {
    const row = index.database.prepare(`SELECT replication_lane_id FROM sync_paged_snapshot_record
      WHERE snapshot_bundle_id=? AND entity_type=? AND entity_sync_id=? AND generation=? LIMIT 1`)
      .get(index.workId, type, entitySyncId, generation)
    if (!row) continue
    const value = { ...witness, entitySyncId }
    const prepared = index.store.prepareRecord({ snapshotBundleId: index.workId, lane: String(row.replication_lane_id),
      record: { kind: 'TOMBSTONE', key: snapshotRecordKey('TOMBSTONE', value), value } })
    commitSnapshotBatch(index.database, { job: index.workId, phase: `alias-delete:${type}:${generation}`, cursor: entitySyncId,
      budget: index.store.lifecycle.budget }, () => {
    index.database.prepare(`DELETE FROM sync_paged_snapshot_record WHERE snapshot_bundle_id=?
      AND entity_type=? AND entity_sync_id=? AND generation=? AND kind IN ('ENTITY','FIELD_VERSION','TOMBSTONE')`)
      .run(index.workId, type, entitySyncId, generation)
    index.store.writePrepared(prepared)
    })
  }
}
