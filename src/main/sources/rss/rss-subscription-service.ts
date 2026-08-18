import { createHash, randomUUID } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { DiscoveredRssFeed, RssFeedItem, RssSubscriptionResult } from '../../../shared/rss'
import { DEFAULT_GROUP_ID } from '../../database/migrations'
import { LibraryRepository } from '../../database/library-repository'
import type { RssHubResolver } from '../rsshub/rsshub-resolver'
import { RssDiscoveryService } from './rss-discovery-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'

export interface RssRefreshResult {
  feedId: string
  fetchedArticles: number
  insertedArticles: number
}

export class RssSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly discovery: RssDiscoveryService = new RssDiscoveryService(),
    private readonly rssHubResolver?: RssHubResolver,
    private readonly articleFilters?: ArticleFilterRepository
  ) {}

  async add(inputUrl: string): Promise<RssSubscriptionResult> {
    const discovered = await this.discovery.discover(inputUrl)
    return this.addDiscovered(discovered)
  }

  addDiscovered(discovered: DiscoveredRssFeed): RssSubscriptionResult {
    const existing = this.repository.findFeedByUrl(discovered.feedUrl)
    if (existing) throw new Error(`来源已存在：${existing.name}`)

    const now = Date.now()
    const feedId = randomUUID()
    const accountId = this.repository.getCurrentAccountId()
    const feed = toFeedRecord(feedId, discovered, now, this.repository.getCurrentDefaultGroup().id, accountId)
    const candidateArticles = discovered.items.map((item) => toArticleRecord(feedId, item, now, accountId))
    const articles = this.articleFilters?.filterArticles(feedId, candidateArticles).kept ?? candidateArticles
    this.repository.upsertFeedWithArticles(
      feed,
      articles,
      discovered.etag || discovered.lastModified
        ? {
            feedId,
            feedUrl: feed.url,
            etag: discovered.etag ?? null,
            lastModified: discovered.lastModified ?? null,
            updatedAt: now
          }
        : undefined
    )

    return {
      feedId,
      feed: discovered,
      insertedArticles: articles.length
    }
  }

  async refresh(feedId: string, now = Date.now()): Promise<RssRefreshResult> {
    const existing = this.repository.getFeedById(feedId)
    if (!existing) throw new Error(`来源不存在：${feedId}`)
    if (existing.sourceType !== 'rss') throw new Error(`来源不是 RSS/Atom：${existing.name}`)

    let discovered: DiscoveredRssFeed
    let responseValidators: { etag: string | null; lastModified: string | null } | null = null
    try {
      const cache = this.repository.getRssHttpCache(feedId)
      const validCache = cache?.feedUrl === existing.url ? cache : null
      const direct = await this.discovery.parseDirectConditional(
        existing.url,
        existing.sourcePageUrl ?? existing.url,
        {
          etag: validCache?.etag,
          lastModified: validCache?.lastModified
        }
      )
      if (direct.notModified) {
        // 304 是最便宜的成功路径：不解析 XML、不查 archived/articles、不跑过滤器、
        // 不更新 Feed/Article/cache，避免无意义的 SQLite/renderer invalidation。
        return { feedId, fetchedArticles: 0, insertedArticles: 0 }
      }
      discovered = direct.feed!
      responseValidators = { etag: direct.etag, lastModified: direct.lastModified }
      if (discovered.items.length === 0) {
        const beforeRecoveryUrl = discovered.feedUrl
        discovered = await this.recoverRssHubFeed(existing, discovered)
        if (discovered.feedUrl !== beforeRecoveryUrl) responseValidators = null
      }
    } catch (error) {
      const recovered = await this.tryRecoverRssHubFeed(existing)
      if (!recovered) throw error
      discovered = recovered
      responseValidators = null
    }
    const candidates = discovered.items
      .map((item) => toArticleRecord(existing.id, item, now, existing.accountId))
    const archivedLinks = this.repository.archivedLinks(existing.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(existing.id, candidateArticles).kept ?? candidateArticles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), existing.accountId)
    const insertedArticles = articles.length - existingIds.size
    const refreshedFeed: FeedRecord = {
      ...existing,
      url: discovered.feedUrl,
      sourcePageUrl: discovered.sourcePageUrl || existing.sourcePageUrl,
      name: discovered.title || existing.name,
      icon: discovered.iconUrl ?? existing.icon,
      updatedAt: now
    }
    this.repository.upsertFeedWithArticles(
      refreshedFeed,
      articles,
      {
        feedId,
        feedUrl: refreshedFeed.url,
        etag: responseValidators?.etag ?? null,
        lastModified: responseValidators?.lastModified ?? null,
        updatedAt: now
      }
    )
    return { feedId, fetchedArticles: articles.length, insertedArticles }
  }

  private async recoverRssHubFeed(existing: FeedRecord, fallback: DiscoveredRssFeed): Promise<DiscoveredRssFeed> {
    return (await this.tryRecoverRssHubFeed(existing)) ?? fallback
  }

  private async tryRecoverRssHubFeed(existing: FeedRecord): Promise<DiscoveredRssFeed | null> {
    const sourceUrl = this.repository.getRssHubSourceUrl(existing.id)
    if (!sourceUrl || !this.rssHubResolver) return null
    const recovered = (await this.rssHubResolver.probe(sourceUrl))
      .find((result) => result.available && (result.feed?.items.length ?? 0) > 0)
    if (!recovered?.feed || !recovered.match.feedUrl) return null
    return {
      ...recovered.feed,
      feedUrl: recovered.match.feedUrl,
      sourcePageUrl: sourceUrl
    }
  }
}

export function toFeedRecord(feedId: string, discovered: DiscoveredRssFeed, now: number, groupId = DEFAULT_GROUP_ID, accountId?: number): FeedRecord {
  return {
    id: feedId,
    accountId,
    groupId,
    name: discovered.title,
    url: discovered.feedUrl,
    sourcePageUrl: discovered.sourcePageUrl,
    sourceType: 'rss',
    icon: discovered.iconUrl,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

export function toArticleRecord(feedId: string, item: RssFeedItem, now: number, accountId?: number): ArticleRecord {
  const rawHtml = item.contentHtml ?? item.descriptionHtml
  return {
    id: stableArticleId(feedId, item),
    accountId,
    feedId,
    title: item.title,
    url: item.link || null,
    author: item.author,
    publishedAt: item.publishedAt ?? now,
    description: htmlToText(item.descriptionHtml || rawHtml).slice(0, 280),
    contentHtml: rawHtml || null,
    fullContentHtml: null,
    imageUrl: item.imageUrl,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

/** Android 的同步去重键实际是 feedId + article.link；link 缺失时才使用 feed 自身标识兜底。 */
export function stableArticleId(feedId: string, item: RssFeedItem): string {
  const dedupeKey = item.link || item.sourceId
  return `rss-${createHash('sha256').update(feedId).update('\u0000').update(dedupeKey).digest('hex')}`
}

function htmlToText(html: string): string {
  if (!html) return ''
  return cheerio.load(`<body>${html}</body>`)('body').text().replace(/\s+/g, ' ').trim()
}

