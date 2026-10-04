import type { DatabaseSync } from 'node:sqlite'

interface Input { readonly operationIds: readonly string[]; readonly completedAt: number }
export interface AppliedInboxScope { readonly space: string; readonly lane: string; readonly actor: string }

/** Snapshot 的全部 effect 已在事务外验证；本批只更新真实 Inbox，并返回需要推进的作者/域。 */
export function markInboxAppliedBatch(database: DatabaseSync, input: Input): readonly AppliedInboxScope[] {
  if (!database.isTransaction) throw new Error('Snapshot Inbox batch requires its receipt transaction')
  const read = database.prepare('SELECT sync_space_id,replication_lane_id,actor_incarnation_id,state FROM sync_inbox_operation WHERE operation_id=?')
  const update = database.prepare(`UPDATE sync_inbox_operation SET state='APPLIED',applied_at=?,last_error=NULL
    WHERE operation_id=? AND state='PENDING'`)
  const scopes = new Map<string, AppliedInboxScope>()
  for (const operationId of input.operationIds) {
    const row = read.get(operationId)
    if (!row || !['PENDING', 'APPLIED'].includes(String(row.state))) throw new Error(`SNAPSHOT_EFFECT_SOURCE_REJECTED: ${operationId}`)
    update.run(input.completedAt, operationId)
    const scope = { space: String(row.sync_space_id), lane: String(row.replication_lane_id), actor: String(row.actor_incarnation_id) }
    scopes.set(JSON.stringify(scope), scope)
  }
  return [...scopes.values()]
}
