import type { DatabaseSync } from 'node:sqlite'

/** 前缀类别分别推进，Processed 包含终态拒绝但 Applied 只包含真实业务提交。 */
const PREFIX_RULES = {
  received: { column: 'received_prefix', accepts: (_state: string) => true },
  retained: { column: 'retained_prefix', accepts: (state: string) => state !== 'REJECTED' },
  applied: { column: 'applied_prefix', accepts: (state: string) => state === 'APPLIED' },
  processed: { column: 'processed_prefix', accepts: (state: string) => state === 'APPLIED' || state === 'REJECTED' }
} as const
interface Scope { space: string; lane: string; actor: string; kind: keyof typeof PREFIX_RULES }

/** 从持久前缀+1读取轻量游标，在第一个缺口/未满足状态处停止，不读取历史 payload。 */
export function contiguousPrefix(database: DatabaseSync, scope: Scope): number {
  const rule = PREFIX_RULES[scope.kind]
  const previous = database.prepare(`SELECT ${rule.column} AS prefix,snapshot_prefix,stable_gc_prefix FROM sync_coverage
    WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?`)
    .get(scope.space, scope.lane, scope.actor)
  let prefix = Math.max(Number(previous?.prefix ?? 0), Number(previous?.snapshot_prefix ?? 0), Number(previous?.stable_gc_prefix ?? 0))
  const rows = database.prepare(`SELECT sequence,state FROM sync_inbox_operation
    WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=? AND sequence>? ORDER BY sequence`)
    .iterate(scope.space, scope.lane, scope.actor, prefix)
  for (const row of rows) {
    if (Number(row.sequence) !== prefix + 1 || !rule.accepts(String(row.state))) break
    prefix++
  }
  if (scope.kind === 'processed') database.prepare(`UPDATE sync_coverage SET processed_prefix=?
    WHERE sync_space_id=? AND replication_lane_id=? AND actor_incarnation_id=?`).run(prefix, scope.space, scope.lane, scope.actor)
  return prefix
}
