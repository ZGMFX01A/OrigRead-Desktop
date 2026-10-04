import type { DatabaseSync } from 'node:sqlite'

/** 原生字段语句属于具体连接，固定来源与活库不会共享同一语句。 */
export function fieldVersionStatements(database: DatabaseSync) {
  return {
    find: database.prepare(`SELECT * FROM sync_field_version
      WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? AND field_id=? LIMIT 1`),
    retain: database.prepare(`INSERT INTO sync_field_candidate
      (sync_space_id,entity_type,entity_sync_id,field_id,entity_generation,version_token,
       source_operation_id,value_json,updated_at,causal_context_json,logical_clock)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id,entity_generation,field_id,version_token)
      DO UPDATE SET source_operation_id=excluded.source_operation_id,
        causal_context_json=COALESCE(excluded.causal_context_json,sync_field_candidate.causal_context_json),
        logical_clock=COALESCE(excluded.logical_clock,sync_field_candidate.logical_clock)`),
    upsert: database.prepare(`INSERT INTO sync_field_version(
        sync_space_id,entity_type,entity_sync_id,field_id,entity_generation,version_token,source_operation_id,value_json,
        causal_context_json,logical_clock,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sync_space_id,entity_type,entity_sync_id,field_id) DO UPDATE SET
        entity_generation=excluded.entity_generation,version_token=excluded.version_token,
        source_operation_id=excluded.source_operation_id,value_json=excluded.value_json,
        causal_context_json=excluded.causal_context_json,logical_clock=excluded.logical_clock,
        updated_at=excluded.updated_at`)
  }
}
