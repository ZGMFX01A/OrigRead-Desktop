import type { DatabaseSync } from 'node:sqlite'
import type { JsonRule } from '../../shared/json-source'

export interface RssArticleIdentity {
  sourceId: string
  articleId: string
}

/** 订阅时确认的规则与来源身份独立于当前规则目录，按全局唯一 Feed ID 归属。 */
export class LibrarySubscriptionMetadata {
  constructor(private readonly database: DatabaseSync) {}

  saveJsonRule(feedId: string, rule: JsonRule): void {
    this.database.prepare(`
      INSERT INTO json_feed_rules(feed_id, rule_json) VALUES(?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET rule_json = excluded.rule_json
    `).run(feedId, JSON.stringify(rule))
  }

  getJsonRule(feedId: string): JsonRule | null {
    const row = this.database.prepare('SELECT rule_json FROM json_feed_rules WHERE feed_id = ?')
      .get(feedId) as { rule_json: string } | undefined
    return row ? JSON.parse(row.rule_json) as JsonRule : null
  }

  /** 墓碑仍需要同一来源身份，文章归档删除后保留映射。 */
  saveRssIdentities(feedId: string, identities: RssArticleIdentity[]): void {
    const insert = this.database.prepare(`
      INSERT INTO rss_article_identities(feed_id, source_id, article_id) VALUES(?, ?, ?)
      ON CONFLICT(feed_id, source_id) DO UPDATE SET article_id = excluded.article_id
    `)
    for (const identity of identities) insert.run(feedId, identity.sourceId, identity.articleId)
  }

  getRssIdentities(feedId: string): Map<string, string> {
    const rows = this.database.prepare('SELECT source_id, article_id FROM rss_article_identities WHERE feed_id = ?')
      .all(feedId) as unknown as Array<{ source_id: string; article_id: string }>
    return new Map(rows.map((row) => [row.source_id, row.article_id]))
  }
}
