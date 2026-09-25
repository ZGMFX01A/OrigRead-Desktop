import type { DatabaseSync } from 'node:sqlite'
import { DESKTOP_BROWSER_USER_AGENT } from '../network/user-agent-policy'
import { decodeHttpText } from '../network/http-text-decoder'
import type { FullContentFetchResult, FullContentFailureReason } from '../../shared/reader'
import { LibraryRepository } from '../database/library-repository'
import { DesktopSyncLocalBlobStore } from '../sync/sync-local-blob-store'
import { DesktopSyncBlobStateService } from '../sync/sync-blob-state'
import { DesktopSyncLocalEvictionService } from '../sync/sync-alias-protocol'
import { SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND } from '../sync/sync-blob-payload'
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
    private readonly fetcher: ArticlePageFetcher = defaultArticlePageFetcher,
    private readonly database?: DatabaseSync,
    private readonly localBlobStore?: DesktopSyncLocalBlobStore,
  ) {}

  async readOrFetch(articleId: string, allowDynamicFallback = true): Promise<FullContentFetchResult> {
    const article = this.repository.getArticleById(articleId)
    if (!article) throw new Error(`文章不存在：${articleId}`)
    if (article.fullContentHtml?.trim()) return this.success(articleId)
    const synced = this.restoreSyncedFullContent(articleId)
    if (synced) return synced
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

  private restoreSyncedFullContent(articleId: string): FullContentFetchResult | null {
    if (!this.database || !this.localBlobStore) return null
    const accountId = this.repository.getCurrentAccountId()
    const binding = this.database.prepare(
      'SELECT sync_space_id FROM sync_local_space_binding WHERE local_account_id=? LIMIT 1'
    ).get(accountId) as { sync_space_id: string } | undefined
    if (!binding) return null
    const mapping = this.database.prepare(`
      SELECT sync_id,generation FROM sync_identity_mapping
      WHERE sync_space_id=? AND entity_type='article' AND local_id=? LIMIT 1
    `).get(binding.sync_space_id, articleId) as { sync_id: string; generation: number } | undefined
    if (!mapping) return null

    const localEviction = new DesktopSyncLocalEvictionService(this.database)
    if (localEviction.isEvicted(
      binding.sync_space_id,
      'article',
      mapping.sync_id,
      Number(mapping.generation),
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    )) return null

    const reference = this.database.prepare(`
      SELECT hash FROM sync_blob_reference
      WHERE sync_space_id=? AND replication_lane_id='ARTICLE_STATE'
        AND owner_entity_type='article' AND owner_entity_sync_id=? AND owner_entity_generation=?
        AND reference_kind=?
      ORDER BY created_at DESC LIMIT 1
    `).get(
      binding.sync_space_id,
      mapping.sync_id,
      Number(mapping.generation),
      SYNC_ARTICLE_FULL_CONTENT_REFERENCE_KIND
    ) as { hash: string } | undefined
    if (!reference) return null
    const manifest = this.database.prepare(
      'SELECT total_bytes,availability_state FROM sync_blob_manifest WHERE hash=? LIMIT 1'
    ).get(reference.hash) as { total_bytes: number; availability_state: string } | undefined
    if (!manifest) return null

    const blobState = new DesktopSyncBlobStateService(this.database)
    const bytes = this.localBlobStore.readVerified(reference.hash)
    if (bytes && bytes.byteLength === Number(manifest.total_bytes)) {
      blobState.markReadyVerified(reference.hash, bytes.byteLength)
      const html = Buffer.from(bytes).toString('utf8')
      if (html.trim()) {
        this.repository.setArticleFullContentFromSync(articleId, html)
        return this.success(articleId)
      }
    }
    if (manifest.availability_state === 'READY') blobState.markMissing(reference.hash)
    return this.failure('SYNC_PENDING')
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
