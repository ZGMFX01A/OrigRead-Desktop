import type { DatabaseSync } from 'node:sqlite'
import type { ArticleRecord, FeedRecord, FeedArticleStats, GroupRecord, LibrarySnapshot, ArticleSearchResult } from '../../shared/library'
import type { JsonRule } from '../../shared/json-source'
import type { RssHubSubscriptionDescriptor } from '../../shared/rsshub'
export type { RssHttpCacheRecord, ArticleMetadataRecord } from './library-rows'
import { SqliteLibraryCatalog } from './library-catalog'
import { SqliteLibraryReader } from './library-reader'
import { SqliteLibraryWriter } from './library-writer'
import { SqliteLibrarySearch } from './library-search'
import { SqliteLibraryMetadata } from './library-metadata'
import { SqliteLibraryArchive } from './library-archive'
import type { RssHttpCacheRecord, ArticleMetadataRecord } from './library-rows'
import { LibrarySubscriptionMetadata, type RssArticleIdentity } from './library-subscription-metadata'
import { libraryTransaction } from './library-transaction'

export interface FeedWriteOptions {
  rssHttpCache?: RssHttpCacheRecord
  rssHubDescriptor?: RssHubSubscriptionDescriptor
  jsonRule?: JsonRule
  rssIdentities?: RssArticleIdentity[]
}

/** 对外保留统一 Library 接口，事务组合与具体查询分别维护。 */
export class LibraryRepository {
  private readonly catalog: SqliteLibraryCatalog
  private readonly reader: SqliteLibraryReader
  private readonly writer: SqliteLibraryWriter
  private readonly search: SqliteLibrarySearch
  private readonly metadata: SqliteLibraryMetadata
  private readonly archive: SqliteLibraryArchive
  private readonly subscriptions: LibrarySubscriptionMetadata

  constructor(private readonly database: DatabaseSync) {
    this.catalog = new SqliteLibraryCatalog(database, this)
    this.reader = new SqliteLibraryReader(database, this)
    this.writer = new SqliteLibraryWriter(database, this)
    this.search = new SqliteLibrarySearch(database, this)
    this.metadata = new SqliteLibraryMetadata(database, this)
    this.archive = new SqliteLibraryArchive(database, this)
    this.subscriptions = new LibrarySubscriptionMetadata(database)
  }

  getCurrentAccountId(): number { return this.catalog.getCurrentAccountId() }
  /** Translation screening reads only titles/previews, never content_html/full_content_html. */
  getTranslationSources(accountId: number, articleIds: string[]): import('../../shared/translation').ListTranslationSource[] {
    const ids = [...new Set(articleIds)].slice(0, 50)
    if (!ids.length) return []
    return this.database.prepare(`SELECT a.id AS articleId, a.account_id AS accountId,
      a.feed_id AS feedId, a.title, a.description FROM articles a
      JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
      WHERE a.account_id = ? AND a.id IN (${ids.map(() => '?').join(',')})`)
      .all(accountId, ...ids) as unknown as import('../../shared/translation').ListTranslationSource[]
  }
  hasTranslationOwner(owner: import('../../shared/translation').TranslationOwner): boolean {
    return this.database.prepare(`SELECT 1 FROM articles a JOIN feeds f ON f.id = a.feed_id AND f.account_id = a.account_id
      WHERE a.id = ? AND a.account_id = ? AND a.feed_id = ?`).get(owner.articleId, owner.accountId, owner.feedId) !== undefined
  }
  snapshot(accountId = this.getCurrentAccountId()): LibrarySnapshot { return this.reader.snapshot(accountId) }
  setArticleFullContent(articleId: string, html: string | null): void { return this.writer.setArticleFullContent(articleId, html) }
  getArticleById(articleId: string): ArticleRecord | null { return this.reader.getArticleById(articleId) }
  getArticleByIdForAccount(accountId: number, articleId: string): ArticleRecord | null { return this.reader.getArticleByIdForAccount(accountId, articleId) }
  getArticleAccountId(articleId: string): number | null { return this.reader.getArticleAccountId(articleId) }
  setArticleFullContentForAccount(accountId: number, articleId: string, html: string | null): number { return this.writer.setArticleFullContentForAccount(accountId, articleId, html) }
  listArticleCleanupMetadata(accountId: number, feedId: string): Array<{ id: string; url: string | null; isStarred: boolean }> { return this.reader.listArticleCleanupMetadata(accountId, feedId) }
  listArticlesByFeed(feedId: string): ArticleRecord[] { return this.reader.listArticlesByFeed(feedId) }
  listArticlesByFeedForAccount(accountId: number, feedId: string): ArticleRecord[] { return this.reader.listArticlesByFeedForAccount(accountId, feedId) }
  listArticlesByGroup(groupId: string): ArticleRecord[] { return this.reader.listArticlesByGroup(groupId) }
  listFeedArticleStats(): FeedArticleStats[] { return this.reader.listFeedArticleStats() }
  upsertWebsiteFeedWithArticles(feed: FeedRecord, articles: ArticleRecord[], obsoleteArticleIds: string[]): void {
    this.transaction(() => {
      this.upsertFeed(feed)
      this.writer.upsertArticlesPrepared(articles)
      const deleteStatement = this.database.prepare('DELETE FROM articles WHERE id = ? AND is_starred = 0')
      for (const articleId of obsoleteArticleIds) deleteStatement.run(articleId)
    })
  }

  upsertRssHubFeedWithArticles(
    feed: FeedRecord,
    articles: ArticleRecord[],
    descriptor: RssHubSubscriptionDescriptor
  ): void {
    this.upsertFeedWithArticles(feed, articles, { rssHubDescriptor: descriptor })
  }

  hasArticle(articleId: string): boolean { return this.reader.hasArticle(articleId) }
  existingArticleIds(articleIds: string[], accountId = this.getCurrentAccountId()): Set<string> { return this.reader.existingArticleIds(articleIds, accountId) }
  getRssHttpCache(feedId: string): RssHttpCacheRecord | null { return this.metadata.getRssHttpCache(feedId) }
  upsertFeedWithArticles(
    feed: FeedRecord,
    articles: ArticleRecord[],
    options: FeedWriteOptions = {}
  ): void {
    this.transaction(() => {
      this.upsertFeed(feed)
      this.writer.upsertArticlesPrepared(articles)
      if (options.jsonRule) this.subscriptions.saveJsonRule(feed.id, options.jsonRule)
      if (options.rssIdentities) this.subscriptions.saveRssIdentities(feed.id, options.rssIdentities)
      if (options.rssHttpCache) this.metadata.upsertRssHttpCache(options.rssHttpCache)
      if (options.rssHubDescriptor) this.setRssHubDescriptor(feed.id, options.rssHubDescriptor)
    })
  }

  /** 批次仅执行同步落库，任一成员失败时整体回滚。 */
  transaction<T>(work: () => T): T { return libraryTransaction(this.database, work) }
  getJsonFeedRule(feedId: string): JsonRule | null { return this.subscriptions.getJsonRule(feedId) }
  getRssArticleIdentities(feedId: string): Map<string, string> { return this.subscriptions.getRssIdentities(feedId) }

  getFeedById(feedId: string): FeedRecord | null { return this.catalog.getFeedById(feedId) }
  getFeedByIdForAccount(accountId: number, feedId: string): FeedRecord | null { return this.catalog.getFeedByIdForAccount(accountId, feedId) }
  findFeedByUrl(url: string): FeedRecord | null { return this.catalog.findFeedByUrl(url) }
  findFeedByUrlForAccount(accountId: number, url: string): FeedRecord | null { return this.catalog.findFeedByUrlForAccount(accountId, url) }
  listGroups(): GroupRecord[] { return this.catalog.listGroups() }
  listGroupsForAccount(accountId: number): GroupRecord[] { return this.catalog.listGroupsForAccount(accountId) }
  getDefaultGroupForAccount(accountId: number): GroupRecord | null { return this.catalog.getDefaultGroupForAccount(accountId) }
  getCurrentDefaultGroup(): GroupRecord { return this.catalog.getCurrentDefaultGroup() }
  upsertGroup(group: GroupRecord): void { return this.catalog.upsertGroup(group) }
  deleteArticlesByFeed(feedId: string, includeStarred = false): void { return this.writer.deleteArticlesByFeed(feedId, includeStarred) }
  deleteFeed(feedId: string): void { return this.catalog.deleteFeed(feedId) }
  listFeeds(): FeedRecord[] { return this.catalog.listFeeds() }
  listFeedsForAccount(accountId: number): FeedRecord[] { return this.catalog.listFeedsForAccount(accountId) }
  upsertFeed(feed: FeedRecord): void { return this.catalog.upsertFeed(feed) }
  upsertArticle(article: ArticleRecord): void { return this.writer.upsertArticle(article) }
  listArticles(limit = 200): ArticleRecord[] { return this.reader.listArticles(limit) }
  listArticleMetadata(limit = 30, titleQuery = ''): ArticleMetadataRecord[] { return this.search.listArticleMetadata(limit, titleQuery) }
  getArticleMetadataById(articleId: string): ArticleMetadataRecord | null { return this.search.getArticleMetadataById(articleId) }
  listArticlesForAccount(accountId: number, limit = 200): ArticleRecord[] { return this.reader.listArticlesForAccount(accountId, limit) }
  searchArticles(query: string, limit = 100): ArticleSearchResult[] { return this.search.searchArticles(query, limit) }
  setArticleUnread(articleId: string, unread: boolean): void { return this.writer.setArticleUnread(articleId, unread) }
  setArticleUnreadForAccount(accountId:number, articleId:string, unread:boolean):void { return this.writer.setArticleUnreadForAccount(accountId, articleId, unread) }
  setArticleUnreadBatchForAccount(accountId:number, articleIds:string[], unread:boolean):void { return this.writer.setArticleUnreadBatchForAccount(accountId, articleIds, unread) }
  setArticleStarred(articleId: string, starred: boolean): void { return this.writer.setArticleStarred(articleId, starred) }
  setArticleStarredForAccount(accountId:number, articleId:string, starred:boolean):void { return this.writer.setArticleStarredForAccount(accountId, articleId, starred) }
  setArticleStarredBatchForAccount(accountId:number, articleIds:string[], starred:boolean):void { return this.writer.setArticleStarredBatchForAccount(accountId, articleIds, starred) }
  setRssHubSourceUrl(feedId: string, sourceUrl: string): void { return this.metadata.setRssHubSourceUrl(feedId, sourceUrl) }
  setRssHubDescriptor(feedId: string, descriptor: RssHubSubscriptionDescriptor): void { return this.metadata.setRssHubDescriptor(feedId, descriptor) }
  getRssHubSourceUrl(feedId: string): string | null { return this.metadata.getRssHubSourceUrl(feedId) }
  getRssHubDescriptor(feedId: string): RssHubSubscriptionDescriptor | null { return this.metadata.getRssHubDescriptor(feedId) }
  findRssHubFeedByRoute(routePath: string): FeedRecord | null { return this.metadata.findRssHubFeedByRoute(routePath) }
  listRssHubDescriptors(): Record<string, RssHubSubscriptionDescriptor> { return this.metadata.listRssHubDescriptors() }
  listRssHubSourceUrls(): Record<string, string> { return this.metadata.listRssHubSourceUrls() }
  deleteAccountData(accountId: number): void { return this.catalog.deleteAccountData(accountId) }
  deleteNonStarredArticlesForAccount(accountId: number): void { return this.archive.deleteNonStarredArticlesForAccount(accountId) }
  listArticleStateForAccount(accountId: number): Array<{ id:string;isUnread:boolean;isStarred:boolean }> { return this.reader.listArticleStateForAccount(accountId) }
  isArchivedLink(feedId:string,link:string|null|undefined):boolean { return this.archive.isArchivedLink(feedId, link) }
  archivedLinks(feedId: string, links: Array<string | null | undefined>): Set<string> { return this.archive.archivedLinks(feedId, links) }
  archivedArticleIds(feedId: string, ids: string[]): Set<string> { return this.archive.archivedArticleIds(feedId, ids) }
  archiveExpiredArticlesForAccount(accountId:number,keepArchivedMillis:number,now=Date.now()):number { return this.archive.archiveExpiredArticlesForAccount(accountId, keepArchivedMillis, now) }
  deleteFeedForAccountIfNoStarred(accountId:number,feedId:string):boolean { return this.catalog.deleteFeedForAccountIfNoStarred(accountId, feedId) }
  deleteGroupForAccountIfNoStarred(accountId:number,groupId:string):boolean { return this.catalog.deleteGroupForAccountIfNoStarred(accountId, groupId) }
}
