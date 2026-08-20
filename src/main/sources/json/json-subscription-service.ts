import { createHash, randomUUID } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { JsonParsedArticle, JsonSourceProbeResult } from '../../../shared/json-source'
import { LibraryRepository } from '../../database/library-repository'
import { JsonSourceService } from './json-source-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'

export class JsonSubscriptionService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly sourceService: JsonSourceService,
    private readonly articleFilters?: ArticleFilterRepository
  ) {}

  /** 保存探测阶段确认的 endpoint，并直接落库探测阶段已经解析出的首批文章。 */
  async add(probe: JsonSourceProbeResult): Promise<{ feedId: string; insertedArticles: number }> {
    const existing = this.repository.findFeedByUrl(probe.endpointUrl)
    if (existing) throw new Error(`来源已存在：${existing.name}`)

    const now = Date.now()
    const feedId = randomUUID()
    const accountId = this.repository.getCurrentAccountId()
    const feed: FeedRecord = {
      id: feedId,
      accountId,
      groupId: this.repository.getCurrentDefaultGroup().id,
      name: probe.title,
      url: probe.endpointUrl,
      sourcePageUrl: probe.sourcePageUrl,
      sourceType: 'json',
      icon: null,
      isNotification: false,
      isFullContent: false,
      isBrowser: false,
      dynamicRendering: false,
      createdAt: now,
      updatedAt: now
    }
    // 探测阶段已经完成一次真实网络请求并拿到了可用文章。
    // 首次订阅必须直接复用这批已确认数据，不能先写空 Feed 再对同一 API 发第二次请求：
    // 第二次请求一旦超时/限流，就会留下“预览 30 篇、订阅后 0 篇”的空来源。
    const candidates = probe.articles
      .map((article) => toArticleRecord(feed.id, article, now, feed.accountId))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    this.repository.upsertFeedWithArticles(feed, articles)
    return { feedId, insertedArticles: articles.length }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }> {
    const feed = this.repository.getFeedById(feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'json') throw new Error(`来源不是 JSON/API：${feed.name}`)

    const parsed = await this.sourceService.fetch(feed, fetchedAt)
    const candidates = parsed
      .map((article) => toArticleRecord(feed.id, article, fetchedAt, feed.accountId))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), feed.accountId)
    const insertedArticles = articles.length - existingIds.size
    this.repository.upsertFeedWithArticles({ ...feed, updatedAt: fetchedAt }, articles)
    return { feedId, fetchedArticles: articles.length, insertedArticles }
  }
}

function toArticleRecord(feedId: string, item: JsonParsedArticle, now: number, accountId?: number): ArticleRecord {
  return {
    id: `json-${createHash('sha256').update(feedId).update('\u0000').update(item.stableId).digest('hex')}`,
    accountId,
    feedId,
    title: item.title,
    url: item.link,
    author: item.author,
    publishedAt: item.publishedAt,
    description: htmlToText(item.descriptionHtml).slice(0, 280),
    contentHtml: item.contentHtml || item.descriptionHtml || null,
    fullContentHtml: null,
    imageUrl: item.imageUrl,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

function htmlToText(html: string): string {
  if (!html) return ''
  return cheerio.load(`<body>${html}</body>`)('body').text().replace(/\s+/g, ' ').trim()
}
