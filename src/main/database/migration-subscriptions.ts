import type { Migration } from './migration-definition'

// v14 增量保留探测规则、RSS 来源身份及无链接文章的归档墓碑；不重建或清空既有表。
export const subscriptionMigration: Migration = {
  version: 14,
  up(database) {
    database.exec(`
      CREATE TABLE json_feed_rules (
        feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
        rule_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE rss_article_identities (
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        article_id TEXT NOT NULL,
        PRIMARY KEY (feed_id, source_id)
      ) STRICT;
      CREATE TABLE archived_article_ids (
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (feed_id, article_id)
      ) STRICT;
    `)
  }
}
