import { SNAPSHOT_DERIVED_SCHEMA } from './snapshot-derived-schema'

/** 字节页、逻辑 lane 与记录索引独立持久化，所有业务库迁移和运行时使用同一结构。 */
export const PAGED_SNAPSHOT_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_paged_snapshot (
 snapshot_bundle_id TEXT PRIMARY KEY, sync_space_id TEXT NOT NULL,
 manifest_json TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_paged_snapshot_page (
 snapshot_bundle_id TEXT NOT NULL, replication_lane_id TEXT NOT NULL,
 page_index INTEGER NOT NULL, content_hash TEXT NOT NULL, bytes BLOB NOT NULL,
 PRIMARY KEY(snapshot_bundle_id,replication_lane_id,page_index));
CREATE TABLE IF NOT EXISTS sync_paged_snapshot_record (
 snapshot_bundle_id TEXT NOT NULL, replication_lane_id TEXT NOT NULL,
 kind TEXT NOT NULL, record_key TEXT NOT NULL, content_hash TEXT NOT NULL,
 entity_type TEXT, entity_sync_id TEXT, generation INTEGER, field_id TEXT, blob_hash TEXT,
 record_json TEXT NOT NULL,
 PRIMARY KEY(snapshot_bundle_id,replication_lane_id,kind,record_key));
CREATE INDEX IF NOT EXISTS index_sync_paged_record_entity ON sync_paged_snapshot_record
 (snapshot_bundle_id,replication_lane_id,entity_type,entity_sync_id,generation,kind);
CREATE INDEX IF NOT EXISTS index_sync_paged_record_business ON sync_paged_snapshot_record
 (snapshot_bundle_id,entity_type,entity_sync_id,generation,kind,field_id);
CREATE INDEX IF NOT EXISTS index_sync_paged_record_order ON sync_paged_snapshot_record
 (snapshot_bundle_id,replication_lane_id,kind,entity_type,entity_sync_id,generation,record_key);
CREATE TABLE IF NOT EXISTS sync_paged_snapshot_tail (
 snapshot_bundle_id TEXT NOT NULL, operation_id TEXT NOT NULL, replication_lane_id TEXT NOT NULL,
 actor_incarnation_id TEXT NOT NULL, sequence INTEGER NOT NULL, operation_json TEXT NOT NULL,
 replay_required INTEGER NOT NULL, replayed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(snapshot_bundle_id,operation_id),
 UNIQUE(snapshot_bundle_id,replication_lane_id,actor_incarnation_id,sequence));
CREATE TABLE IF NOT EXISTS sync_snapshot_source(source_key TEXT PRIMARY KEY,envelope_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_snapshot_source_link(snapshot_bundle_id TEXT NOT NULL,replication_lane_id TEXT NOT NULL,
 record_key TEXT NOT NULL,source_key TEXT NOT NULL,PRIMARY KEY(snapshot_bundle_id,replication_lane_id,record_key));
CREATE INDEX IF NOT EXISTS sync_snapshot_source_link_source ON sync_snapshot_source_link(source_key);
CREATE INDEX IF NOT EXISTS sync_snapshot_source_link_field_order ON sync_snapshot_source_link(snapshot_bundle_id,replication_lane_id,source_key,record_key);
CREATE TABLE IF NOT EXISTS sync_snapshot_batch_progress(job_id TEXT NOT NULL,phase TEXT NOT NULL,cursor TEXT NOT NULL,PRIMARY KEY(job_id,phase));
` + SNAPSHOT_DERIVED_SCHEMA
