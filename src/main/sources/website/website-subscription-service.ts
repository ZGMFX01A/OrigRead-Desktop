import { createHash, randomUUID } from 'node:crypto'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { WebsiteInspectionResult, WebsiteParsedArticle } from '../../../shared/website'
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
   * 探测阶段已经成功解析出了首批文章，确认订阅时必须直接复用这批结果原子落库。
   * 不能在添加事务里再次请求目标站点，否则第二次请求遇到 418/429/超时会制造
   * “预览明明有文章，添加后却是空来源”的伪成功。
   */
  async add(inspection: WebsiteInspectionResult, dynamicRendering = false): Promise<{ feedId: string; insertedArticles: number }> {
    const existing = this.repository.findFeedByUrl(inspection.sourceUrl)
    if (existing) return { feedId: existing.id, insertedArticles: 0 }
    const now = Date.now()
    const feedId = randomUUID()
    const accountId = this.repository.getCurrentAccountId()
    const feed: FeedRecord = {
      id: feedId,
      accountId,
      groupId: this.repository.getCurrentDefaultGroup().id,
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
    const candidates = inspection.candidate.articles
      .map((item) => toWebsiteArticleRecord(feed.id, item, { now, accountId: feed.accountId }))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    // 偏好写入失败时不能留下已注册来源；网络解析已在订阅确认前完成。
    this.repository.transaction(() => {
      this.repository.upsertFeedWithArticles(feed, articles)
      this.sourceService.setDynamicRenderingEnabled(feedId, dynamicRendering)
    })
    return { feedId, insertedArticles: articles.length }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now(),
    accountId = this.repository.getCurrentAccountId()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }> {
    const feed = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'website') throw new Error(`来源不是网站：${feed.name}`)
    const parsed = await this.sourceService.fetchArticles(feed, fetchedAt)
    const candidates = parsed
      .map((item) => toWebsiteArticleRecord(feed.id, item, { now: fetchedAt, accountId: feed.accountId }))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), feed.accountId)
    const insertedArticles = articles.length - existingIds.size
    const existing = this.repository.listArticlesByFeedForAccount(accountId, feed.id)
    const obsolete = this.sourceService.findObsoleteArticleIds(feed, existing, parsed)
    this.repository.upsertWebsiteFeedWithArticles({ ...feed, updatedAt: fetchedAt }, articles, obsolete)
    return { feedId, fetchedArticles: articles.length, insertedArticles, deletedArticles: obsolete.length }
  }
}

/** 同一网站来源按文章链接去重，更新内容时保留本地状态。 */
function toWebsiteArticleRecord(feedId: string, item: WebsiteParsedArticle, options: { now: number; accountId?: number }): ArticleRecord {
  const { now, accountId } = options
  return {
    id: `website-${createHash('sha256').update(feedId).update('\u0000').update(item.link).digest('hex')}`,
    accountId,
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
