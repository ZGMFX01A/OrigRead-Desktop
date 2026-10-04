import type { DatabaseSync } from 'node:sqlite'

/** R10/R11 加性升级：保留历史 Dot、密钥、配置及旧 ACK，新增隔离和增量进度。 */
export function migrateSyncIntegrity(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_config_document(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS sync_actor_isolation(
      sync_space_id TEXT NOT NULL,actor_incarnation_id TEXT NOT NULL,
      replication_lane_id TEXT NOT NULL,sequence INTEGER NOT NULL,
      first_digest TEXT NOT NULL,second_digest TEXT NOT NULL,detected_at INTEGER NOT NULL,
      PRIMARY KEY(sync_space_id,actor_incarnation_id)) STRICT;
    CREATE INDEX IF NOT EXISTS sync_operation_push_range ON sync_operation_log(sync_space_id,build_status,replication_lane_id,actor_incarnation_id,sequence);
    CREATE INDEX IF NOT EXISTS sync_inbox_prefix ON sync_inbox_operation(sync_space_id,replication_lane_id,actor_incarnation_id,sequence,state);
    CREATE TRIGGER IF NOT EXISTS sync_inbox_rejection_rewind AFTER UPDATE OF state ON sync_inbox_operation
    WHEN NEW.state='REJECTED' AND OLD.state<>'REJECTED'
    BEGIN
      UPDATE sync_coverage SET applied_prefix=MIN(applied_prefix,NEW.sequence-1),
        retained_prefix=MIN(retained_prefix,NEW.sequence-1)
      WHERE sync_space_id=NEW.sync_space_id AND replication_lane_id=NEW.replication_lane_id
        AND actor_incarnation_id=NEW.actor_incarnation_id;
    END;
  `)
  addMissingColumns(database)
}

/** 加性迁移可重入；历史 ACK 表重建与 schema 版本回放不会重复添加已经存在的列。 */
function addMissingColumns(database: DatabaseSync): void {
  const additions = [
    { table: 'sync_coverage', name: 'processed_prefix', type: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'sync_blob_persisted_ack', name: 'storage_generation', type: 'TEXT' },
    { table: 'sync_blob_persisted_ack', name: 'custody_state', type: 'TEXT' }
  ]
  for (const column of additions) {
    const present = database.prepare(`PRAGMA table_info(${column.table})`).all().some(row => row.name === column.name)
    if (!present) database.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.type}`)
  }
}
