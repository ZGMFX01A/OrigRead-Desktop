import type { ReaderArticleContent, ReaderContentMode } from '../../shared/reader'
import { LibraryRepository } from '../database/library-repository'
import { sanitizeContentHtml } from './content-html-sanitizer'
import { shouldUseEmbeddedRssAsFullContent } from './embedded-rss-content-policy'

/** 读取数据库中已经拥有的正文；远程全文提取由下一阶段单独负责。 */
export class ReaderContentService {
  constructor(private readonly repository: LibraryRepository) {}

  get(articleId: string): ReaderArticleContent {
    const article = this.repository.getArticleById(articleId)
    if (!article) throw new Error(`文章不存在：${articleId}`)
    const feed = this.repository.getFeedById(article.feedId)
    if (!feed) throw new Error(`文章来源不存在：${article.feedId}`)

    const sourceUrl = article.url ?? feed.url
    const embeddedRssFullContent = feed.sourceType === 'rss' && article.url && article.contentHtml
      ? shouldUseEmbeddedRssAsFullContent(article.url, article.contentHtml)
      : false
    const { mode, html } = selectStoredContent(
      article.fullContentHtml,
      article.contentHtml,
      article.description,
      embeddedRssFullContent
    )
    return {
      articleId,
      mode,
      html: sanitizeContentHtml(html, sourceUrl),
      sourceUrl: article.url
    }
  }
}

function selectStoredContent(
  fullContentHtml: string | null,
  contentHtml: string | null,
  description: string,
  embeddedRssFullContent = false
): { mode: ReaderContentMode; html: string } {
  if (fullContentHtml?.trim()) return { mode: 'full', html: fullContentHtml }
  if (embeddedRssFullContent && contentHtml?.trim()) return { mode: 'full', html: contentHtml }
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

