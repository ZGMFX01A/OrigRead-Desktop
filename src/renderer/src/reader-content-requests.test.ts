import { describe, expect, it, vi } from 'vitest'
import {
  createReaderContentRequestScope,
  ReaderContentRequests,
  type ContentApi,
  type ReaderContentPublisher
} from './reader-content-requests'
import type { ReaderArticleContent } from '../../shared/reader'

function createPublisher(): ReaderContentPublisher {
  return {
    setContent: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setCacheWriteError: vi.fn(),
    failureMessage: (reason) => `Error: ${reason}`,
    onContentChanged: vi.fn()
  }
}

describe('ReaderContentRequests', () => {
  it('cancels ongoing in-flight fetchFullContent when switching to feed content', async () => {
    let cancelCalledWith: { articleId: string; requestId: string } | null = null
    let resolveFullContent: (res: any) => void = () => {}

    const api: ContentApi = {
      getReaderContent: vi.fn().mockResolvedValue({ articleId: 'art-1', mode: 'feed', text: 'Feed text' } as unknown as ReaderArticleContent),
      fetchFullContent: vi.fn().mockImplementation((articleId, requestId) => {
        return new Promise((resolve) => {
          resolveFullContent = resolve
        })
      }),
      cancelFullContent: vi.fn().mockImplementation(async (articleId, requestId) => {
        cancelCalledWith = { articleId, requestId }
      })
    }

    const scope = createReaderContentRequestScope()
    scope.select({ articleId: 'art-1', accountId: 1 })
    const publisher = createPublisher()
    const requests = new ReaderContentRequests(scope, api, publisher)

    // 发起需要全文的初始加载
    const p1 = requests.loadInitial(true)
    await Promise.resolve()
    expect(api.fetchFullContent).toHaveBeenCalled()

    // 用户切回来源正文
    await requests.showFeedContent()

    // 验证调用了 cancelFullContent
    expect(cancelCalledWith).not.toBeNull()
    expect((cancelCalledWith as any)?.articleId).toBe('art-1')

    // 迟到返回的结果不能覆盖界面
    resolveFullContent({ ok: true, content: { mode: 'full', text: 'Late full' } })
    await p1

    expect(publisher.setContent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'feed' }))
    expect(publisher.setContent).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'Late full' }))
  })

  it('cancels in-flight full content request on invalidate with request-id contract', async () => {
    let cancelledId = ''
    let cancelledReqId = ''

    const api: ContentApi = {
      getReaderContent: vi.fn().mockResolvedValue({ articleId: 'art-1', mode: 'feed' } as unknown as ReaderArticleContent),
      fetchFullContent: vi.fn().mockImplementation(() => new Promise(() => {})),
      cancelFullContent: vi.fn().mockImplementation(async (articleId, requestId) => {
        cancelledId = articleId
        cancelledReqId = requestId
      })
    }

    const scope = createReaderContentRequestScope()
    scope.select({ articleId: 'art-1', accountId: 1 })
    const publisher = createPublisher()
    const requests = new ReaderContentRequests(scope, api, publisher)

    void requests.fetchFullContent()
    await Promise.resolve()

    requests.invalidate()
    expect(cancelledId).toBe('art-1')
    expect(cancelledReqId).toContain('art-1-1-')
  })

  it('handles A -> B -> A sequence without stale cancel affecting new request', async () => {
    const cancelled: string[] = []
    let hangA: (val?: any) => void = () => {}
    const api: ContentApi = {
      getReaderContent: vi.fn().mockResolvedValue({ mode: 'feed' } as unknown as ReaderArticleContent),
      fetchFullContent: vi.fn().mockImplementation((articleId) => {
        if (articleId === 'A' && cancelled.length === 0) {
          return new Promise((resolve) => { hangA = resolve })
        }
        return Promise.resolve({ ok: true, content: { mode: 'full' } })
      }),
      cancelFullContent: vi.fn().mockImplementation(async (articleId, requestId) => {
        cancelled.push(`${articleId}:${requestId}`)
      })
    }

    const scope = createReaderContentRequestScope()
    const publisher = createPublisher()
    const requests = new ReaderContentRequests(scope, api, publisher)

    // 选 A 并取全文
    scope.select({ articleId: 'A', accountId: 1 })
    void requests.fetchFullContent()
    await Promise.resolve()

    // 切到 B
    requests.cancelActiveFetch()
    scope.select({ articleId: 'B', accountId: 1 })
    expect(cancelled.length).toBe(1)
    expect(cancelled[0]).toContain('A:A-1-')

    // 切回 A
    scope.select({ articleId: 'A', accountId: 1 })
    await requests.fetchFullContent()

    // 第二次 A 完成
    expect(publisher.setContent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'full' }))
  })
})
