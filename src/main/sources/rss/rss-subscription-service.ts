import { randomUUID } from 'node:crypto'
import type { FeedRecord } from '../../../shared/library'
import type { DiscoveredRssFeed, RssSubscriptionResult } from '../../../shared/rss'
import type { LibraryRepository } from '../../database/library-repository'
import type { RssHubResolver } from '../rsshub/rsshub-resolver'
import { RssDiscoveryService } from './rss-discovery-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'
import { prepareRssArticles, toFeedRecord } from './rss-article-records'
import { loadRssRefresh } from './rss-refresh-loader'
export { toArticleRecord, toFeedRecord, stableArticleId } from './rss-article-records'

export interface RssRefreshResult {
  feedId: string
  fetchedArticles: number
  insertedArticles: number
}

export class RssSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly discovery: RssDiscoveryService = new RssDiscoveryService(),
    private readonly options: { resolver?: RssHubResolver; articleFilters?: ArticleFilterRepository } = {}
  ) {}

  /** 网络开始前固定账户，不能在回包后借用用户刚切换的账户。 */
  async add(inputUrl: string): Promise<RssSubscriptionResult> {
    const accountId = this.repository.getCurrentAccountId()
    const discovered = await this.discovery.discover(inputUrl)
    return this.addDiscovered(discovered, accountId)
  }

  hasExistingSource(inputUrl: string): boolean {
    return this.repository.findFeedByUrl(inputUrl) !== null
  }

  getCurrentAccountId(): number { return this.repository.getCurrentAccountId() }

  /** 直接复用预览文章，来源、身份映射与 HTTP 缓存一起写入。 */
  addDiscovered(discovered: DiscoveredRssFeed, accountId = this.repository.getCurrentAccountId()): RssSubscriptionResult {
    const existing = this.repository.findFeedByUrlForAccount(accountId, discovered.feedUrl)
    if (existing) return { feedId: existing.id, feed: discovered, insertedArticles: 0 }
    const group = this.repository.getDefaultGroupForAccount(accountId)
    if (!group) throw new Error('订阅账户缺少默认分组')
    const now = Date.now()
    const feed = toFeedRecord(randomUUID(), discovered, { now, groupId: group.id, accountId })
    const batch = prepareRssArticles(this.repository, { feed, discovered, now })
    const articles = this.options.articleFilters?.filterArticles(feed.id, batch.articles).kept ?? batch.articles
    this.repository.upsertFeedWithArticles(feed, articles, {
      rssIdentities: batch.identities,
      rssHttpCache: discovered.etag || discovered.lastModified ? {
        feedId: feed.id, feedUrl: feed.url, etag: discovered.etag ?? null,
        lastModified: discovered.lastModified ?? null, updatedAt: now
      } : undefined
    })
    return { feedId: feed.id, feed: discovered, insertedArticles: articles.length }
  }

  /** 刷新使用批次开始时的账户；304 不写库，其他失败原样传播。 */
  async refresh(feedId: string, now = Date.now(), accountId = this.repository.getCurrentAccountId()): Promise<RssRefreshResult> {
    const existing = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!existing) throw new Error('来源不存在：' + feedId)
    if (existing.sourceType !== 'rss') throw new Error('来源不是 RSS/Atom：' + existing.name)
    const loaded = await loadRssRefresh({ repository: this.repository, discovery: this.discovery, resolver: this.options.resolver }, existing)
    if (!loaded.feed) return { feedId, fetchedArticles: 0, insertedArticles: 0 }
    return this.persistRefresh(existing, loaded.feed, {
      now, validators: loaded.validators, descriptor: loaded.descriptor
    })
  }

  /** 对既有误分类空来源重新做真实 XML 校验，成功才改为 RSS。 */
  async tryRecoverMisclassifiedEmptyWebsite(
    feedId: string, now = Date.now(), accountId = this.repository.getCurrentAccountId()
  ): Promise<RssRefreshResult | null> {
    const existing = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!existing || existing.sourceType !== 'website') return null
    if (this.repository.listArticlesByFeedForAccount(accountId, feedId).length > 0) return null
    let direct: Awaited<ReturnType<RssDiscoveryService['parseDirectConditional']>>
    try {
      direct = await this.discovery.parseDirectConditional(existing.url, { sourcePageUrl: existing.sourcePageUrl ?? existing.url, skipIconDiscovery: true })
    } catch {
      // 原 Website 失败由上层汇总；这里的验证失败表示没有可恢复的真实 RSS。
      return null
    }
    if (direct.notModified || !direct.feed || direct.feed.items.length === 0) return null
    return this.persistRefresh({ ...existing, sourceType: 'rss', isBrowser: false, dynamicRendering: false }, direct.feed, {
      now, validators: { etag: direct.etag, lastModified: direct.lastModified }
    })
  }

  /** 内容刷新保留用户状态，并在同一事务提交文章、身份和响应验证器。 */
  private persistRefresh(existing: FeedRecord, discovered: DiscoveredRssFeed, options: {
    now: number
    validators: { etag: string | null; lastModified: string | null }
    descriptor?: import('../../../shared/rsshub').RssHubSubscriptionDescriptor
  }): RssRefreshResult {
    const batch = prepareRssArticles(this.repository, { feed: existing, discovered, now: options.now })
    const articles = this.options.articleFilters?.filterArticles(existing.id, batch.articles).kept ?? batch.articles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), existing.accountId)
    const refreshedFeed = {
      ...existing, url: discovered.feedUrl, sourcePageUrl: discovered.sourcePageUrl || existing.sourcePageUrl,
      name: discovered.title || existing.name, icon: discovered.iconUrl ?? existing.icon, updatedAt: options.now
    }
    this.repository.upsertFeedWithArticles(refreshedFeed, articles, {
      rssIdentities: batch.identities, rssHubDescriptor: options.descriptor,
      rssHttpCache: { feedId: existing.id, feedUrl: refreshedFeed.url, ...options.validators, updatedAt: options.now }
    })
    return { feedId: existing.id, fetchedArticles: articles.length, insertedArticles: articles.length - existingIds.size }
  }
}

