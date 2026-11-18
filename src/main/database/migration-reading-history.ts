import type { Migration } from './migration-definition'

// v15 增量创建独立阅读历史表：按 (account_id, article_id) 主键，删除账户或文章时级联清理。
export const readingHistoryMigration: Migration = {
  version: 15,
  up(database) {
    database.exec(`
      CREATE TABLE reading_history (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        last_opened_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, article_id)
      ) STRICT;
      CREATE INDEX reading_history_account_opened_idx ON reading_history(account_id, last_opened_at DESC);
    `)
  }
}
