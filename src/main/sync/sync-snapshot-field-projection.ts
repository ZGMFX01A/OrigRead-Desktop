import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { SnapshotFieldMetadata } from './sync-snapshot-derived-facts'

/** 每个轻量项最多内联 2 KiB 因果文本；长单条继续单独读取，不截断其证据。 */
const INLINE_CAUSAL_BYTES = 2048
/** r/f 均为固定派生表别名；值和来源正文不进入 256 项的批查询。 */
export const SNAPSHOT_FIELD_PROJECTION = `r.entity_type,r.entity_sync_id,r.generation,r.field_id,
  f.rowid AS field_rowid,f.version_token,f.logical_clock,f.value_digest,f.preference_value_json,
  length(CAST(f.causal_context_json AS BLOB)) AS causal_bytes,
  CASE WHEN length(CAST(f.causal_context_json AS BLOB))<=${INLINE_CAUSAL_BYTES} THEN f.causal_context_json END AS causal_json`

/** LEFT JOIN 的缺失事实必须拒绝；批游标关闭后才读取合法长单条的完整因果上下文。 */
export function projectedSnapshotField(input: {
  database: DatabaseSync; bundle: string; lane: string; row: Readonly<Record<string, SQLOutputValue>>
}): SnapshotFieldMetadata {
  const row = input.row
  if (row.field_rowid == null) throw new Error('SNAPSHOT_CORRUPTED: field causal index is missing')
  let causalContextJson = row.causal_json == null ? null : String(row.causal_json)
  if (Number(row.causal_bytes) > INLINE_CAUSAL_BYTES) {
    const large = input.database.prepare('SELECT causal_context_json FROM sync_snapshot_field_index WHERE rowid=?').get(row.field_rowid)
    if (large?.causal_context_json == null) throw new Error('SNAPSHOT_CORRUPTED: long field causal context disappeared')
    causalContextJson = String(large.causal_context_json)
  }
  return { bundle: input.bundle, lane: input.lane, key: String(row.record_key),
    entityType: String(row.entity_type), entitySyncId: String(row.entity_sync_id), generation: Number(row.generation),
    fieldId: String(row.field_id), versionToken: String(row.version_token), logicalClock: Number(row.logical_clock),
    causalContextJson, valueDigest: String(row.value_digest), preferenceValueJson: String(row.preference_value_json) }
}
