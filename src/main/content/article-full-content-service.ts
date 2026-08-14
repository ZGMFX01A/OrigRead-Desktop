import type { FullContentFetchResult, FullContentFailureReason } from '../../shared/reader'
import { LibraryRepository } from '../database/library-repository'
import { ContentExtractionService } from './content-extraction-service'
import { DynamicArticleContentService } from './dynamic-article-content-service'
import {
  classifyFullContentHtml,
  classifyFullContentHttpStatus,
  FullContentError
} from './full-content-failure'
import { ReaderContentService } from './reader-content-service'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_STATIC_HTML_CHARS = 2_000_000

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

  async readOrFetch(articleId: string, allowDynamicFallback = true): Promise<FullContentFetchResult> {
    const article = this.repository.getArticleById(articleId)
    if (!article) throw new Error(`文章不存在：${articleId}`)
    if (article.fullContentHtml?.trim()) return this.success(articleId)
    if (!article.url || !isHttpUrl(article.url)) return this.failure('INVALID_URL')

    let payload: ArticlePagePayload
    try {
      payload = await this.fetcher(article.url)
    } catch (error) {
      if (error instanceof FullContentError) return this.failure(error.reason)
      return this.failure('NETWORK')
    }

    let failureReason: FullContentFailureReason
    if (payload.status >= 200 && payload.status < 300) {
      const extracted = this.extractionService.extract(payload.html, payload.finalUrl, article.title)
      if (extracted) return this.cacheAndReturn(articleId, extracted.html)
      failureReason = classifyFullContentHtml(payload.html)
    } else {
      failureReason = classifyFullContentHttpStatus(payload.status)
    }

    if (allowDynamicFallback) {
      const dynamic = await this.dynamicService.extract({
        url: article.url,
        expectedTitle: article.title,
        staticHtml: payload.html,
        staticFailureReason: failureReason,
        allowRestrictedFallback: failureReason === 'ACCESS_RESTRICTED'
      })
      if (dynamic) return this.cacheAndReturn(articleId, dynamic.html)
    }
    return this.failure(failureReason)
  }

  private cacheAndReturn(articleId: string, html: string): FullContentFetchResult {
    this.repository.setArticleFullContent(articleId, html)
    return this.success(articleId)
  }

  private success(articleId: string): FullContentFetchResult {
    return {
      ok: true,
      content: new ReaderContentService(this.repository).get(articleId),
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
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    }
  })
  const html = (await response.text()).slice(0, MAX_STATIC_HTML_CHARS)
  return { status: response.status, finalUrl: response.url || url, html }
}

function isHttpUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) }
  catch { return false }
}
