import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { RecentArticleRecord } from '../../shared/library'

export type ReadingHistoryAction = 'list' | 'record' | 'clear'
export type ReadingHistoryErrorFormatter = (action: ReadingHistoryAction, error: unknown) => string

export interface RecentReadingHistoryApi {
  listRecentArticles: (limit?: number) => Promise<RecentArticleRecord[]>
  recordArticleOpened: (articleId: string) => Promise<void>
  clearReadingHistory: () => Promise<void>
}

export interface UseRecentReadingHistoryOptions {
  currentAccountId: number | null
  api?: RecentReadingHistoryApi
  formatErrorMessage?: ReadingHistoryErrorFormatter
}

export interface UseRecentReadingHistoryResult {
  recentArticles: RecentArticleRecord[]
  setRecentArticles: Dispatch<SetStateAction<RecentArticleRecord[]>>
  recentHistoryError: string | null
  setRecentHistoryError: Dispatch<SetStateAction<string | null>>
  loadRecent: (targetAccountId?: number | null) => Promise<void>
  recordArticleOpenedSafely: (articleId: string) => Promise<void>
  clearReadingHistorySafely: () => Promise<boolean>
}

const defaultApi: RecentReadingHistoryApi = {
  listRecentArticles: (limit = 500) => window.origread.listRecentArticles(limit),
  recordArticleOpened: (articleId: string) => window.origread.recordArticleOpened(articleId),
  clearReadingHistory: () => window.origread.clearReadingHistory()
}

/**
 * 管理最近阅读历史、request generation 异步并发屏障、错误状态及账户切换的 Hook。
 */
export function useRecentReadingHistory({
  currentAccountId,
  api = defaultApi,
  formatErrorMessage
}: UseRecentReadingHistoryOptions): UseRecentReadingHistoryResult {
  const [recentArticles, setRecentArticles] = useState<RecentArticleRecord[]>([])
  const [recentHistoryError, setRecentHistoryError] = useState<string | null>(null)

  const requestGenerationRef = useRef(0)
  const currentAccountIdRef = useRef(currentAccountId)
  currentAccountIdRef.current = currentAccountId

  const apiRef = useRef(api)
  apiRef.current = api

  const formatErrorRef = useRef(formatErrorMessage)
  formatErrorRef.current = formatErrorMessage

  const formatError = useCallback((action: ReadingHistoryAction, error: unknown): string => {
    if (formatErrorRef.current) {
      return formatErrorRef.current(action, error)
    }
    return error instanceof Error ? error.message : String(error)
  }, [])

  // 账户切换时：同步递增 generation 阻止旧账户在途响应写回，立即清空历史与错误
  const prevAccountIdRef = useRef(currentAccountId)
  if (prevAccountIdRef.current !== currentAccountId) {
    prevAccountIdRef.current = currentAccountId
    requestGenerationRef.current += 1
    setRecentArticles([])
    setRecentHistoryError(null)
  }

  // 单一加载 helper：带 accountId + generation 保护，所有加载请求均统一走此路径
  const loadRecent = useCallback(async (targetAccountId: number | null = currentAccountIdRef.current): Promise<void> => {
    const generation = ++requestGenerationRef.current
    try {
      const records = await apiRef.current.listRecentArticles(500)
      if (generation === requestGenerationRef.current && targetAccountId === currentAccountIdRef.current) {
        setRecentArticles(records)
        setRecentHistoryError(null)
      }
    } catch (error) {
      if (generation === requestGenerationRef.current && targetAccountId === currentAccountIdRef.current) {
        setRecentHistoryError(formatError('list', error))
      }
    }
  }, [formatError])

  // 账户挂载或切换后触发加载
  useEffect(() => {
    void loadRecent(currentAccountId)
  }, [currentAccountId, loadRecent])

  // 安全记录文章打开：写失败不阻碍阅读，但置 recentHistoryError 使错误可见
  const recordArticleOpenedSafely = useCallback(async (articleId: string): Promise<void> => {
    const targetAccountId = currentAccountIdRef.current
    const generation = requestGenerationRef.current
    try {
      await apiRef.current.recordArticleOpened(articleId)
      if (targetAccountId === currentAccountIdRef.current && generation === requestGenerationRef.current) {
        void loadRecent(targetAccountId)
      }
    } catch (error) {
      if (targetAccountId === currentAccountIdRef.current && generation === requestGenerationRef.current) {
        setRecentHistoryError(formatError('record', error))
      }
    }
  }, [formatError, loadRecent])

  // 安全清空历史：清空开始时同步递增 generation，使在途的异步查询无权写回
  const clearReadingHistorySafely = useCallback(async (): Promise<boolean> => {
    const generation = ++requestGenerationRef.current
    const targetAccountId = currentAccountIdRef.current
    try {
      await apiRef.current.clearReadingHistory()
      if (generation === requestGenerationRef.current && targetAccountId === currentAccountIdRef.current) {
        setRecentArticles([])
        setRecentHistoryError(null)
      }
      return true
    } catch (error) {
      if (generation === requestGenerationRef.current && targetAccountId === currentAccountIdRef.current) {
        setRecentHistoryError(formatError('clear', error))
      }
      return false
    }
  }, [formatError])

  return {
    recentArticles,
    setRecentArticles,
    recentHistoryError,
    setRecentHistoryError,
    loadRecent,
    recordArticleOpenedSafely,
    clearReadingHistorySafely
  }
}
