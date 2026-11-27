import type { DatabaseSync } from 'node:sqlite'
import type { SecretStore } from '../security/secret-store'

/** Attempt both rollbacks even if one store is unavailable; never hide a recovery failure. */
export function rollbackSettingsAndSecrets(
  database: DatabaseSync,
  savepoint: 'mcp_local_update' | 'mcp_remote_update' | 'web_search_restore',
  secrets: SecretStore,
  snapshot: Readonly<Record<string, string>>,
  error: unknown
): never {
  const failures: unknown[] = [error]
  try {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    database.exec(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (rollbackError) {
    failures.push(rollbackError)
  }
  try {
    secrets.restoreSnapshot(snapshot)
  } catch (restoreError) {
    failures.push(restoreError)
  }
  if (failures.length > 1) throw new AggregateError(failures, '配置更新失败，回滚未能完整完成')
  throw error
}
