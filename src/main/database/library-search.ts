import type { DatabaseSync } from 'node:sqlite'
import type { ArticleSearchResult } from '../../shared/library'

import type { LibraryRepository } from './library-repository'
import { ArticleMetadataRecord, ArticleSearchRow, escapeLikePattern, articleMetadataFromRow, makeSearchSnippet } from './library-rows'

// 全库搜索按标题、摘要、正文优先级排序，所有查询条件通过参数绑定。
const ARTICLE_SEARCH_SQL = `
      WITH matched_articles AS (
        SELECT
          a.id,
          a.feed_id,
          f.name AS feed_name,
          a.title,
          a.author,
          a.url,
          a.published_at,
          a.is_unread,
          a.is_starred,
          a.created_at,
          CASE
            WHEN a.title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 'title'
            WHEN a.description LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 'description'
            ELSE 'content'
          END AS match_field,
          CASE
            WHEN a.title LIKE ? ESCAPE '\\' COLLATE NOCASE THEN a.title
            WHEN a.description LIKE ? ESCAPE '\\' COLLATE NOCASE THEN a.description
            WHEN COALESCE(a.content_html, '') LIKE ? ESCAPE '\\' COLLATE NOCASE THEN a.content_html
            ELSE a.full_content_html
          END AS matched_text
        FROM articles a
        INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
        WHERE a.account_id = ?
          AND (
            a.title LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR a.description LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR COALESCE(a.content_html, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR COALESCE(a.full_content_html, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
          )
      )
      SELECT id, feed_id, feed_name, title, author, url, published_at,
             is_unread, is_starred, match_field, matched_text
      FROM matched_articles
      ORDER BY
        CASE match_field WHEN 'title' THEN 0 WHEN 'description' THEN 1 ELSE 2 END,
        COALESCE(published_at, created_at) DESC
      LIMIT ?
    `

/** 按文章检索职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibrarySearch {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  listArticleMetadata(limit = 30, titleQuery = ''): ArticleMetadataRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200)
    const accountId = this.library.getCurrentAccountId()
    const normalizedQuery = titleQuery.trim()
    const rows = normalizedQuery
      ? this.database.prepare(`
          SELECT a.id, f.name AS feed_name, a.title, a.url, a.published_at
          FROM articles a
          INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
          WHERE a.account_id = ? AND a.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id
          LIMIT ?
        `).all(accountId, `%${escapeLikePattern(normalizedQuery)}%`, safeLimit)
      : this.database.prepare(`
          SELECT a.id, f.name AS feed_name, a.title, a.url, a.published_at
          FROM articles a
          INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
          WHERE a.account_id = ?
          ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id
          LIMIT ?
        `).all(accountId, safeLimit)
    return (rows as unknown as Array<{
      id: string
      feed_name: string
      title: string
      url: string | null
      published_at: number | null
    }>).map(articleMetadataFromRow)
  }

  getArticleMetadataById(articleId: string): ArticleMetadataRecord | null {
    const row = this.database.prepare(`
      SELECT a.id, f.name AS feed_name, a.title, a.url, a.published_at
      FROM articles a
      INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
      WHERE a.account_id = ? AND a.id = ?
      LIMIT 1
    `).get(this.library.getCurrentAccountId(), articleId.trim()) as unknown as {
      id: string
      feed_name: string
      title: string
      url: string | null
      published_at: number | null
    } | undefined
    return row ? articleMetadataFromRow(row) : null
  }

  searchArticles(query: string, limit = 100): ArticleSearchResult[] {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return []

    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200)
    const like = `%${escapeLikePattern(normalizedQuery)}%`
    const accountId = this.library.getCurrentAccountId()
    const rows = this.database.prepare(ARTICLE_SEARCH_SQL).all(
      like,
      like,
      like,
      like,
      like,
      accountId,
      like,
      like,
      like,
      like,
      safeLimit
    ) as unknown as ArticleSearchRow[]

    return rows.map((row) => ({
      id: row.id,
      feedId: row.feed_id,
      feedName: row.feed_name,
      title: row.title,
      author: row.author,
      url: row.url,
      publishedAt: row.published_at,
      isUnread: row.is_unread === 1,
      isStarred: row.is_starred === 1,
      matchField: row.match_field,
      snippet: makeSearchSnippet(row.matched_text ?? row.title, normalizedQuery)
    }))
  }
}
