import { createHash, randomUUID } from 'node:crypto'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { WebsiteInspectionResult, WebsiteParsedArticle } from '../../../shared/website'
import { DEFAULT_GROUP_ID } from '../../database/migrations'
import { LibraryRepository } from '../../database/library-repository'
import { WebsiteSourceService } from './website-source-service'

export class WebsiteSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly sourceService: WebsiteSourceService
  ) {}

  /** Android subscribeWebsite 后立即 doSyncOneTime：先保存来源，再用同一 WebsiteHelper 同步填充文章。 */
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
    const refreshed = await this.refresh(feedId)
    return { feedId, insertedArticles: refreshed.insertedArticles }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }> {
    const feed = this.repository.getFeedById(feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'website') throw new Error(`来源不是网站：${feed.name}`)
    const parsed = await this.sourceService.fetchArticles(feed, fetchedAt)
    const articles = parsed.map((item) => toWebsiteArticleRecord(feed.id, item, fetchedAt))
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

