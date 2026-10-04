import type { DatabaseSync } from 'node:sqlite'
import type { SyncOperationRecord } from '../../shared/sync-runtime'

/** 已认证冲突证据独立提交，不能随被拒绝的业务事务回滚。 */
export function isolateActor(database: DatabaseSync, input: { first: SyncOperationRecord; second: SyncOperationRecord; now: number }): void {
  const { first, second, now } = input
  database.prepare('INSERT OR IGNORE INTO sync_actor_isolation VALUES(?,?,?,?,?,?,?)').run(
    second.syncSpaceId, second.actorIncarnationId, second.replicationLaneId, second.sequence,
    first.signingDigest, second.signingDigest, now)
}

/** 同步核验、Apply 与 Relay 共用持久隔离门禁；其他 actor 继续正常处理。 */
export function actorIsolated(database: DatabaseSync, input: { space: string; actor: string }): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sync_actor_isolation WHERE sync_space_id=? AND actor_incarnation_id=?')
    .get(input.space, input.actor))
}
