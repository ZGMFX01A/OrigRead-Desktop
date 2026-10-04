import { randomUUID } from 'node:crypto'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubProbeResult, RssHubSubscriptionDescriptor } from '../../../shared/rsshub'
import { LibraryRepository } from '../../database/library-repository'
import { prepareRssArticles, toFeedRecord } from '../rss/rss-article-records'
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

  hasExistingRoute(routePath: string): boolean {
    return this.repository.findRssHubFeedByRoute(routePath) !== null
  }

  /** 预览已完成网络校验，多个频道只执行同步落库，失败时撤销整个批次。 */
  subscribeMany(selections: Array<{ sourceUrl: string; result: RssHubProbeResult; preferredInstance: string | null }>): RssHubSubscriptionResult[] {
    return this.repository.transaction(() => selections.map((selection) =>
      this.subscribe(selection.sourceUrl, selection.result, selection.preferredInstance)))
  }

  subscribe(sourcePageUrl: string, result: RssHubProbeResult, preferredInstance: string | null = null): RssHubSubscriptionResult {
    if (!result.available || !result.feed || !result.match.feedUrl) {
      throw new Error('RSSHub 候选不可用，不能保存订阅')
    }
    return this.persist(
      {
        originalInput: sourcePageUrl,
        routePath: result.routePath ?? null,
        preferredInstance,
        lastResolvedInstance: result.instanceBaseUrl ?? null,
        lastResolvedUrl: result.match.feedUrl
      },
      { ...result.feed, feedUrl: result.match.feedUrl, sourcePageUrl },
      { id: result.match.route.id, name: result.match.route.name }
    )
  }

  private persist(
    descriptor: RssHubSubscriptionDescriptor,
    discovered: DiscoveredRssFeed,
    route: { id: string; name: string }
  ): RssHubSubscriptionResult {
    const routeId = route.id
    const routeName = route.name
    if (descriptor.routePath) {
      const existingRoute = this.repository.findRssHubFeedByRoute(descriptor.routePath)
      if (existingRoute) {
        return {
          feedId: existingRoute.id,
          feedUrl: existingRoute.url,
          sourcePageUrl: descriptor.originalInput,
          routeId,
          routeName,
          insertedArticles: 0
        }
      }
    }
    const existing = this.repository.findFeedByUrl(discovered.feedUrl)
    if (existing) {
      return {
        feedId: existing.id,
        feedUrl: discovered.feedUrl,
        sourcePageUrl: descriptor.originalInput,
        routeId,
        routeName,
        insertedArticles: 0
      }
    }

    const now = Date.now()
    const feedId = randomUUID()
    const normalized = { ...discovered, sourcePageUrl: descriptor.originalInput }
    const accountId = this.repository.getCurrentAccountId()
    const feed = toFeedRecord(feedId, normalized, { now, groupId: this.repository.getCurrentDefaultGroup().id, accountId })
    const batch = prepareRssArticles(this.repository, { feed, discovered: normalized, now })
    const candidateArticles = batch.articles
    const articles = this.articleFilters?.filterArticles(feedId, candidateArticles).kept ?? candidateArticles
    this.repository.upsertFeedWithArticles(feed, articles, { rssHubDescriptor: descriptor, rssIdentities: batch.identities })

    return {
      feedId,
      feedUrl: normalized.feedUrl,
      sourcePageUrl: descriptor.originalInput,
      routeId,
      routeName,
      insertedArticles: articles.length
    }
  }
}
