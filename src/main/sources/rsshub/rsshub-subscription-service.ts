import { randomUUID } from 'node:crypto'
import type { RssHubProbeResult } from '../../../shared/rsshub'
import { LibraryRepository } from '../../database/library-repository'
import { toArticleRecord, toFeedRecord } from '../rss/rss-subscription-service'

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
  constructor(private readonly repository: LibraryRepository) {}

  subscribe(sourcePageUrl: string, result: RssHubProbeResult): RssHubSubscriptionResult {
    if (!result.available || !result.feed || !result.match.feedUrl) {
      throw new Error('RSSHub 候选不可用，不能保存订阅')
    }
    const existing = this.repository.findFeedByUrl(result.match.feedUrl)
    if (existing) {
      return {
        feedId: existing.id,
        feedUrl: result.match.feedUrl,
        sourcePageUrl,
        routeId: result.match.route.id,
        routeName: result.match.route.name,
        insertedArticles: 0
      }
    }

    const now = Date.now()
    const feedId = randomUUID()
    const discovered = {
      ...result.feed,
      feedUrl: result.match.feedUrl,
      sourcePageUrl
    }
    const accountId = this.repository.getCurrentAccountId()
    const feed = toFeedRecord(feedId, discovered, now, this.repository.getCurrentDefaultGroup().id, accountId)
    const articles = discovered.items.map((item) => toArticleRecord(feedId, item, now, accountId))
    this.repository.upsertRssHubFeedWithArticles(feed, articles, sourcePageUrl)

    return {
      feedId,
      feedUrl: result.match.feedUrl,
      sourcePageUrl,
      routeId: result.match.route.id,
      routeName: result.match.route.name,
      insertedArticles: articles.length
    }
  }
}
