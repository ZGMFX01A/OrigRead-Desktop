import { createHash, randomUUID } from 'node:crypto'
import * as cheerio from 'cheerio'
import type { ArticleRecord, FeedRecord } from '../../../shared/library'
import type { JsonParsedArticle, JsonSourceProbeResult, JsonRule } from '../../../shared/json-source'
import { LibraryRepository } from '../../database/library-repository'
import { JsonSourceService } from './json-source-service'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'
import { SourceOperationQueue } from '../source-operation-queue'

export class JsonSubscriptionService {
  private readonly operations = new SourceOperationQueue()
  constructor(
    private readonly repository: LibraryRepository,
    private readonly sourceService: JsonSourceService,
    private readonly articleFilters?: ArticleFilterRepository
  ) {}

  /** 保存探测阶段确认的 endpoint，并直接落库探测阶段已经解析出的首批文章。 */
  async add(probe: JsonSourceProbeResult): Promise<{ feedId: string; insertedArticles: number }> {
    const existing = this.repository.findFeedByUrl(probe.endpointUrl)
    if (existing) return { feedId: existing.id, insertedArticles: 0 }

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
      .map((article) => toArticleRecord(feed.id, article, { now, accountId: feed.accountId }))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    this.repository.upsertFeedWithArticles(feed, articles, { jsonRule: probe.rule })
    return { feedId, insertedArticles: articles.length }
  }

  async refresh(
    feedId: string,
    fetchedAt = Date.now(),
    accountId = this.repository.getCurrentAccountId()
  ): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }> {
    return this.operations.run(feedId, () => this.refreshResolved({ feedId, fetchedAt, accountId }))
  }

  /** 与重绑共用来源队列，旧网络回包不会重新发布已替换的规则或接口地址。 */
  private async refreshResolved(input: { feedId: string; fetchedAt: number; accountId: number }): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }> {
    const { feedId, fetchedAt, accountId } = input
    const feed = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!feed) throw new Error(`来源不存在：${feedId}`)
    if (feed.sourceType !== 'json') throw new Error(`来源不是 JSON/API：${feed.name}`)

    const batch = await this.sourceService.fetchResolved(feed, fetchedAt, this.repository.getJsonFeedRule(feedId))
    const parsed = batch.articles
    const candidates = parsed
      .map((article) => toArticleRecord(feed.id, article, { now: fetchedAt, accountId: feed.accountId }))
    const archivedLinks = this.repository.archivedLinks(feed.id, candidates.map((article) => article.url))
    const candidateArticles = candidates.filter((article) => !article.url || !archivedLinks.has(article.url))
    const articles = this.articleFilters?.filterArticles(feed.id, candidateArticles).kept ?? candidateArticles
    const existingIds = this.repository.existingArticleIds(articles.map((article) => article.id), feed.accountId)
    const insertedArticles = articles.length - existingIds.size
    const current = this.repository.getFeedByIdForAccount(accountId, feedId)
    if (!current) throw new Error(`来源已不存在：${feedId}`)
    this.repository.upsertFeedWithArticles({ ...current, updatedAt: fetchedAt }, articles, { jsonRule: batch.rule })
    return { feedId, fetchedArticles: articles.length, insertedArticles }
  }

  /** 确认只替换原来源的地址和规则；文章、阅读状态、收藏及引用身份全部保留。 */
  replaceBinding(input: { base: FeedRecord; expectedRule: JsonRule | null; probe: JsonSourceProbeResult; signal: AbortSignal }): Promise<FeedRecord> {
    return this.operations.run(input.base.id, async () => {
      input.signal.throwIfAborted()
      if (this.repository.getCurrentAccountId() !== input.base.accountId) throw new Error('账户已切换，请重新探测来源')
      const current = this.repository.getFeedByIdForAccount(input.base.accountId!, input.base.id)
      if (!current || current.sourceType !== 'json') throw new Error('JSON 来源已不存在')
      const currentRule = this.repository.getJsonFeedRule(current.id)
      if (current.url !== input.base.url || JSON.stringify(currentRule) !== JSON.stringify(input.expectedRule)) {
        throw new Error('JSON 来源绑定已变化，请重新探测并确认')
      }
      const updated = { ...current, url: input.probe.endpointUrl, sourcePageUrl: input.probe.sourcePageUrl, updatedAt: Date.now() }
      this.repository.upsertFeedWithArticles(updated, [], { jsonRule: input.probe.rule })
      return updated
    })
  }
}

/** 文章身份绑定 Feed，内容更新交给保留本地阅读状态的 UPSERT。 */
function toArticleRecord(feedId: string, item: JsonParsedArticle, options: { now: number; accountId?: number }): ArticleRecord {
  const { now, accountId } = options
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
