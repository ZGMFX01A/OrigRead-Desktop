import type { DatabaseSync } from 'node:sqlite'

interface Source { table: string; identity: readonly string[]; semantic: readonly string[] }
interface Trigger { table: string; suffix: string; event: string; condition: string; space: string }

/** 修订与真实写入在同一事务提交，普通显示名、时间戳和业务内容不参与权限修订。 */
export function migrateSnapshotAuthority(database: DatabaseSync): void {
  // 早期库可能缺少独立偏好表；补齐正式 schema 后才能建立政策修订触发器。
  database.exec(`CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)`)
  database.exec('CREATE TABLE IF NOT EXISTS sync_snapshot_authority_revision(space TEXT PRIMARY KEY,revision INTEGER NOT NULL)')
  for (const source of SOURCES) installSource(database, source)
  installPolicy(database)
  database.exec(`CREATE TABLE IF NOT EXISTS sync_snapshot_body_obligation(
    space TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,field TEXT NOT NULL,generation INTEGER NOT NULL,
    hash TEXT NOT NULL,bytes INTEGER NOT NULL,bundle TEXT NOT NULL,state TEXT NOT NULL,
    PRIMARY KEY(space,type,id,field))`)
}

/** 全部 authority 表使用完整主键及语义列比较，同值 UPSERT 不会无故失效。 */
function installSource(database: DatabaseSync, source: Source): void {
  const identity = source.identity.map(column => `${column} IS NEW.${column}`).join(' AND ')
  const same = source.semantic.map(column => `${column} IS NEW.${column}`).join(' AND ')
  trigger(database, { table: source.table, suffix: 'insert', event: 'BEFORE INSERT', space: 'NEW.sync_space_id',
    condition: `NOT EXISTS(SELECT 1 FROM ${source.table} WHERE ${identity} AND ${same})` })
  trigger(database, { table: source.table, suffix: 'update', event: 'AFTER UPDATE', space: 'NEW.sync_space_id',
    condition: [...new Set([...source.identity, ...source.semantic])].map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ') })
  trigger(database, { table: source.table, suffix: 'delete', event: 'AFTER DELETE', space: 'OLD.sync_space_id', condition: '1' })
  trigger(database, { table: source.table, suffix: 'old_space', event: 'AFTER UPDATE', space: 'OLD.sync_space_id',
    condition: 'OLD.sync_space_id IS NOT NEW.sync_space_id' })
  trigger(database, { table: source.table, suffix: 'replace_old_space', event: 'BEFORE INSERT',
    space: `(SELECT sync_space_id FROM ${source.table} WHERE ${identity})`,
    condition: `EXISTS(SELECT 1 FROM ${source.table} WHERE ${identity} AND sync_space_id IS NOT NEW.sync_space_id)` })
}

/** 策略修订只监听同步政策键，更新其他产品偏好不会使授权证明失效。 */
function installPolicy(database: DatabaseSync): void {
  const prefix = 'sync.lane-policy:'
  const next = `substr(NEW.key,${prefix.length + 1})`
  const old = `substr(OLD.key,${prefix.length + 1})`
  trigger(database, { table: 'app_settings', suffix: 'insert', event: 'BEFORE INSERT', space: next,
    condition: `NEW.key LIKE '${prefix}%' AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key=NEW.key AND value IS NEW.value)` })
  trigger(database, { table: 'app_settings', suffix: 'update', event: 'AFTER UPDATE', space: next,
    condition: `NEW.key LIKE '${prefix}%' AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)` })
  trigger(database, { table: 'app_settings', suffix: 'delete', event: 'AFTER DELETE', space: old, condition: `OLD.key LIKE '${prefix}%'` })
  trigger(database, { table: 'app_settings', suffix: 'old_key', event: 'AFTER UPDATE', space: old,
    condition: `OLD.key LIKE '${prefix}%' AND OLD.key IS NOT NEW.key` })
}

/** SQL 标识符来自固定 schema 清单，空间值从真实写入列取出。 */
function trigger(database: DatabaseSync, input: Trigger): void {
  database.exec(`CREATE TRIGGER IF NOT EXISTS ${input.table}_snapshot_authority_${input.suffix}
    ${input.event} ON ${input.table} WHEN ${input.condition} BEGIN
    INSERT INTO sync_snapshot_authority_revision VALUES(${input.space},1)
    ON CONFLICT(space) DO UPDATE SET revision=revision+1; END`)
}

/** 授权、actor 完整性与本机绑定共同决定快照安装权威。 */
const SOURCES: readonly Source[] = [
  { table: 'sync_auth_ledger', identity: ['auth_object_id'], semantic: ['sync_space_id', 'auth_object_json'] },
  { table: 'sync_peer_identity', identity: ['sync_space_id', 'device_id'], semantic: ['public_key_spki_base64', 'status', 'auth_epoch'] },
  { table: 'sync_actor_author', identity: ['sync_space_id', 'actor_incarnation_id'], semantic: ['author_device_id'] },
  { table: 'sync_actor_incarnation', identity: ['actor_incarnation_id'], semantic: ['sync_space_id', 'device_id', 'status'] },
  { table: 'sync_actor_isolation', identity: ['sync_space_id', 'actor_incarnation_id'], semantic: ['first_digest', 'second_digest'] },
  { table: 'sync_local_space_binding', identity: ['local_account_id'], semantic: ['sync_space_id', 'lifecycle_state'] }
]
