import type { OrigReadDesktopApi } from '../../shared/contracts'
import type { FullContentFailureReason, FullContentFetchResult, ReaderArticleContent } from '../../shared/reader'

export interface ReaderSelection {
  readonly articleId: string | null
  readonly accountId: number | null
}

interface ReaderRequest extends ReaderSelection {
  readonly revision: number
}

/** 请求身份同时包含文章、账户及代次，同一文章重复加载也会废弃旧结果。 */
export function createReaderContentRequestScope() {
  let selection: ReaderSelection = { articleId: null, accountId: null }
  let revision = 0
  return {
    select(next: ReaderSelection): void {
      if (next.articleId === selection.articleId && next.accountId === selection.accountId) return
      selection = { ...next }
      revision += 1
    },
    invalidate(): void { revision += 1 },
    begin(): ReaderRequest { revision += 1; return { ...selection, revision } },
    isCurrent(request: ReaderRequest): boolean {
      return request.revision === revision && request.articleId === selection.articleId && request.accountId === selection.accountId
    }
  }
}

export interface ReaderContentPublisher {
  readonly setContent: (content: ReaderArticleContent | null) => void
  readonly setLoading: (loading: boolean) => void
  readonly setError: (error: string | null) => void
  readonly setCacheWriteError: (error: string | null) => void
  readonly failureMessage: (reason: FullContentFailureReason) => string
  readonly onContentChanged: () => void
}


type RequestScope = ReturnType<typeof createReaderContentRequestScope>
type ContentApi = Pick<OrigReadDesktopApi, 'getReaderContent' | 'fetchFullContent'>

/** 所有读取入口共用身份校验，延迟返回只允许更新仍有效的文章和账户。 */
export class ReaderContentRequests {
  constructor(private readonly scope: RequestScope, private readonly api: ContentApi, private readonly publisher: ReaderContentPublisher) {}

  invalidate(): void { this.scope.invalidate() }

  /** 初始读取先消费已有正文，来源要求全文时再运行真实抓取。 */
  loadInitial(requiresFullContent: boolean): Promise<void> {
    return this.execute(async (request) => {
      const content = await this.api.getReaderContent(request.articleId!)
      if (!this.scope.isCurrent(request)) return
      this.publisher.onContentChanged()
      this.publisher.setContent(content)
      if (requiresFullContent && content.mode !== 'full') {
        this.publishFullContent(request, await this.api.fetchFullContent(request.articleId!))
      }
    })
  }

  /** 用户重新取全文与初始读取互相废弃，不能串用旧错误或 loading。 */
  fetchFullContent(): Promise<void> {
    return this.execute(async (request) => {
      this.publishFullContent(request, await this.api.fetchFullContent(request.articleId!))
    })
  }

  /** 切回来源正文使先前全文请求失效，保留已持久化全文供下次读取。 */
  showFeedContent(): Promise<void> {
    return this.execute(async (request) => {
      const content = await this.api.getReaderContent(request.articleId!, false)
      if (!this.scope.isCurrent(request)) return
      this.publisher.onContentChanged()
      this.publisher.setContent(content)
    })
  }

  /** 正文和离线保存状态分别发布，仅本地存储写入失败仍可阅读。 */
  private publishFullContent(request: ReaderRequest, result: FullContentFetchResult): void {
    if (!this.scope.isCurrent(request)) return
    if (!result.ok || !result.content) {
      this.publisher.setError(this.publisher.failureMessage(result.failureReason ?? 'UNKNOWN'))
      return
    }
    this.publisher.onContentChanged()
    this.publisher.setContent(result.content)
    this.publisher.setCacheWriteError(result.cacheWriteError ?? null)
  }

  /** IPC 错误按真实原因展示，过期请求不能发布正文、错误或结束新任务的 loading。 */
  private async execute(operation: (request: ReaderRequest) => Promise<void>): Promise<void> {
    const request = this.scope.begin()
    if (!request.articleId) return
    this.publisher.setLoading(true)
    this.publisher.setError(null)
    this.publisher.setCacheWriteError(null)
    try { await operation(request) }
    catch (error) {
      // 导航、换账户和卸载后只废弃状态发布，当前 IPC 异常完整交回界面。
      if (this.scope.isCurrent(request)) this.publisher.setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (this.scope.isCurrent(request)) this.publisher.setLoading(false)
    }
  }
}
