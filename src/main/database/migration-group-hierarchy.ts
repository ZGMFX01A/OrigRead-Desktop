import type { Migration } from './migration-definition'

// v16 增量增加分组 parent_id 引用以支持多层级分组树，旧分组缺省保留在根层（NULL）
export const groupHierarchyMigration: Migration = {
  version: 16,
  up(database) {
    const hasGroups = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'groups'")
      .get()
    if (!hasGroups) return

    const columns = (database.prepare("PRAGMA table_info('groups')").all() as Array<{ name: string }>).map((c) => c.name)
    if (!columns.includes('parent_id')) {
      database.exec(`
        ALTER TABLE groups ADD COLUMN parent_id TEXT REFERENCES groups(id) ON DELETE RESTRICT;
      `)
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS groups_account_parent_idx ON groups(account_id, parent_id);
    `)
  }
}
