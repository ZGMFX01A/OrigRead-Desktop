import type { DatabaseSync } from 'node:sqlite'
import { CURRENT_SCHEMA_VERSION, type Migration } from './migration-definition'
export { CURRENT_SCHEMA_VERSION, DEFAULT_LOCAL_ACCOUNT_ID, CURRENT_ACCOUNT_SETTING_KEY, defaultGroupId, DEFAULT_GROUP_ID } from './migration-definition'
import { initialMigrations } from './migrations-initial'
import { accountsMigrations } from './migrations-accounts'
import { sourcesMigrations } from './migrations-sources'
import { conversationsMigrations } from './migrations-conversations'
import { annotationsMigrations } from './migrations-annotations'
import { subscriptionMigration } from './migration-subscriptions'

// 历史迁移不可重排；新订阅元数据迁移追加到最后。
const migrations: Migration[] = [...initialMigrations, ...accountsMigrations, ...sourcesMigrations, ...conversationsMigrations, ...annotationsMigrations, subscriptionMigration]

export function applyMigrations(database: DatabaseSync): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)

  const currentVersionRow = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number | bigint }
  let currentVersion = Number(currentVersionRow.version)

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    database.exec('BEGIN IMMEDIATE')
    try {
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
      database.exec('COMMIT')
      currentVersion = migration.version
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  if (currentVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported OrigRead database schema: ${currentVersion}`)
  }

  return currentVersion
}

