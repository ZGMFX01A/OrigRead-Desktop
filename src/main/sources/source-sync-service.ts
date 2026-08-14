import type { FeedRecord } from '../../shared/library'
import type { SourceSyncBatchResult, SourceSyncItemResult } from '../../shared/source-sync'
import { LibraryRepository } from '../database/library-repository'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'

const MAX_CONCURRENT_SYNCS = 16

interface NormalizedRefreshResult {
  feedId: string
  fetchedArticles: number
  insertedArticles: number
  deletedArticles: number
}

/**
 * Desktop 对齐 Android LocalSourceService + LocalRssService.sync 的统一同步入口。
 * 具体抓取、RSSHub 恢复、Website 自动规则缓存等逻辑仍由各来源 service 自己负责。
 */
export class SourceSyncService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly rssService: RssSubscriptionService,
    private readonly jsonService: JsonSubscriptionService,
    private readonly websiteService: WebsiteSubscriptionService
  ) {}

  async refreshSource(feedId: string, fetchedAt = Date.now()): Promise<SourceSyncItemResult> {
    const feed = this.repository.getFeedById(feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    return this.refreshFeed(feed, fetchedAt)
  }

  /**
   * Android 使用 Semaphore(16) 并发抓取；单个 child 失败不会立刻取消其他来源，
   * 但整轮最终会返回 retry。Desktop 用同样的 16 并发上限，并把失败逐项汇总给 UI。
   */
  async refreshAllSources(fetchedAt = Date.now()): Promise<SourceSyncBatchResult> {
    const startedAt = fetchedAt
    const feeds = this.repository.listFeeds()
    const results = await mapWithConcurrency(feeds, MAX_CONCURRENT_SYNCS, async (feed) => {
      try {
        return await this.refreshFeed(feed, fetchedAt)
      } catch (error) {
        return failedResult(feed, error)
      }
    })

    const successful = results.filter((item) => item.status === 'success')
    const failed = results.filter((item) => item.status === 'failed')
    return {
      startedAt,
      finishedAt: Date.now(),
      sourceCount: results.length,
      successCount: successful.length,
      failedCount: failed.length,
      fetchedArticles: successful.reduce((sum, item) => sum + item.fetchedArticles, 0),
      insertedArticles: successful.reduce((sum, item) => sum + item.insertedArticles, 0),
      deletedArticles: successful.reduce((sum, item) => sum + item.deletedArticles, 0),
      retryRecommended: failed.length > 0,
      results
    }
  }

  private async refreshFeed(feed: FeedRecord, fetchedAt: number): Promise<SourceSyncItemResult> {
    const result: NormalizedRefreshResult = await (async () => {
      switch (feed.sourceType) {
        case 'rss': {
          const refreshed = await this.rssService.refresh(feed.id, fetchedAt)
          return { ...refreshed, deletedArticles: 0 }
        }
        case 'json': {
          const refreshed = await this.jsonService.refresh(feed.id, fetchedAt)
          return { ...refreshed, deletedArticles: 0 }
        }
        case 'website':
          return this.websiteService.refresh(feed.id, fetchedAt)
      }
    })()

    return {
      feedId: feed.id,
      feedName: feed.name,
      sourceType: feed.sourceType,
      status: 'success',
      fetchedArticles: result.fetchedArticles,
      insertedArticles: result.insertedArticles,
      deletedArticles: result.deletedArticles,
      error: null
    }
  }
}

function failedResult(feed: FeedRecord, error: unknown): SourceSyncItemResult {
  return {
    feedId: feed.id,
    feedName: feed.name,
    sourceType: feed.sourceType,
    status: 'failed',
    fetchedArticles: 0,
    insertedArticles: 0,
    deletedArticles: 0,
    error: error instanceof Error ? error.message : String(error)
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), values.length)

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++
      if (index >= values.length) return
      results[index] = await mapper(values[index]!)
    }
  }))
  return results
}

