import type { DatabaseSync } from 'node:sqlite'
import type { ArticleRecord, FeedArticleStats, LibrarySnapshot } from '../../shared/library'

import type { LibraryRepository } from './library-repository'
import { ARTICLE_ID_QUERY_CHUNK_SIZE, ArticleRow, toArticleRecord } from './library-rows'

/** 按文章读取职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryReader {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  snapshot(accountId = this.library.getCurrentAccountId()): LibrarySnapshot {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM groups WHERE account_id = ?) AS groups_count,
        (SELECT COUNT(*) FROM feeds WHERE account_id = ?) AS feeds_count,
        (SELECT COUNT(*) FROM articles WHERE account_id = ?) AS articles_count,
        (SELECT COUNT(*) FROM articles WHERE account_id = ? AND is_unread = 1) AS unread_count,
        (SELECT COUNT(*) FROM articles WHERE account_id = ? AND is_starred = 1) AS starred_count
    `).get(accountId, accountId, accountId, accountId, accountId) as Record<string, number | bigint>

    return {
      groups: Number(row.groups_count ?? 0),
      feeds: Number(row.feeds_count ?? 0),
      articles: Number(row.articles_count ?? 0),
      unread: Number(row.unread_count ?? 0),
      starred: Number(row.starred_count ?? 0)
    }
  }

  getArticleById(articleId: string): ArticleRecord | null {
    const accountId = this.library.getCurrentAccountId()
    const row = this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND id = ?
    `).get(accountId, articleId) as ArticleRow | undefined
    return row ? toArticleRecord(row) : null
  }

  listArticlesByFeed(feedId: string): ArticleRecord[] {
    return this.listArticlesByFeedForAccount(this.library.getCurrentAccountId(), feedId)
  }

  listArticlesByFeedForAccount(accountId: number, feedId: string): ArticleRecord[] {
    return (this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND feed_id = ?
      ORDER BY COALESCE(published_at, created_at) DESC
    `).all(accountId, feedId) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  listArticlesByGroup(groupId: string): ArticleRecord[] {
    const accountId = this.library.getCurrentAccountId()
    return (this.database.prepare(`
      SELECT a.id, a.account_id, a.feed_id, a.title, a.url, a.author, a.published_at, a.description,
             a.content_html, a.full_content_html, a.image_url, a.is_unread, a.is_starred,
             a.created_at, a.updated_at
      FROM articles a
      INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
      WHERE a.account_id = ? AND f.group_id = ?
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
    `).all(accountId, groupId) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  listFeedArticleStats(): FeedArticleStats[] {
    const accountId = this.library.getCurrentAccountId()
    const rows = this.database.prepare(`
      SELECT feed_id,
             COUNT(*) AS total_count,
             SUM(CASE WHEN is_unread = 1 THEN 1 ELSE 0 END) AS unread_count,
             SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) AS starred_count
      FROM articles
      WHERE account_id = ?
      GROUP BY feed_id
    `).all(accountId) as unknown as Array<Record<string, string | number | bigint | null>>
    return rows.map((row) => ({
      feedId: String(row.feed_id),
      total: Number(row.total_count ?? 0),
      unread: Number(row.unread_count ?? 0),
      starred: Number(row.starred_count ?? 0)
    }))
  }

  hasArticle(articleId: string): boolean {
    return this.database.prepare('SELECT 1 AS found FROM articles WHERE account_id = ? AND id = ?')
      .get(this.library.getCurrentAccountId(), articleId) !== undefined
  }

  existingArticleIds(articleIds: string[], accountId = this.library.getCurrentAccountId()): Set<string> {
    const ids = [...new Set(articleIds)]
    if (ids.length === 0) return new Set()
    const existing = new Set<string>()
    for (let offset = 0; offset < ids.length; offset += ARTICLE_ID_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + ARTICLE_ID_QUERY_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.database.prepare(
        `SELECT id FROM articles WHERE account_id = ? AND id IN (${placeholders})`
      ).all(accountId, ...chunk) as unknown as Array<{ id: string }>
      for (const row of rows) existing.add(row.id)
    }
    return existing
  }

  listArticles(limit = 200): ArticleRecord[] {
    return this.listArticlesForAccount(this.library.getCurrentAccountId(), limit)
  }

  listArticlesForAccount(accountId: number, limit = 200): ArticleRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000)
    return (this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ?
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT ?
    `).all(accountId, safeLimit) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  listArticleStateForAccount(accountId: number): Array<{ id:string;isUnread:boolean;isStarred:boolean }> {
    const rows = this.database.prepare('SELECT id,is_unread,is_starred FROM articles WHERE account_id = ?')
      .all(accountId) as unknown as Array<{ id:string;is_unread:number;is_starred:number }>
    return rows.map((row)=>({ id:row.id, isUnread:row.is_unread===1, isStarred:row.is_starred===1 }))
  }
}
