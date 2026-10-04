import type { ReaderArticleContent, ReaderContentMode } from '../../shared/reader'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { LibraryRepository } from '../database/library-repository'
import { annotateArticleEvidenceHtml } from '../llm/evidence-block-builder'
import { sanitizeContentHtml } from './content-html-sanitizer'
import { shouldUseEmbeddedRssAsFullContent } from './embedded-rss-content-policy'

/** 读取数据库中已经拥有的正文；远程全文提取由下一阶段单独负责。 */
export class ReaderContentService {
  constructor(private readonly repository: LibraryRepository) {}

  get(articleId: string, preferFull = true): ReaderArticleContent {
    const article = this.repository.getArticleById(articleId)
    if (!article) throw new Error(`文章不存在：${articleId}`)
    const feed = this.repository.getFeedById(article.feedId)
    if (!feed) throw new Error(`文章来源不存在：${article.feedId}`)

    return renderArticleContent(article, feed, preferFull)
  }
}

/** 使用同一文章和来源快照清洗正文，缓存失败时也不需要重新读取当前账户。 */
export function renderArticleContent(article: ArticleRecord, feed: FeedRecord, preferFull = true): ReaderArticleContent {
  const sourceUrl = article.url ?? feed.url
  const embeddedRssFullContent = feed.sourceType === 'rss' && article.url && article.contentHtml
    ? shouldUseEmbeddedRssAsFullContent(article.url, article.contentHtml)
    : false
  const { mode, html } = selectStoredContent(article, { embeddedRssFullContent, preferFull })
  return {
    articleId: article.id,
    mode,
    html: annotateArticleEvidenceHtml(sanitizeContentHtml(html, sourceUrl), { articleId: article.id, sourceUrl: article.url }),
    sourceUrl: article.url
  }
}

/** 全文优先级仍沿用来源策略，切回摘要时明确忽略已保存的全文。 */
function selectStoredContent(
  article: ArticleRecord,
  options: { embeddedRssFullContent: boolean; preferFull: boolean }
): { mode: ReaderContentMode; html: string } {
  const { fullContentHtml, contentHtml, description } = article
  const { embeddedRssFullContent, preferFull } = options
  if (preferFull && fullContentHtml?.trim()) return { mode: 'full', html: fullContentHtml }
  if (preferFull && embeddedRssFullContent && contentHtml?.trim()) return { mode: 'full', html: contentHtml }
  if (contentHtml?.trim()) return { mode: 'content', html: contentHtml }
  return {
    mode: 'description',
    html: description.trim() ? `<p>${escapeHtml(description)}</p>` : ''
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

