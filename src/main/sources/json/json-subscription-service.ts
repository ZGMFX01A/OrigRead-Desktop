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

  /** Android subscribeJson：保存探测阶段确认的 endpoint，随后立即执行一次同规则同步。 */
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
    this.repository.upsertFeed(feed)
    const refresh = await this.refresh(feedId)
    return { feedId, insertedArticles: refresh.insertedArticles }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }> {
    const feed = this.repository.getFeedById(feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'json') throw new Error(`来源不是 JSON/API：${feed.name}`)

    const parsed = await this.sourceService.fetch(feed, fetchedAt)
    const candidateArticles = parsed
      .map((article) => toArticleRecord(feed.id, article, fetchedAt, feed.accountId))
      .filter((article) => !this.repository.isArchivedLink(feed.id, article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const insertedArticles = articles.reduce(
      (count, article) => count + (this.repository.hasArticle(article.id) ? 0 : 1),
      0
    )
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
    contentHtml: item.descriptionHtml || null,
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
