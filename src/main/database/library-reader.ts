import type { DatabaseSync } from 'node:sqlite'
import type { ArticleRecord, FeedArticleStats, LibrarySnapshot } from '../../shared/library'

import type { LibraryRepository } from './library-repository'
import type { ArticleListFilterOptions } from './article-list-args'
import { ARTICLE_ID_QUERY_CHUNK_SIZE, ArticleRow, toArticleRecord } from './library-rows'
import { getGroupDescendantIds } from '../../shared/group-tree'

export type ArticleListScope = { kind: 'all' } | { kind: 'feed' | 'group'; id: string }
export type { ArticleListFilterOptions } from './article-list-args'

/** 按文章读取职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryReader {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  /** 按分组 ID 范围解析组自身及其所有后代分组 ID；验证账户归属防止越权。 */
  private getGroupScopeIds(accountId: number, groupId: string): string[] {
    const allGroups = this.library.listGroupsForAccount(accountId)
    const currentGroup = allGroups.find((g) => g.id === groupId)
    if (!currentGroup) {
      return []
    }
    const descendantIds = getGroupDescendantIds(groupId, allGroups)
    return [groupId, ...descendantIds]
  }

  /** Renderer lists never select body columns; full records remain available to sync and Reader. */
  listArticleSummaries(
    scope: ArticleListScope = { kind: 'all' },
    limit = 200,
    options?: ArticleListFilterOptions
  ): ArticleRecord[] {
    const accountId = this.library.getCurrentAccountId()
    let filter = ''
    const params: (number | string)[] = [accountId]
    if (scope.kind === 'feed') {
      filter = 'AND a.feed_id = ?'
      params.push(scope.id)
    } else if (scope.kind === 'group') {
      const groupScopeIds = this.getGroupScopeIds(accountId, scope.id)
      if (groupScopeIds.length === 0) {
        return []
      }
      filter = 'AND f.group_id IN (SELECT value FROM json_each(?))'
      params.push(JSON.stringify(groupScopeIds))
    }
    const unreadFilter = options?.isUnread !== undefined ? 'AND a.is_unread = ?' : ''
    if (options?.isUnread !== undefined) {
      params.push(options.isUnread ? 1 : 0)
    }
    if (scope.kind === 'all') {
      params.push(Math.min(Math.max(Math.trunc(limit), 1), 1_000))
    }
    return (this.database.prepare(`
      SELECT a.id, a.account_id, a.feed_id, a.title, a.url, a.author, a.published_at, a.description,
             NULL AS content_html, NULL AS full_content_html, a.image_url, a.is_unread, a.is_starred,
             a.created_at, a.updated_at
      FROM articles a
      ${scope.kind === 'group' ? 'INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id' : ''}
      WHERE a.account_id = ? ${filter} ${unreadFilter}
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      ${scope.kind === 'all' ? 'LIMIT ?' : ''}
    `).all(...params) as unknown as ArticleRow[]).map(toArticleRecord)
  }

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

  getArticleSummaryById(articleId: string): ArticleRecord | null {
    return this.getArticleSummaryByIdForAccount(this.library.getCurrentAccountId(), articleId)
  }

  /** 文章选择、搜索定位和引用导航仅需要元数据摘要，SQL 层投影不查正文列。 */
  getArticleSummaryByIdForAccount(accountId: number, articleId: string): ArticleRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             NULL AS content_html, NULL AS full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND id = ?
    `).get(accountId, articleId) as ArticleRow | undefined
    return row ? toArticleRecord(row) : null
  }

  getArticleById(articleId: string): ArticleRecord | null {
    return this.getArticleByIdForAccount(this.library.getCurrentAccountId(), articleId)
  }

  /** 异步任务按入口保存的账户读取，完成时不再借用当前界面账户。 */
  getArticleByIdForAccount(accountId: number, articleId: string): ArticleRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND id = ?
    `).get(accountId, articleId) as ArticleRow | undefined
    return row ? toArticleRecord(row) : null
  }

  /** 文章 ID 全局唯一；状态操作用持久化归属选择账户凭据。 */
  getArticleAccountId(articleId: string): number | null {
    const row = this.database.prepare('SELECT account_id FROM articles WHERE id = ?')
      .get(articleId) as { account_id: number } | undefined
    return row?.account_id ?? null
  }

  /** 范围清理只读取身份、链接和收藏保护，避免搬运全部历史正文。 */
  listArticleCleanupMetadata(accountId: number, feedId: string): Array<{ id: string; url: string | null; isStarred: boolean }> {
    const rows = this.database.prepare('SELECT id, url, is_starred FROM articles WHERE account_id = ? AND feed_id = ?')
      .all(accountId, feedId) as unknown as Array<{ id: string; url: string | null; is_starred: number }>
    return rows.map((row) => ({ id: row.id, url: row.url, isStarred: row.is_starred === 1 }))
  }

  /** 仅查询来源文章 ID 列表，用于刷新前对比新文章，避免读取任何正文列。 */
  listArticleIdsByFeedForAccount(accountId: number, feedId: string): string[] {
    const rows = this.database.prepare('SELECT id FROM articles WHERE account_id = ? AND feed_id = ?')
      .all(accountId, feedId) as unknown as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  /** 同步通知仅需新文章元数据摘要，SQL 层投影将正文置 NULL，避免加载海量历史正文。 */
  listArticleSummariesByFeedForAccount(accountId: number, feedId: string): ArticleRecord[] {
    return (this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             NULL AS content_html, NULL AS full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND feed_id = ?
      ORDER BY COALESCE(published_at, created_at) DESC
    `).all(accountId, feedId) as unknown as ArticleRow[]).map(toArticleRecord)
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

  listArticlesByGroup(groupId: string, accountId = this.library.getCurrentAccountId()): ArticleRecord[] {
    const groupScopeIds = this.getGroupScopeIds(accountId, groupId)
    if (groupScopeIds.length === 0) {
      return []
    }
    return (this.database.prepare(`
      SELECT a.id, a.account_id, a.feed_id, a.title, a.url, a.author, a.published_at, a.description,
             a.content_html, a.full_content_html, a.image_url, a.is_unread, a.is_starred,
             a.created_at, a.updated_at
      FROM articles a
      INNER JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
      WHERE a.account_id = ? AND f.group_id IN (SELECT value FROM json_each(?))
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
    `).all(accountId, JSON.stringify(groupScopeIds)) as unknown as ArticleRow[]).map(toArticleRecord)
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

  listArticles(limit = 200, options?: ArticleListFilterOptions): ArticleRecord[] {
    return this.listArticlesForAccount(this.library.getCurrentAccountId(), limit, options)
  }

  listArticlesForAccount(accountId: number, limit = 200, options?: ArticleListFilterOptions): ArticleRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000)
    const unreadFilter = options?.isUnread !== undefined ? 'AND is_unread = ?' : ''
    const params: (number | string)[] = [accountId]
    if (options?.isUnread !== undefined) {
      params.push(options.isUnread ? 1 : 0)
    }
    params.push(safeLimit)
    return (this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? ${unreadFilter}
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT ?
    `).all(...params) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  listArticleStateForAccount(accountId: number): Array<{ id:string;isUnread:boolean;isStarred:boolean }> {
    const rows = this.database.prepare('SELECT id,is_unread,is_starred FROM articles WHERE account_id = ?')
      .all(accountId) as unknown as Array<{ id:string;is_unread:number;is_starred:number }>
    return rows.map((row)=>({ id:row.id, isUnread:row.is_unread===1, isStarred:row.is_starred===1 }))
  }
}
