import type { ArticleRecord, FeedRecord } from '../../shared/library'
import type { SourceSyncBatchResult, SourceSyncItemResult } from '../../shared/source-sync'
import { getGroupDescendantIds } from '../../shared/group-tree'
import { LibraryRepository } from '../database/library-repository'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'

// 来源同步保持 4 路并发任务门，控制同时处于活动状态的网络与解析任务；单源、分组与全量同步共享此并发限制。
const MAX_CONCURRENT_SYNCS = 4

export type SourceNewArticlesListener = (feed: FeedRecord, articles: ArticleRecord[]) => void | Promise<void>

interface NormalizedRefreshResult {
  feedId: string
  fetchedArticles: number
  insertedArticles: number
  deletedArticles: number
}

class TaskGate {
  private activeCount = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) {
      next()
    } else {
      this.activeCount--
    }
  }
}

/**
 * Desktop 对齐 Android LocalSourceService + LocalRssService.sync 的统一同步入口。
 * 具体抓取、RSSHub 恢复、Website 自动规则缓存等逻辑仍由各来源 service 自己负责。
 * 共享 4 路并发任务门和 (accountId, feedId) inflight 抓取复用，协调单源、分组与全量刷新。
 */
export class SourceSyncService {
  private readonly gate = new TaskGate(MAX_CONCURRENT_SYNCS)
  private readonly inflightFeeds = new Map<string, Promise<SourceSyncItemResult>>()

  constructor(
    private readonly repository: LibraryRepository,
    private readonly services: { rss: RssSubscriptionService; json: JsonSubscriptionService; website: WebsiteSubscriptionService },
    private readonly onNewArticles?: SourceNewArticlesListener
  ) {}

  async refreshSource(feedId: string, fetchedAt = Date.now(), accountId = this.repository.getCurrentAccountId()): Promise<SourceSyncItemResult> {
    const feed = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    const result = await this.refreshFeedWithGate(feed, fetchedAt, accountId)
    if (result.status === 'failed') {
      throw new Error(result.error ?? '刷新失败')
    }
    return result
  }

  /**
   * 按照 groupId 批量刷新该组自身及所有后代分组的来源。
   * 验证组归属防止跨账户越权；空组直接返回 sourceCount 为 0 的结果，不触发账户级归档或同步时间更新。
   * 包含直属和全部后代来源，按 feed.id 去重，复用既有 4 路并发队列。
   */
  async refreshGroup(groupId: string, fetchedAt = Date.now(), accountId = this.repository.getCurrentAccountId()): Promise<SourceSyncBatchResult> {
    const startedAt = fetchedAt
    const groups = this.repository.listGroupsForAccount(accountId)
    const group = groups.find((item) => item.id === groupId)
    if (!group) throw new Error(`分组不存在或不属于当前账户：${groupId}`)

    const descendantIds = getGroupDescendantIds(groupId, groups)
    const groupIds = new Set([groupId, ...descendantIds])

    const allFeeds = this.repository.listFeedsForAccount(accountId)
    const targetFeeds: FeedRecord[] = []
    const seenFeedIds = new Set<string>()

    for (const feed of allFeeds) {
      if (groupIds.has(feed.groupId) && !seenFeedIds.has(feed.id)) {
        seenFeedIds.add(feed.id)
        targetFeeds.push(feed)
      }
    }

    if (targetFeeds.length === 0) {
      return summarizeBatchResults(startedAt, [])
    }

    const results = await Promise.all(
      targetFeeds.map((feed) => this.refreshFeedWithGate(feed, fetchedAt, accountId))
    )
    return summarizeBatchResults(startedAt, results)
  }

  /**
   * 刷新当前账户下的所有来源。
   * 复用统一的 4 路并发任务门，并把逐项失败汇总给 UI，不中断整轮抓取。
   */
  async refreshAllSources(fetchedAt = Date.now(), accountId = this.repository.getCurrentAccountId()): Promise<SourceSyncBatchResult> {
    const startedAt = fetchedAt
    const feeds = this.repository.listFeedsForAccount(accountId)
    const results = await Promise.all(
      feeds.map((feed) => this.refreshFeedWithGate(feed, fetchedAt, accountId))
    )
    return summarizeBatchResults(startedAt, results)
  }

  private refreshFeedWithGate(feed: FeedRecord, fetchedAt: number, targetAccountId: number): Promise<SourceSyncItemResult> {
    const key = `${targetAccountId}:${feed.id}`
    const existing = this.inflightFeeds.get(key)
    if (existing) {
      return existing
    }

    const boundFeed: FeedRecord = { ...feed, accountId: targetAccountId }

    const promise = (async () => {
      try {
        return await this.gate.run(async () => {
          try {
            return await this.refreshFeed(boundFeed, fetchedAt)
          } catch (error) {
            return failedResult(boundFeed, error)
          }
        })
      } finally {
        this.inflightFeeds.delete(key)
      }
    })()

    this.inflightFeeds.set(key, promise)
    return promise
  }

  private async refreshFeed(feed: FeedRecord, fetchedAt: number): Promise<SourceSyncItemResult> {
    const existingArticleIds = feed.isNotification
      ? new Set(this.repository.listArticleIdsByFeedForAccount(feed.accountId!, feed.id))
      : null
    const result = await this.refreshByType(feed, fetchedAt)

    // 恢复旧脏数据时 sourceType/name 可能已在同一轮从 Website 改成 RSS；后续通知与 UI 结果
    // 必须读取落库后的 Feed，不能继续返回刷新前的旧快照。
    const refreshedFeed = this.repository.getFeedByIdForAccount(feed.accountId!, feed.id) ?? feed

    if (refreshedFeed.isNotification && result.insertedArticles > 0 && existingArticleIds && this.onNewArticles) {
      const inserted = this.repository
        .listArticleSummariesByFeedForAccount(feed.accountId!, feed.id)
        .filter((article) => !existingArticleIds.has(article.id))
      if (inserted.length > 0) await this.onNewArticles(refreshedFeed, inserted)
    }

    return {
      feedId: feed.id,
      feedName: refreshedFeed.name,
      sourceType: refreshedFeed.sourceType,
      status: 'success',
      fetchedArticles: result.fetchedArticles,
      insertedArticles: result.insertedArticles,
      deletedArticles: result.deletedArticles,
      error: null
    }
  }

  /** 同一账户快照传入具体服务，失败仍按原异常进入整轮结果汇总。 */
  private async refreshByType(feed: FeedRecord, fetchedAt: number): Promise<NormalizedRefreshResult> {
    if (feed.sourceType === 'rss') return { ...await this.services.rss.refresh(feed.id, fetchedAt, feed.accountId), deletedArticles: 0 }
    if (feed.sourceType === 'json') return { ...await this.services.json.refresh(feed.id, fetchedAt, feed.accountId), deletedArticles: 0 }
    try {
      return await this.services.website.refresh(feed.id, fetchedAt, feed.accountId)
    } catch (error) {
      // 旧版误分类的空 Website 只有通过真实 RSS 校验才能恢复；否则原 Website 错误继续暴露。
      const recovered = await this.services.rss.tryRecoverMisclassifiedEmptyWebsite(feed.id, fetchedAt, feed.accountId)
      if (!recovered) throw error
      return { ...recovered, deletedArticles: 0 }
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

function summarizeBatchResults(startedAt: number, results: SourceSyncItemResult[]): SourceSyncBatchResult {
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
