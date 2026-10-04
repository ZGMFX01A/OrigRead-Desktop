import { DESKTOP_BROWSER_USER_AGENT } from '../network/user-agent-policy'
import { decodeHttpText } from '../network/http-text-decoder'
import type { FullContentFetchResult, FullContentFailureReason } from '../../shared/reader'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { LibraryRepository } from '../database/library-repository'
import { ContentExtractionService } from './content-extraction-service'
import { DynamicArticleContentService } from './dynamic-article-content-service'
import {
  classifyFullContentHtml,
  classifyFullContentHttpStatus,
  FullContentError
} from './full-content-failure'
import { renderArticleContent } from './reader-content-service'

// 沿用全文请求的网络等待时间和静态页面解析规模。
const REQUEST_TIMEOUT_MS = 15_000
const MAX_STATIC_HTML_CHARS = 2_000_000

interface ContentRequest {
  article: ArticleRecord
  feed: FeedRecord
}

export interface ArticlePagePayload {
  status: number
  finalUrl: string
  html: string
}

export type ArticlePageFetcher = (url: string) => Promise<ArticlePagePayload>

/** 对齐 Android ReaderCacheHelper + RssHelper.parseFullContent；Desktop 使用 articles.full_content_html 作为持久缓存。 */
export class ArticleFullContentService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly extractionService: ContentExtractionService,
    private readonly dynamicService: DynamicArticleContentService,
    private readonly fetcher: ArticlePageFetcher = defaultArticlePageFetcher
  ) {}

  /** 网络开始前固定文章和账户，缓存读取故障与网络故障分别报告。 */
  async readOrFetch(articleId: string, allowDynamicFallback = true): Promise<FullContentFetchResult> {
    let article: ArticleRecord | null
    try {
      article = this.repository.getArticleById(articleId)
    } catch (error) {
      // SQLite 读取失败不能伪装成缓存缺失并继续请求远端。
      if (!isSqliteFailure(error)) throw error
      console.error('全文缓存读取失败', error)
      return this.failure('CACHE_STORAGE')
    }
    if (!article) throw new Error(`文章不存在：${articleId}`)
    const feed = this.repository.getFeedByIdForAccount(article.accountId!, article.feedId)
    if (!feed) return this.failure('ARTICLE_UNAVAILABLE')
    const request = { article, feed }
    if (article.fullContentHtml?.trim()) return this.success(request)
    if (!article.url || !isHttpUrl(article.url)) return this.failure('INVALID_URL')
    return this.fetchContent(request, allowDynamicFallback)
  }

  /** 静态和动态提取共用入口快照，异步返回后只写该文章所属账户。 */
  private async fetchContent(request: ContentRequest, allowDynamicFallback: boolean): Promise<FullContentFetchResult> {
    const { article } = request
    let payload: ArticlePagePayload
    try {
      payload = await this.fetcher(article.url!)
    } catch (error) {
      // 已知全文错误保留分类，其余抓取异常进入网络失败出口。
      if (error instanceof FullContentError) return this.failure(error.reason)
      return this.failure('NETWORK')
    }

    let failureReason: FullContentFailureReason
    if (payload.status >= 200 && payload.status < 300) {
      const extracted = this.extractionService.extract(payload.html, payload.finalUrl, article.title)
      if (extracted) return this.cacheAndReturn(request, extracted.html)
      failureReason = classifyFullContentHtml(payload.html)
    } else {
      failureReason = classifyFullContentHttpStatus(payload.status)
    }

    if (allowDynamicFallback) {
      const dynamic = await this.dynamicService.extract({
        url: article.url!,
        expectedTitle: article.title,
        staticHtml: payload.html,
        staticFailureReason: failureReason,
        allowRestrictedFallback: failureReason === 'ACCESS_RESTRICTED'
      })
      if (dynamic) return this.cacheAndReturn(request, dynamic.html)
    }
    return this.failure(failureReason)
  }

  /** 仅缓存写入失败允许继续阅读，并显式携带保存错误；删除后的文章仍明确失败。 */
  private cacheAndReturn(request: ContentRequest, html: string): FullContentFetchResult {
    try {
      const changed = this.repository.setArticleFullContentForAccount(request.article.accountId!, request.article.id, html)
      if (changed !== 1) return this.failure('ARTICLE_UNAVAILABLE')
    } catch (error) {
      // 提取已经成功，SQLite 故障单独报告，不丢弃可读正文或掩盖其它编程异常。
      if (!isSqliteFailure(error)) throw error
      console.warn('全文未能保存离线缓存', error)
      return { ...this.success(request, html), cacheWriteError: error.message }
    }
    return this.success(request, html)
  }

  /** 直接消费已捕获正文，避免写入后切账户导致第二次读取失败。 */
  private success(request: ContentRequest, html = request.article.fullContentHtml): FullContentFetchResult {
    return {
      ok: true,
      content: renderArticleContent({ ...request.article, fullContentHtml: html }, request.feed),
      failureReason: null
    }
  }

  private failure(reason: FullContentFailureReason): FullContentFetchResult {
    return { ok: false, content: null, failureReason: reason }
  }
}

export async function defaultArticlePageFetcher(url: string): Promise<ArticlePagePayload> {
  if (!isHttpUrl(url)) throw new FullContentError('INVALID_URL', '全文地址必须是 HTTP(S) URL')
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'user-agent': DESKTOP_BROWSER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    }
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const html = decodeHttpText(bytes, response.headers.get('content-type'), 'html').slice(0, MAX_STATIC_HTML_CHARS)
  return { status: response.status, finalUrl: response.url || url, html }
}

function isHttpUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) }
  catch { return false }
}

/** Node SQLite 使用独立错误代码；网络和提取异常不进入离线存储失败分支。 */
function isSqliteFailure(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_SQLITE')
}
