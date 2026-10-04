import type { DatabaseSync } from 'node:sqlite'

/** 修复旧快照清零的本机默认标记；仅恢复已有规范 ID，不凭组名创建或重映射实体。 */
export function migrateSyncDefaultGroup(
  database: DatabaseSync,
  groupIdForAccount: (accountId: number) => string
): void {
  const bindings = database.prepare('SELECT local_account_id FROM sync_local_space_binding')
    .all() as Array<{ local_account_id: number }>
  // 无同步绑定的历史资料不属于本次修复；有绑定才读取对应账户及分组。
  for (const binding of bindings) {
    database.prepare(`
      UPDATE groups SET is_default=1 WHERE account_id=? AND id=? AND is_default=0
      AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND type='local')
      AND NOT EXISTS (SELECT 1 FROM groups WHERE account_id=? AND is_default=1)
    `).run(binding.local_account_id, groupIdForAccount(binding.local_account_id),
      binding.local_account_id, binding.local_account_id)
  }
}
