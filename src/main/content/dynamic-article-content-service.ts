import type { FullContentFailureReason } from '../../shared/reader'
import type { DynamicWebsiteRenderer } from '../sources/website/dynamic-website-render-policy'
import { ContentExtractionService } from './content-extraction-service'
import type { ExtractedContent } from './content-extraction-types'
import { classifyFullContentHtml, shouldAttemptDynamicArticleContent } from './full-content-failure'

const TOTAL_FALLBACK_TIMEOUT_MS = 18_000
const MAX_FALLBACK_QUEUE_SIZE = 8

interface FallbackTask {
  url: string
  signal: AbortSignal
  run: () => Promise<ExtractedContent | null>
  resolve: (value: ExtractedContent | null) => void
}

/**
 * 隐藏 Chromium 正文动态兜底。
 * 提供有界队列（上限 8）、单并发调度与立即取消行为；
 * 外部取消信号与 18s 总超时在入队时立即生效，排队被取消或超时时立即结算，不得等到队首再启动窗口。
 */
export class DynamicArticleContentService {
  private activeCount = 0
  private queue: FallbackTask[] = []

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
    signal?: AbortSignal
  }): Promise<ExtractedContent | null> {
    if (!shouldAttemptDynamicArticleContent(
      input.staticHtml,
      input.staticFailureReason,
      true,
      input.allowRestrictedFallback ?? false
    )) return null

    if (input.signal?.aborted) return null
    if (this.queue.length >= MAX_FALLBACK_QUEUE_SIZE) return null

    return new Promise<ExtractedContent | null>((resolve) => {
      let task: FallbackTask
      const controller = new AbortController()

      const onAbort = (): void => {
        controller.abort(input.signal?.reason)
        const index = this.queue.indexOf(task)
        if (index !== -1) {
          this.queue.splice(index, 1)
          cleanup()
          resolve(null)
        }
      }

      if (input.signal) {
        input.signal.addEventListener('abort', onAbort, { once: true })
      }

      const timer = setTimeout(() => {
        controller.abort(new DOMException('动态正文提取总超时', 'TimeoutError'))
        const index = this.queue.indexOf(task)
        if (index !== -1) {
          this.queue.splice(index, 1)
          cleanup()
          resolve(null)
        }
      }, TOTAL_FALLBACK_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timer)
        if (input.signal) {
          input.signal.removeEventListener('abort', onAbort)
        }
      }

      task = {
        url: input.url,
        signal: controller.signal,
        run: async (): Promise<ExtractedContent | null> => {
          if (controller.signal.aborted || input.signal?.aborted) return null
          try {
            const rendered = await this.renderer.render(input.url, controller.signal)
            if (controller.signal.aborted || input.signal?.aborted) return null
            if (classifyFullContentHtml(rendered.html) === 'ACCESS_RESTRICTED') return null
            return this.extractionService.extract(rendered.html, rendered.finalUrl, input.expectedTitle)
          } catch {
            return null
          }
        },
        resolve: (value: ExtractedContent | null): void => {
          cleanup()
          resolve(value)
        }
      }

      this.queue.push(task)
      this.processNext()
    })
  }

  private processNext(): void {
    if (this.activeCount >= 1 || this.queue.length === 0) return
    const task = this.queue.shift()!
    if (task.signal.aborted) {
      task.resolve(null)
      this.processNext()
      return
    }
    this.activeCount += 1
    task.run()
      .then(task.resolve, () => task.resolve(null))
      .finally(() => {
        this.activeCount -= 1
        this.processNext()
      })
  }
}
