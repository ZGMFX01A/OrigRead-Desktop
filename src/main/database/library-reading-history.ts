import type { DatabaseSync } from 'node:sqlite'
import type { RecentArticleRecord } from '../../shared/library'
import type { LibraryRepository } from './library-repository'
import { RecentArticleRow, toRecentArticleRecord } from './library-rows'
import { libraryTransaction } from './library-transaction'

export const MAX_RECENT_ARTICLES_LIMIT = 500

/**
 * 独立阅读历史仓储：按账户隔离，重读 upsert 更新，按最近打开倒序，
 * 仅保留各账户最新 500 条；返回正文为 null 的轻量摘要。
 */
export class SqliteLibraryReadingHistory {
  constructor(
    private readonly database: DatabaseSync,
    private readonly library: LibraryRepository
  ) {}

  recordArticleOpened(
    articleId: string,
    accountId = this.library.getCurrentAccountId(),
    openedAt = Date.now()
  ): void {
    const row = this.database
      .prepare('SELECT account_id FROM articles WHERE id = ?')
      .get(articleId) as { account_id: number | bigint } | undefined

    if (!row) {
      throw new Error(`Article not found: ${articleId}`)
    }

    if (Number(row.account_id) !== accountId) {
      throw new Error(`Article ${articleId} does not belong to account ${accountId}`)
    }

    libraryTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO reading_history (account_id, article_id, last_opened_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id, article_id) DO UPDATE SET
          last_opened_at = excluded.last_opened_at
      `).run(accountId, articleId, openedAt)

      this.database.prepare(`
        DELETE FROM reading_history
        WHERE account_id = ? AND article_id NOT IN (
          SELECT article_id FROM reading_history
          WHERE account_id = ?
          ORDER BY last_opened_at DESC, article_id DESC
          LIMIT ?
        )
      `).run(accountId, accountId, MAX_RECENT_ARTICLES_LIMIT)
    })
  }

  listRecentArticles(
    limit?: number,
    accountId = this.library.getCurrentAccountId()
  ): RecentArticleRecord[] {
    const safeLimit = (typeof limit === 'number' && Number.isFinite(limit))
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_RECENT_ARTICLES_LIMIT)
      : MAX_RECENT_ARTICLES_LIMIT

    const rows = this.database.prepare(`
      SELECT
        a.id,
        a.account_id,
        a.feed_id,
        a.title,
        a.url,
        a.author,
        a.published_at,
        a.description,
        NULL AS content_html,
        NULL AS full_content_html,
        a.image_url,
        a.is_unread,
        a.is_starred,
        a.created_at,
        a.updated_at,
        h.last_opened_at
      FROM reading_history h
      INNER JOIN articles a ON a.id = h.article_id AND a.account_id = h.account_id
      WHERE h.account_id = ?
      ORDER BY h.last_opened_at DESC, h.article_id DESC
      LIMIT ?
    `).all(accountId, safeLimit) as unknown as RecentArticleRow[]

    return rows.map(toRecentArticleRecord)
  }

  clearReadingHistory(accountId = this.library.getCurrentAccountId()): void {
    this.database.prepare('DELETE FROM reading_history WHERE account_id = ?').run(accountId)
  }
}
