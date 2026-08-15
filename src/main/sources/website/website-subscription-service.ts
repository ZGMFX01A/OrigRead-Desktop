import { createHash, randomUUID } from 'node:crypto'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { WebsiteInspectionResult, WebsiteParsedArticle } from '../../../shared/website'
import { DEFAULT_GROUP_ID } from '../../database/migrations'
import { LibraryRepository } from '../../database/library-repository'
import { WebsiteSourceService } from './website-source-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'

export class WebsiteSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly sourceService: WebsiteSourceService,
    private readonly articleFilters?: ArticleFilterRepository
  ) {}

  /**
   * Android subscribeWebsite 的订阅提交与后续同步是两件事：
   * 来源先持久化，doSyncOneTime 即使网络失败也不会把“订阅”本身回滚成失败。
   * Desktop 也保持这个语义，避免网站第二次请求遇到 418/429 时留下“已入库但 UI 仍报添加失败”的半状态。
   */
  async add(inspection: WebsiteInspectionResult, dynamicRendering = false): Promise<{ feedId: string; insertedArticles: number }> {
    const existing = this.repository.findFeedByUrl(inspection.sourceUrl)
    if (existing) throw new Error(`来源已存在：${existing.name}`)
    const now = Date.now()
    const feedId = randomUUID()
    const feed: FeedRecord = {
      id: feedId,
      groupId: DEFAULT_GROUP_ID,
      name: inspection.title,
      url: inspection.sourceUrl,
      sourcePageUrl: inspection.sourceUrl,
      sourceType: 'website',
      icon: inspection.iconUrl,
      isNotification: false,
      isFullContent: false,
      isBrowser: false,
      dynamicRendering,
      createdAt: now,
      updatedAt: now
    }
    this.repository.upsertFeed(feed)
    this.sourceService.setDynamicRenderingEnabled(feedId, dynamicRendering)
    try {
      const refreshed = await this.refresh(feedId)
      return { feedId, insertedArticles: refreshed.insertedArticles }
    } catch {
      // 订阅已经成功保存；刷新失败留给后续手动/周期同步重试，不把添加操作伪装成失败。
      return { feedId, insertedArticles: 0 }
    }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }> {
    const feed = this.repository.getFeedById(feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'website') throw new Error(`来源不是网站：${feed.name}`)
    const parsed = await this.sourceService.fetchArticles(feed, fetchedAt)
    const candidateArticles = parsed.map((item) => toWebsiteArticleRecord(feed.id, item, fetchedAt))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const insertedArticles = articles.reduce((count, article) => count + (this.repository.hasArticle(article.id) ? 0 : 1), 0)
    const existing = this.repository.listArticlesByFeed(feed.id)
    const obsolete = this.sourceService.findObsoleteArticleIds(feed, existing, parsed)
    this.repository.upsertWebsiteFeedWithArticles({ ...feed, updatedAt: fetchedAt }, articles, obsolete)
    return { feedId, fetchedArticles: articles.length, insertedArticles, deletedArticles: obsolete.length }
  }
}

function toWebsiteArticleRecord(feedId: string, item: WebsiteParsedArticle, now: number): ArticleRecord {
  return {
    id: `website-${createHash('sha256').update(feedId).update('\u0000').update(item.link).digest('hex')}`,
    feedId,
    title: item.title,
    url: item.link,
    author: item.author,
    publishedAt: item.publishedAt,
    description: '',
    contentHtml: item.descriptionHtml || null,
    fullContentHtml: null,
    imageUrl: item.imageUrl,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

