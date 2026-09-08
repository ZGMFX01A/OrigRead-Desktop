import { randomUUID } from 'node:crypto'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubProbeResult } from '../../../shared/rsshub'
import { LibraryRepository } from '../../database/library-repository'
import { toArticleRecord, toFeedRecord } from '../rss/rss-subscription-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'

export interface RssHubSubscriptionResult {
  feedId: string
  feedUrl: string
  sourcePageUrl: string
  routeId: string
  routeName: string
  insertedArticles: number
}

/**
 * 只负责持久化一个已经由 Resolver 验证通过的 RSSHub 候选。
 * 候选如何与 RSS / JSON / Website 排名属于统一来源选择器，不在这里重复决策。
 */
export class RssHubSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly articleFilters?: ArticleFilterRepository
  ) {}

  subscribeDirect(sourcePageUrl: string, discovered: DiscoveredRssFeed): RssHubSubscriptionResult {
    return this.persist(sourcePageUrl, discovered, 'direct-endpoint', 'RSSHub')
  }

  subscribe(sourcePageUrl: string, result: RssHubProbeResult): RssHubSubscriptionResult {
    if (!result.available || !result.feed || !result.match.feedUrl) {
      throw new Error('RSSHub 候选不可用，不能保存订阅')
    }
    return this.persist(
      sourcePageUrl,
      { ...result.feed, feedUrl: result.match.feedUrl, sourcePageUrl },
      result.match.route.id,
      result.match.route.name
    )
  }

  private persist(
    sourcePageUrl: string,
    discovered: DiscoveredRssFeed,
    routeId: string,
    routeName: string
  ): RssHubSubscriptionResult {
    const existing = this.repository.findFeedByUrl(discovered.feedUrl)
    if (existing) {
      return {
        feedId: existing.id,
        feedUrl: discovered.feedUrl,
        sourcePageUrl,
        routeId,
        routeName,
        insertedArticles: 0
      }
    }

    const now = Date.now()
    const feedId = randomUUID()
    const normalized = { ...discovered, sourcePageUrl }
    const accountId = this.repository.getCurrentAccountId()
    const feed = toFeedRecord(feedId, normalized, now, this.repository.getCurrentDefaultGroup().id, accountId)
    const candidateArticles = normalized.items.map((item) => toArticleRecord(feedId, item, now, accountId))
    const articles = this.articleFilters?.filterArticles(feedId, candidateArticles).kept ?? candidateArticles
    this.repository.upsertRssHubFeedWithArticles(feed, articles, sourcePageUrl)

    return {
      feedId,
      feedUrl: normalized.feedUrl,
      sourcePageUrl,
      routeId,
      routeName,
      insertedArticles: articles.length
    }
  }
}
