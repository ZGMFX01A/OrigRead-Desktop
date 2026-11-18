import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecentArticleRecord } from '../../shared/library'
import { useRecentReadingHistory, type RecentReadingHistoryApi, type UseRecentReadingHistoryResult } from './useRecentReadingHistory'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function sampleRecentArticle(id: string, accountId = 1): RecentArticleRecord {
  return {
    id,
    accountId,
    feedId: 'feed-1',
    title: `Article ${id}`,
    url: `https://example.com/${id}`,
    author: 'Author',
    publishedAt: 1000,
    description: 'Desc',
    contentHtml: null,
    fullContentHtml: null,
    imageUrl: null,
    isUnread: false,
    isStarred: false,
    createdAt: 1000,
    updatedAt: 1000,
    lastOpenedAt: 2000
  }
}

describe('useRecentReadingHistory', () => {
  const roots = new Set<Root>()
  let container: HTMLDivElement

  beforeEach(() => {
    const environment = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('window', environment.window)
    vi.stubGlobal('document', environment.document)
    container = environment.document.getElementById('root') as unknown as HTMLDivElement
  })

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount()
      })
    }
    roots.clear()
    vi.unstubAllGlobals()
  })

  function renderHookHarness(initialAccountId: number | null, api: RecentReadingHistoryApi, formatErrorMessage?: (action: 'list' | 'record' | 'clear', error: unknown) => string) {
    let hookResult!: UseRecentReadingHistoryResult
    let currentId = initialAccountId

    function TestHarness({ accountId }: { accountId: number | null }) {
      hookResult = useRecentReadingHistory({
        currentAccountId: accountId,
        api,
        formatErrorMessage
      })
      return null
    }

    const root = createRoot(container)
    roots.add(root)

    const render = async (accountId = currentId) => {
      currentId = accountId
      await act(async () => {
        root.render(<TestHarness accountId={accountId} />)
      })
    }

    return {
      get result() {
        return hookResult
      },
      rerender: render
    }
  }

  it('prevents stale listRecentArticles response from backfilling after clear (clear后旧响应不回填)', async () => {
    const deferredList = createDeferred<RecentArticleRecord[]>()
    const clearDeferred = createDeferred<void>()

    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockImplementation(() => deferredList.promise),
      recordArticleOpened: vi.fn().mockResolvedValue(undefined),
      clearReadingHistory: vi.fn().mockImplementation(() => clearDeferred.promise)
    }

    const harness = renderHookHarness(1, api)
    await harness.rerender()

    // Clear history is triggered while initial list is pending
    let clearPromise: Promise<boolean>
    await act(async () => {
      clearPromise = harness.result.clearReadingHistorySafely()
    })

    // Clear succeeds
    await act(async () => {
      clearDeferred.resolve()
      await clearPromise
    })
    expect(harness.result.recentArticles).toEqual([])
    expect(harness.result.recentHistoryError).toBeNull()

    // Now the earlier pending list resolves with old data
    await act(async () => {
      deferredList.resolve([sampleRecentArticle('old-1')])
    })

    // The old response must NOT backfill the cleared state
    expect(harness.result.recentArticles).toEqual([])
    expect(harness.result.recentHistoryError).toBeNull()
  })

  it('isolates data between accounts and does not leak stale account data on switch (账户切换不漏数据)', async () => {
    const deferredAccount1 = createDeferred<RecentArticleRecord[]>()
    const deferredAccount2 = createDeferred<RecentArticleRecord[]>()

    let callCount = 0
    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return deferredAccount1.promise
        return deferredAccount2.promise
      }),
      recordArticleOpened: vi.fn().mockResolvedValue(undefined),
      clearReadingHistory: vi.fn().mockResolvedValue(undefined)
    }

    const harness = renderHookHarness(1, api)
    await harness.rerender(1)

    // Switch account to 2 before Account 1 finishes loading
    await harness.rerender(2)
    // Recent articles should immediately be empty on switch
    expect(harness.result.recentArticles).toEqual([])

    // Account 1's deferred resolves now
    await act(async () => {
      deferredAccount1.resolve([sampleRecentArticle('acc1-art', 1)])
    })
    // Account 1 data must not leak into Account 2
    expect(harness.result.recentArticles).toEqual([])

    // Account 2's deferred resolves now
    await act(async () => {
      deferredAccount2.resolve([sampleRecentArticle('acc2-art', 2)])
    })
    // Account 2 has its own data
    expect(harness.result.recentArticles).toEqual([sampleRecentArticle('acc2-art', 2)])
  })

  it('ignores a pending record completion after clear and a pending record error after account switch', async () => {
    const pendingRecord = createDeferred<void>()
    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockResolvedValue([]),
      recordArticleOpened: vi.fn().mockReturnValueOnce(pendingRecord.promise),
      clearReadingHistory: vi.fn().mockResolvedValue(undefined)
    }
    const harness = renderHookHarness(1, api)
    await harness.rerender()
    const record = harness.result.recordArticleOpenedSafely('old')
    await act(async () => { await harness.result.clearReadingHistorySafely() })
    const loadsAfterClear = vi.mocked(api.listRecentArticles).mock.calls.length
    await act(async () => { pendingRecord.resolve(); await record })
    expect(api.listRecentArticles).toHaveBeenCalledTimes(loadsAfterClear)
    expect(harness.result.recentArticles).toEqual([])

    const oldAccountRecord = createDeferred<void>()
    vi.mocked(api.recordArticleOpened).mockReturnValueOnce(oldAccountRecord.promise)
    const failedRecord = harness.result.recordArticleOpenedSafely('old-account')
    await harness.rerender(2)
    await act(async () => { oldAccountRecord.reject(new Error('old error')); await failedRecord })
    expect(harness.result.recentHistoryError).toBeNull()
  })

  it('makes list failure visible, and clears error on subsequent successful load (错误可见与清错)', async () => {
    let failList = true
    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockImplementation(async () => {
        if (failList) throw new Error('Database locked')
        return [sampleRecentArticle('recovered-1')]
      }),
      recordArticleOpened: vi.fn().mockResolvedValue(undefined),
      clearReadingHistory: vi.fn().mockResolvedValue(undefined)
    }

    const harness = renderHookHarness(1, api)
    await harness.rerender()

    // Error is visible, does not fake empty array
    expect(harness.result.recentHistoryError).toBe('Database locked')
    expect(harness.result.recentArticles).toEqual([])

    // Recover on next load
    failList = false
    await act(async () => {
      await harness.result.loadRecent()
    })

    expect(harness.result.recentHistoryError).toBeNull()
    expect(harness.result.recentArticles).toEqual([sampleRecentArticle('recovered-1')])
  })

  it('does not block reading when recordArticleOpened fails, but records recentHistoryError (写失败不阻碍阅读)', async () => {
    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockResolvedValue([]),
      recordArticleOpened: vi.fn().mockRejectedValue(new Error('Record write failed')),
      clearReadingHistory: vi.fn().mockResolvedValue(undefined)
    }

    const harness = renderHookHarness(1, api)
    await harness.rerender()

    // Must not throw or crash reading
    await act(async () => {
      await expect(harness.result.recordArticleOpenedSafely('art-xyz')).resolves.toBeUndefined()
    })

    // Error is set and visible
    expect(harness.result.recentHistoryError).toBe('Record write failed')
  })

  it('handles clearReadingHistory failures and custom error formatter', async () => {
    const api: RecentReadingHistoryApi = {
      listRecentArticles: vi.fn().mockResolvedValue([]),
      recordArticleOpened: vi.fn().mockResolvedValue(undefined),
      clearReadingHistory: vi.fn().mockRejectedValue(new Error('Clear denied'))
    }

    const formatError = (action: 'list' | 'record' | 'clear', error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      return `[${action.toUpperCase()}] ${msg}`
    }

    const harness = renderHookHarness(1, api, formatError)
    await harness.rerender()

    let success: boolean = true
    await act(async () => {
      success = await harness.result.clearReadingHistorySafely()
    })

    expect(success).toBe(false)
    expect(harness.result.recentHistoryError).toBe('[CLEAR] Clear denied')
  })
})
