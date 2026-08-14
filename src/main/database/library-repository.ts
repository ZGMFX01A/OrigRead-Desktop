import type { DatabaseSync } from 'node:sqlite'
import type {
  ArticleRecord,
  FeedRecord,
  GroupRecord,
  LibrarySnapshot,
  SourceType
} from '../../shared/library'

interface GroupRow {
  id: string
  name: string
  sort_order: number
  is_default: number
}

interface FeedRow {
  id: string
  group_id: string
  name: string
  url: string
  source_page_url: string | null
  source_type: SourceType
  icon: string | null
  is_notification: number
  is_full_content: number
  is_browser: number
  dynamic_rendering: number
  created_at: number
  updated_at: number
}

interface ArticleRow {
  id: string
  feed_id: string
  title: string
  url: string | null
  author: string | null
  published_at: number | null
  description: string
  content_html: string | null
  full_content_html: string | null
  image_url: string | null
  is_unread: number
  is_starred: number
  created_at: number
  updated_at: number
}

export class LibraryRepository {
  constructor(private readonly database: DatabaseSync) {}

  snapshot(): LibrarySnapshot {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM groups) AS groups_count,
        (SELECT COUNT(*) FROM feeds) AS feeds_count,
        (SELECT COUNT(*) FROM articles) AS articles_count,
        (SELECT COUNT(*) FROM articles WHERE is_unread = 1) AS unread_count,
        (SELECT COUNT(*) FROM articles WHERE is_starred = 1) AS starred_count
    `).get() as Record<string, number | bigint>

    return {
      groups: Number(row.groups_count ?? 0),
      feeds: Number(row.feeds_count ?? 0),
      articles: Number(row.articles_count ?? 0),
      unread: Number(row.unread_count ?? 0),
      starred: Number(row.starred_count ?? 0)
    }
  }

  setArticleFullContent(articleId: string, html: string | null): void {
    this.database
      .prepare('UPDATE articles SET full_content_html = ?, updated_at = ? WHERE id = ?')
      .run(html, Date.now(), articleId)
  }

  getArticleById(articleId: string): ArticleRecord | null {
    const row = this.database.prepare(`
      SELECT id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE id = ?
    `).get(articleId) as ArticleRow | undefined
    return row ? toArticleRecord(row) : null
  }

  listArticlesByFeed(feedId: string): ArticleRecord[] {
    return (this.database.prepare(`
      SELECT id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE feed_id = ?
      ORDER BY COALESCE(published_at, created_at) DESC
    `).all(feedId) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  upsertWebsiteFeedWithArticles(feed: FeedRecord, articles: ArticleRecord[], obsoleteArticleIds: string[]): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.upsertFeed(feed)
      for (const article of articles) this.upsertArticle(article)
      const deleteStatement = this.database.prepare('DELETE FROM articles WHERE id = ? AND is_starred = 0')
      for (const articleId of obsoleteArticleIds) deleteStatement.run(articleId)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  upsertRssHubFeedWithArticles(feed: FeedRecord, articles: ArticleRecord[], sourceUrl: string): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.upsertFeed(feed)
      for (const article of articles) this.upsertArticle(article)
      this.setRssHubSourceUrl(feed.id, sourceUrl)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  hasArticle(articleId: string): boolean {
    return this.database.prepare('SELECT 1 AS found FROM articles WHERE id = ?').get(articleId) !== undefined
  }

  upsertFeedWithArticles(feed: FeedRecord, articles: ArticleRecord[]): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.upsertFeed(feed)
      for (const article of articles) this.upsertArticle(article)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getFeedById(feedId: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE id = ?
    `).get(feedId) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  findFeedByUrl(url: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE url = ?
    `).get(url) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  listGroups(): GroupRecord[] {
    return (this.database
      .prepare('SELECT id, name, sort_order, is_default FROM groups ORDER BY sort_order, name')
      .all() as unknown as GroupRow[]).map(toGroupRecord)
  }

  upsertGroup(group: GroupRecord): void {
    this.database.prepare(`
      INSERT INTO groups (id, name, sort_order, is_default)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_default = excluded.is_default
    `).run(group.id, group.name, group.sortOrder, toSqlBoolean(group.isDefault))
  }

  listFeeds(): FeedRecord[] {
    return (this.database.prepare(`
      SELECT id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      ORDER BY name COLLATE NOCASE
    `).all() as unknown as FeedRow[]).map(toFeedRecord)
  }

  upsertFeed(feed: FeedRecord): void {
    this.database.prepare(`
      INSERT INTO feeds (
        id, group_id, name, url, source_page_url, source_type, icon,
        is_notification, is_full_content, is_browser, dynamic_rendering,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_id = excluded.group_id,
        name = excluded.name,
        url = excluded.url,
        source_page_url = excluded.source_page_url,
        source_type = excluded.source_type,
        icon = excluded.icon,
        is_notification = excluded.is_notification,
        is_full_content = excluded.is_full_content,
        is_browser = excluded.is_browser,
        dynamic_rendering = excluded.dynamic_rendering,
        updated_at = excluded.updated_at
    `).run(
      feed.id,
      feed.groupId,
      feed.name,
      feed.url,
      feed.sourcePageUrl,
      feed.sourceType,
      feed.icon,
      toSqlBoolean(feed.isNotification),
      toSqlBoolean(feed.isFullContent),
      toSqlBoolean(feed.isBrowser),
      toSqlBoolean(feed.dynamicRendering),
      feed.createdAt,
      feed.updatedAt
    )
  }

  upsertArticle(article: ArticleRecord): void {
    this.database.prepare(`
      INSERT INTO articles (
        id, feed_id, title, url, author, published_at, description,
        content_html, full_content_html, image_url, is_unread, is_starred,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        feed_id = excluded.feed_id,
        title = excluded.title,
        url = excluded.url,
        author = excluded.author,
        published_at = excluded.published_at,
        description = excluded.description,
        content_html = excluded.content_html,
        full_content_html = COALESCE(excluded.full_content_html, articles.full_content_html),
        image_url = excluded.image_url,
        updated_at = excluded.updated_at
    `).run(
      article.id,
      article.feedId,
      article.title,
      article.url,
      article.author,
      article.publishedAt,
      article.description,
      article.contentHtml,
      article.fullContentHtml,
      article.imageUrl,
      toSqlBoolean(article.isUnread),
      toSqlBoolean(article.isStarred),
      article.createdAt,
      article.updatedAt
    )
  }

  listArticles(limit = 200): ArticleRecord[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1_000)
    return (this.database.prepare(`
      SELECT id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT ?
    `).all(safeLimit) as unknown as ArticleRow[]).map(toArticleRecord)
  }

  setArticleUnread(articleId: string, unread: boolean): void {
    this.database
      .prepare('UPDATE articles SET is_unread = ?, updated_at = ? WHERE id = ?')
      .run(toSqlBoolean(unread), Date.now(), articleId)
  }

  setArticleStarred(articleId: string, starred: boolean): void {
    this.database
      .prepare('UPDATE articles SET is_starred = ?, updated_at = ? WHERE id = ?')
      .run(toSqlBoolean(starred), Date.now(), articleId)
  }

  setRssHubSourceUrl(feedId: string, sourceUrl: string): void {
    this.database.prepare(`
      INSERT INTO rsshub_source_urls (feed_id, source_url)
      VALUES (?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET source_url = excluded.source_url
    `).run(feedId, sourceUrl)
  }

  getRssHubSourceUrl(feedId: string): string | null {
    const row = this.database
      .prepare('SELECT source_url FROM rsshub_source_urls WHERE feed_id = ?')
      .get(feedId) as { source_url: string } | undefined
    return row?.source_url ?? null
  }
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0
}

function toGroupRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    isDefault: row.is_default === 1
  }
}

function toFeedRecord(row: FeedRow): FeedRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    url: row.url,
    sourcePageUrl: row.source_page_url,
    sourceType: row.source_type,
    icon: row.icon,
    isNotification: row.is_notification === 1,
    isFullContent: row.is_full_content === 1,
    isBrowser: row.is_browser === 1,
    dynamicRendering: row.dynamic_rendering === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toArticleRecord(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    feedId: row.feed_id,
    title: row.title,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    description: row.description,
    contentHtml: row.content_html,
    fullContentHtml: row.full_content_html,
    imageUrl: row.image_url,
    isUnread: row.is_unread === 1,
    isStarred: row.is_starred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

