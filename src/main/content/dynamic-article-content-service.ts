import type { FullContentFailureReason } from '../../shared/reader'
import type { DynamicWebsiteRenderer } from '../sources/website/dynamic-website-render-policy'
import { ContentExtractionService } from './content-extraction-service'
import type { ExtractedContent } from './content-extraction-types'
import { classifyFullContentHtml, shouldAttemptDynamicArticleContent } from './full-content-failure'

const TOTAL_FALLBACK_TIMEOUT_MS = 18_000

/** Android DynamicArticleContentService 对应实现：全局一次只允许一个隐藏 Chromium 正文任务。 */
export class DynamicArticleContentService {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly renderer: DynamicWebsiteRenderer,
    private readonly extractionService: ContentExtractionService
  ) {}

  async extract(input: {
    url: string
    expectedTitle: string | null
    staticHtml: string
    staticFailureReason: FullContentFailureReason
    allowRestrictedFallback?: boolean
  }): Promise<ExtractedContent | null> {
    if (!shouldAttemptDynamicArticleContent(
      input.staticHtml,
      input.staticFailureReason,
      true,
      input.allowRestrictedFallback ?? false
    )) return null

    const operation = this.queue.then(() => withTimeout(this.renderAndExtract(input), TOTAL_FALLBACK_TIMEOUT_MS))
    this.queue = operation.then(() => undefined, () => undefined)
    try { return await operation } catch { return null }
  }

  private async renderAndExtract(input: {
    url: string
    expectedTitle: string | null
  }): Promise<ExtractedContent | null> {
    const rendered = await this.renderer.render(input.url)
    if (classifyFullContentHtml(rendered.html) === 'ACCESS_RESTRICTED') return null
    return this.extractionService.extract(rendered.html, rendered.finalUrl, input.expectedTitle)
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try { return await Promise.race([operation, timeout]) }
  finally { if (timer) clearTimeout(timer) }
}
