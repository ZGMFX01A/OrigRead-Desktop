import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { SyncOperationEnvelope } from '../../shared/sync-protocol'
import type { SyncSnapshotSourcePool } from './sync-snapshot-source-pool'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'
import { snapshotCheckpoint } from './sync-snapshot-execution'
import { SNAPSHOT_FIELD_PROJECTION, projectedSnapshotField } from './sync-snapshot-field-projection'

interface Input { readonly bundle: string; readonly lane: string; readonly sourceAfter?: string }
interface Key { source_key: string; record_key: string; row: Readonly<Record<string, SQLOutputValue>> }
export interface SnapshotFieldEvidence { readonly field: SnapshotFieldMetadata; readonly source: SyncOperationEnvelope | null; readonly sourceKey: string }
interface Dependencies { readonly database: DatabaseSync; readonly sources: SyncSnapshotSourcePool }

/** 字段按完整签名来源键排序；当前大载荷只解码一次，不积累整库来源对象。 */
export function* readSnapshotFieldEvidence(deps: Dependencies, input: Input): Generator<SnapshotFieldEvidence> {
  let previous: string | undefined
  let source: SyncOperationEnvelope | null = null
  for (const key of keys(deps.database, input)) {
    snapshotCheckpoint()
    if (key.source_key !== previous) {
      previous = key.source_key
      source = previous ? deps.sources.read(previous) : null
    }
    yield { field: projectedSnapshotField({ database: deps.database, bundle: input.bundle, lane: input.lane, row: key.row }),
      source, sourceKey: key.source_key }
  }
}

/** 两段索引只批读轻量元数据，所有 SQLite 读取在调用方消费前已经结束。 */
function* keys(database: DatabaseSync, input: Input): Generator<Key> {
  for (const pooled of [false, true]) {
    if (!pooled && input.sourceAfter) continue
    let after: Key | undefined
    while (true) {
      const seek = !after ? '' : pooled ? ' AND (l.source_key,l.record_key)>(?,?)' : ' AND r.record_key>?'
      const completed = pooled && input.sourceAfter ? ' AND l.source_key>?' : ''
      const fieldJoin = `LEFT JOIN sync_snapshot_field_index f ON f.snapshot_bundle_id=r.snapshot_bundle_id
        AND f.replication_lane_id=r.replication_lane_id AND f.record_key=r.record_key`
      const sql = pooled ? `SELECT l.source_key,l.record_key,${SNAPSHOT_FIELD_PROJECTION} FROM sync_snapshot_source_link l
        JOIN sync_paged_snapshot_record r ON r.snapshot_bundle_id=l.snapshot_bundle_id AND r.replication_lane_id=l.replication_lane_id
          AND r.record_key=l.record_key AND r.kind='FIELD_VERSION' ${fieldJoin}
        WHERE l.snapshot_bundle_id=? AND l.replication_lane_id=?${completed}${seek} ORDER BY l.source_key,l.record_key LIMIT ${BATCH_ROWS}` :
        `SELECT '' AS source_key,r.record_key,${SNAPSHOT_FIELD_PROJECTION} FROM sync_paged_snapshot_record r ${fieldJoin}
        WHERE r.snapshot_bundle_id=? AND r.replication_lane_id=? AND r.kind='FIELD_VERSION'${seek}
          AND NOT EXISTS(SELECT 1 FROM sync_snapshot_source_link l WHERE l.snapshot_bundle_id=r.snapshot_bundle_id
          AND l.replication_lane_id=r.replication_lane_id AND l.record_key=r.record_key)
        ORDER BY r.record_key LIMIT ${BATCH_ROWS}`
      const args = after ? pooled ? [after.source_key, after.record_key] : [after.record_key] : []
      // all 已结束 SQLite 游标；每项只带有界轻列，长因果文本另走单条完整读取。
      const batch = database.prepare(sql).all(input.bundle, input.lane, ...(completed ? [input.sourceAfter!] : []), ...args)
        .map(row => ({ source_key: String(row.source_key), record_key: String(row.record_key), row }))
      if (!batch.length) break
      yield* batch
      after = batch.at(-1)!
    }
  }
}

/** 每个来源分组最多持有一个轻量键批次。 */
const BATCH_ROWS = 256
