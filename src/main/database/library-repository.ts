import type { DatabaseSync } from 'node:sqlite'
import type {
  ArticleRecord,
  FeedRecord,
  GroupRecord,
  LibrarySnapshot,
  SourceType
} from '../../shared/library'
import { CURRENT_ACCOUNT_SETTING_KEY, DEFAULT_LOCAL_ACCOUNT_ID } from './migrations'

interface GroupRow {
  id: string
  account_id: number
  name: string
  sort_order: number
  is_default: number
}

interface FeedRow {
  id: string
  account_id: number
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
  account_id: number
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

  getCurrentAccountId(): number {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(CURRENT_ACCOUNT_SETTING_KEY) as { value: string } | undefined
    const value = Number(row?.value ?? DEFAULT_LOCAL_ACCOUNT_ID)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LOCAL_ACCOUNT_ID
  }

  snapshot(): LibrarySnapshot {
    const accountId = this.getCurrentAccountId()
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

  setArticleFullContent(articleId: string, html: string | null): void {
    const accountId = this.getCurrentAccountId()
    this.database
      .prepare('UPDATE articles SET full_content_html = ?, updated_at = ? WHERE account_id = ? AND id = ?')
      .run(html, Date.now(), accountId, articleId)
  }

  getArticleById(articleId: string): ArticleRecord | null {
    const accountId = this.getCurrentAccountId()
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
    const accountId = this.getCurrentAccountId()
    return (this.database.prepare(`
      SELECT id, account_id, feed_id, title, url, author, published_at, description,
             content_html, full_content_html, image_url, is_unread, is_starred,
             created_at, updated_at
      FROM articles
      WHERE account_id = ? AND feed_id = ?
      ORDER BY COALESCE(published_at, created_at) DESC
    `).all(accountId, feedId) as unknown as ArticleRow[]).map(toArticleRecord)
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
    return this.database.prepare('SELECT 1 AS found FROM articles WHERE account_id = ? AND id = ?')
      .get(this.getCurrentAccountId(), articleId) !== undefined
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
    return this.getFeedByIdForAccount(this.getCurrentAccountId(), feedId)
  }

  getFeedByIdForAccount(accountId: number, feedId: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ? AND id = ?
    `).get(accountId, feedId) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  findFeedByUrl(url: string): FeedRecord | null {
    const accountId = this.getCurrentAccountId()
    const row = this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ? AND url = ?
    `).get(accountId, url) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  listGroups(): GroupRecord[] {
    return this.listGroupsForAccount(this.getCurrentAccountId())
  }

  listGroupsForAccount(accountId: number): GroupRecord[] {
    return (this.database
      .prepare('SELECT id, account_id, name, sort_order, is_default FROM groups WHERE account_id = ? ORDER BY sort_order, name')
      .all(accountId) as unknown as GroupRow[]).map(toGroupRecord)
  }

  getDefaultGroupForAccount(accountId: number): GroupRecord | null {
    return this.listGroupsForAccount(accountId).find((group) => group.isDefault) ?? null
  }

  getCurrentDefaultGroup(): GroupRecord {
    const accountId = this.getCurrentAccountId()
    const group = this.getDefaultGroupForAccount(accountId)
    if (!group) throw new Error('当前账户缺少默认分组')
    return group
  }

  upsertGroup(group: GroupRecord): void {
    this.database.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_default = excluded.is_default
    `).run(group.id, group.accountId ?? this.getCurrentAccountId(), group.name, group.sortOrder, toSqlBoolean(group.isDefault))
  }

  deleteArticlesByFeed(feedId: string, includeStarred = false): void {
    this.database
      .prepare(`DELETE FROM articles WHERE feed_id = ?${includeStarred ? '' : ' AND is_starred = 0'}`)
      .run(feedId)
  }

  deleteFeed(feedId: string): void {
    this.database.prepare('DELETE FROM feeds WHERE account_id = ? AND id = ?')
      .run(this.getCurrentAccountId(), feedId)
  }

  listFeeds(): FeedRecord[] {
    return this.listFeedsForAccount(this.getCurrentAccountId())
  }

  listFeedsForAccount(accountId: number): FeedRecord[] {
    return (this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ?
      ORDER BY name COLLATE NOCASE
    `).all(accountId) as unknown as FeedRow[]).map(toFeedRecord)
  }

  upsertFeed(feed: FeedRecord): void {
    this.database.prepare(`
      INSERT INTO feeds (
        id, account_id, group_id, name, url, source_page_url, source_type, icon,
        is_notification, is_full_content, is_browser, dynamic_rendering,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
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
      feed.accountId ?? this.getCurrentAccountId(),
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
        id, account_id, feed_id, title, url, author, published_at, description,
        content_html, full_content_html, image_url, is_unread, is_starred,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
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
      article.accountId ?? this.getCurrentAccountId(),
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
    return this.listArticlesForAccount(this.getCurrentAccountId(), limit)
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

  setArticleUnread(articleId: string, unread: boolean): void {
    this.setArticleUnreadForAccount(this.getCurrentAccountId(), articleId, unread)
  }

  setArticleUnreadForAccount(accountId:number, articleId:string, unread:boolean):void {
    this.database
      .prepare('UPDATE articles SET is_unread = ? WHERE account_id = ? AND id = ?')
      .run(toSqlBoolean(unread), accountId, articleId)
  }

  setArticleUnreadBatchForAccount(accountId:number, articleIds:string[], unread:boolean):void {
    this.updateArticleBooleanBatch(accountId, articleIds, 'is_unread', unread)
  }

  setArticleStarred(articleId: string, starred: boolean): void {
    this.setArticleStarredForAccount(this.getCurrentAccountId(), articleId, starred)
  }

  setArticleStarredForAccount(accountId:number, articleId:string, starred:boolean):void {
    this.database
      .prepare('UPDATE articles SET is_starred = ? WHERE account_id = ? AND id = ?')
      .run(toSqlBoolean(starred), accountId, articleId)
  }

  setArticleStarredBatchForAccount(accountId:number, articleIds:string[], starred:boolean):void {
    this.updateArticleBooleanBatch(accountId, articleIds, 'is_starred', starred)
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

  listRssHubSourceUrls(): Record<string, string> {
    const rows = this.database.prepare(`
      SELECT r.feed_id, r.source_url
      FROM rsshub_source_urls r
      JOIN feeds f ON f.id = r.feed_id
      WHERE f.account_id = ?
    `).all(this.getCurrentAccountId()) as unknown as Array<{ feed_id: string; source_url: string }>
    return Object.fromEntries(rows.map((row) => [row.feed_id, row.source_url]))
  }

  deleteAccountData(accountId: number): void {
    this.database.prepare('DELETE FROM articles WHERE account_id = ?').run(accountId)
    this.database.prepare('DELETE FROM feeds WHERE account_id = ?').run(accountId)
    this.database.prepare('DELETE FROM groups WHERE account_id = ?').run(accountId)
  }

  deleteNonStarredArticlesForAccount(accountId: number): void {
    this.database.prepare('DELETE FROM articles WHERE account_id = ? AND is_starred = 0').run(accountId)
  }

  listArticleStateForAccount(accountId: number): Array<{ id:string;isUnread:boolean;isStarred:boolean }> {
    const rows = this.database.prepare('SELECT id,is_unread,is_starred FROM articles WHERE account_id = ?')
      .all(accountId) as unknown as Array<{ id:string;is_unread:number;is_starred:number }>
    return rows.map((row)=>({ id:row.id, isUnread:row.is_unread===1, isStarred:row.is_starred===1 }))
  }

  isArchivedLink(feedId:string,link:string|null|undefined):boolean {
    if(!link)return false
    return this.database.prepare('SELECT 1 AS found FROM archived_articles WHERE feed_id=? AND link=?')
      .get(feedId,link)!==undefined
  }

  archiveExpiredArticlesForAccount(accountId:number,keepArchivedMillis:number,now=Date.now()):number {
    if(keepArchivedMillis<=0)return 0
    const cutoff=now-keepArchivedMillis
    const rows=this.database.prepare(`
      SELECT id,feed_id,url FROM articles
      WHERE account_id=? AND updated_at<? AND is_unread=0 AND is_starred=0
    `).all(accountId,cutoff) as unknown as Array<{id:string;feed_id:string;url:string|null}>
    if(rows.length===0)return 0
    const insert=this.database.prepare(`
      INSERT INTO archived_articles(feed_id,link,archived_at) VALUES(?,?,?)
      ON CONFLICT(feed_id,link) DO UPDATE SET archived_at=excluded.archived_at
    `)
    const remove=this.database.prepare('DELETE FROM articles WHERE account_id=? AND id=?')
    this.database.exec('BEGIN IMMEDIATE')
    try{
      for(const row of rows){
        if(row.url)insert.run(row.feed_id,row.url,now)
        remove.run(accountId,row.id)
      }
      this.database.exec('COMMIT')
    }catch(error){
      this.database.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  deleteFeedForAccountIfNoStarred(accountId:number,feedId:string):boolean {
    const row=this.database.prepare('SELECT COUNT(*) AS count FROM articles WHERE account_id=? AND feed_id=? AND is_starred=1')
      .get(accountId,feedId) as {count:number|bigint}
    if(Number(row.count)>0)return false
    this.database.prepare('DELETE FROM feeds WHERE account_id=? AND id=?').run(accountId,feedId)
    return true
  }

  deleteGroupForAccountIfNoStarred(accountId:number,groupId:string):boolean {
    const row=this.database.prepare(`SELECT COUNT(*) AS count FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE a.account_id=? AND f.group_id=? AND a.is_starred=1`)
      .get(accountId,groupId) as {count:number|bigint}
    if(Number(row.count)>0)return false
    this.database.prepare('DELETE FROM feeds WHERE account_id=? AND group_id=?').run(accountId,groupId)
    this.database.prepare('DELETE FROM groups WHERE account_id=? AND id=?').run(accountId,groupId)
    return true
  }

  private updateArticleBooleanBatch(
    accountId:number,
    articleIds:string[],
    column:'is_unread'|'is_starred',
    value:boolean
  ):void {
    const ids=[...new Set(articleIds)]
    if(ids.length===0)return
    this.database.exec('BEGIN IMMEDIATE')
    try{
      for(let offset=0;offset<ids.length;offset+=1000){
        const chunk=ids.slice(offset,offset+1000)
        const placeholders=chunk.map(()=>'?').join(',')
        this.database.prepare(
          `UPDATE articles SET ${column}=? WHERE account_id=? AND id IN (${placeholders})`
        ).run(toSqlBoolean(value),accountId,...chunk)
      }
      this.database.exec('COMMIT')
    }catch(error){
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0
}

function toGroupRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    sortOrder: row.sort_order,
    isDefault: row.is_default === 1
  }
}

function toFeedRecord(row: FeedRow): FeedRecord {
  return {
    id: row.id,
    accountId: row.account_id,
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
    accountId: row.account_id,
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

