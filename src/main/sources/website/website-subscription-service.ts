import { createHash, randomUUID } from 'node:crypto'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { WebsiteInspectionResult, WebsiteParsedArticle } from '../../../shared/website'
import { LibraryRepository } from '../../database/library-repository'
import { WebsiteSourceService } from './website-source-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'
import { ConfigurableWebsiteParser } from './configurable-website-parser'

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

  /** 刷新前固定账户，回包后校验来源身份并保留用户最新偏好，再原子更新文章。 */
  async refresh(
    feedId: string,
    fetchedAt = Date.now(),
    accountId = this.repository.getCurrentAccountId()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }> {
    const feed = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'website') throw new Error(`来源不是网站：${feed.name}`)
    // 来源身份必须在解析偏好写入前检查；回到订阅层后再次取当前值以保留用户修改。
    const batch = await this.sourceService.fetchArticleBatch(feed, fetchedAt, () => { this.requireCurrentSource(feed, accountId) })
    const current = this.requireCurrentSource(feed, accountId)

    const parsed = batch.articles
    const candidates = parsed
      .map((item) => toWebsiteArticleRecord(feed.id, item, { now: fetchedAt, accountId: feed.accountId }))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), feed.accountId)
    const insertedArticles = articles.length - existingIds.size
    // 自动与非范围规则不查询历史正文；收藏保护仍由规则和删除 SQL 双重保留。
    const obsolete = batch.cleanupRule
      ? new ConfigurableWebsiteParser(batch.cleanupRule).findObsoleteArticleIds(
        this.repository.listArticleCleanupMetadata(accountId, feed.id), parsed)
      : []
    this.repository.upsertWebsiteFeedWithArticles({ ...current, updatedAt: fetchedAt }, articles, obsolete)

    return { feedId, fetchedArticles: articles.length, insertedArticles, deletedArticles: obsolete.length }
  }

  /** 网络期间允许修改普通偏好；删除来源或改变地址、类型及解析方式时拒绝旧响应。 */
  private requireCurrentSource(before: FeedRecord, accountId: number): FeedRecord {
    const current = this.repository.getFeedByIdForAccount(accountId, before.id)
    if (!current) throw new Error('来源已删除，已忽略本次刷新结果')
    if (current.url !== before.url || current.sourceType !== before.sourceType
      || current.sourcePageUrl !== before.sourcePageUrl || current.dynamicRendering !== before.dynamicRendering) {
      throw new Error('来源地址或解析方式已变化，请重新刷新')
    }
    return current
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
