import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReaderArticleContent } from '../../shared/reader'
import { useReaderContentRequests, type ReaderContentRequestOptions } from './useReaderContentRequests'
import type { ReaderContentRequests } from './reader-content-requests'

const roots = new Set<Root>()

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount())
  roots.clear()
  vi.unstubAllGlobals()
})

function setupDom() {
  const window = parseHTML('<html><body><div id="root"></div></body></html>')
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = window.document.getElementById('root')!
  const root = createRoot(container)
  roots.add(root)
  return { root, container }
}

describe('useReaderContentRequests hook lifecycle', () => {
  it('persists active fetch across ordinary re-renders, cancels on switch to B, and prevents A->B->A race cancellation', async () => {
    const cancelled: Array<{ articleId: string; requestId?: string }> = []
    let resolveFullContentA1: (res: any) => void = () => {}

    const api = {
      getReaderContent: vi.fn().mockImplementation((id: string) => {
        return Promise.resolve({
          articleId: id,
          mode: 'feed',
          text: `Feed content of ${id}`
        } as unknown as ReaderArticleContent)
      }),
      fetchFullContent: vi.fn().mockImplementation((id: string, requestId?: string) => {
        if (id === 'A' && cancelled.length === 0) {
          return new Promise((resolve) => {
            resolveFullContentA1 = resolve
          })
        }
        return Promise.resolve({
          ok: true,
          content: { articleId: id, mode: 'full', text: `Full content of ${id} (req: ${requestId})` }
        })
      }),
      cancelFullContent: vi.fn().mockImplementation(async (id: string, requestId?: string) => {
        cancelled.push({ articleId: id, requestId })
      })
    }

    let currentRequests: ReaderContentRequests | null = null
    let triggerRerender: () => void = () => {}

    function TestHarness({
      articleId,
      accountId = 1
    }: {
      articleId: string | null
      accountId?: number | null
    }) {
      const [tick, setTick] = useState(0)
      triggerRerender = () => setTick((v) => v + 1)

      const requests = useReaderContentRequests({
        articleId,
        accountId,
        api,
        setContent: vi.fn(),
        setLoading: vi.fn(),
        setError: vi.fn(),
        setCacheWriteError: vi.fn(),
        failureMessage: (r) => `Failure: ${r}`,
        onContentChanged: vi.fn()
      })

      currentRequests = requests
      return <div data-testid="status">{articleId}-{tick}</div>
    }

    const { root } = setupDom()

    // 1. 挂载文章 A
    await act(async () => {
      root.render(<TestHarness articleId="A" accountId={1} />)
    })

    const requestsInstance1 = currentRequests!
    expect(requestsInstance1).not.toBeNull()

    // 2. 发起全文加载（初始返回 feed，因此进入 fetchFullContent）
    let loadPromiseA1: Promise<void>
    await act(async () => {
      loadPromiseA1 = requestsInstance1.loadInitial(true)
    })

    expect(api.fetchFullContent).toHaveBeenCalledWith('A', expect.stringContaining('A-1-'))
    const initialRequestId = (api.fetchFullContent.mock.calls[0] as [string, string])[1]

    // 3. 在请求进行中触发普通 rerender（例如组件内 state 发生变化）
    await act(async () => {
      triggerRerender()
    })

    // 验证实例引用稳定且未触发过早的取消 IPC
    expect(currentRequests).toBe(requestsInstance1)
    expect(cancelled).toEqual([])

    // 4. 切换到无需全文的文章 B
    await act(async () => {
      root.render(<TestHarness articleId="B" accountId={1} />)
    })

    // 验证：A 的未完成请求被准确发送 cancel，带有明确的 articleId 与 requestId
    expect(cancelled.length).toBe(1)
    expect(cancelled[0]?.articleId).toBe('A')
    expect(cancelled[0]?.requestId).toBe(initialRequestId)

    // B 的初始加载（无需全文，直接显示 feed 模式）
    await act(async () => {
      await currentRequests!.loadInitial(false)
    })
    expect(api.getReaderContent).toHaveBeenLastCalledWith('B', undefined)

    // 5. 快速切回文章 A（A -> B -> A 序列）
    await act(async () => {
      root.render(<TestHarness articleId="A" accountId={1} />)
    })

    let loadPromiseA2: Promise<void>
    await act(async () => {
      loadPromiseA2 = currentRequests!.loadInitial(true)
    })

    // 验证：第二次发起 A 时生成了新的 requestId（不等于 initialRequestId）
    const secondCall = api.fetchFullContent.mock.calls[1] as [string, string]
    expect(secondCall[0]).toBe('A')
    const secondRequestId = secondCall[1]
    expect(secondRequestId).not.toBe(initialRequestId)

    // 此时即使 A-1 延迟 resolve，也不会污染新的 A-2 请求
    resolveFullContentA1({
      ok: true,
      content: { articleId: 'A', mode: 'full', text: 'Stale A1' }
    })
    await act(async () => {
      await loadPromiseA1!
      await loadPromiseA2!
    })

    // 6. 验证卸载时的清理：卸载组件将触发剩余活跃请求的清理
    await act(async () => {
      root.unmount()
    })
  })

  it('cancels ongoing in-flight request when component unmounts', async () => {
    const cancelled: Array<{ articleId: string; requestId?: string }> = []
    const api = {
      getReaderContent: vi.fn().mockResolvedValue({ articleId: 'A', mode: 'feed' } as unknown as ReaderArticleContent),
      fetchFullContent: vi.fn().mockImplementation(() => new Promise(() => {})),
      cancelFullContent: vi.fn().mockImplementation(async (id: string, requestId?: string) => {
        cancelled.push({ articleId: id, requestId })
      })
    }

    function TestHarness() {
      const requests = useReaderContentRequests({
        articleId: 'A',
        accountId: 1,
        api,
        setContent: vi.fn(),
        setLoading: vi.fn(),
        setError: vi.fn(),
        setCacheWriteError: vi.fn(),
        failureMessage: (r) => `Failure: ${r}`,
        onContentChanged: vi.fn()
      })

      return (
        <button
          onClick={() => {
            void requests.fetchFullContent()
          }}
        >
          Fetch
        </button>
      )
    }

    const { root, container } = setupDom()

    await act(async () => {
      root.render(<TestHarness />)
    })

    // 点击发起 fetchFullContent
    await act(async () => {
      container.querySelector('button')!.click()
    })

    expect(api.fetchFullContent).toHaveBeenCalledWith('A', expect.stringContaining('A-1-'))
    const reqId = (api.fetchFullContent.mock.calls[0] as [string, string])[1]
    expect(cancelled).toEqual([])

    // 卸载组件
    await act(async () => {
      root.unmount()
    })

    // 验证卸载时准确调用了 cancelFullContent
    expect(cancelled.length).toBe(1)
    expect(cancelled[0]).toBeDefined()
    expect(cancelled[0]!).toEqual({ articleId: 'A', requestId: reqId })
  })
})
