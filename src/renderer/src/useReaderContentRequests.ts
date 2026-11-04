import { useEffect, useRef } from 'react'
import type { OrigReadDesktopApi } from '../../shared/contracts'
import {
  createReaderContentRequestScope,
  ReaderContentRequests,
  type ReaderSelection,
  type ReaderContentPublisher
} from './reader-content-requests'

export interface ReaderContentRequestOptions extends ReaderSelection, ReaderContentPublisher {
  readonly api: Pick<OrigReadDesktopApi, 'getReaderContent' | 'fetchFullContent' | 'cancelFullContent'>
}

/**
 * React 维护请求实例与生命周期。
 * 跨 render 保持同一 ReaderContentRequests 稳定引用，避免重新创建丢弃活跃请求；
 * 严禁在 render 阶段发送取消 IPC；仅在 useEffect（切文章/切账户或组件卸载）中安全清理。
 */
export function useReaderContentRequests(options: ReaderContentRequestOptions): ReaderContentRequests {
  const scopeRef = useRef<ReturnType<typeof createReaderContentRequestScope> | null>(null)
  if (!scopeRef.current) {
    scopeRef.current = createReaderContentRequestScope()
  }

  const optionsRef = useRef(options)
  optionsRef.current = options

  const requestsRef = useRef<ReaderContentRequests | null>(null)
  if (!requestsRef.current) {
    requestsRef.current = new ReaderContentRequests(
      scopeRef.current,
      {
        getReaderContent: (id, preferFull) => optionsRef.current.api.getReaderContent(id, preferFull),
        fetchFullContent: (id, reqId) => optionsRef.current.api.fetchFullContent(id, reqId),
        cancelFullContent: (id, reqId) => optionsRef.current.api.cancelFullContent(id, reqId)
      },
      {
        setContent: (c) => optionsRef.current.setContent(c),
        setLoading: (l) => optionsRef.current.setLoading(l),
        setError: (e) => optionsRef.current.setError(e),
        setCacheWriteError: (e) => optionsRef.current.setCacheWriteError(e),
        failureMessage: (r) => optionsRef.current.failureMessage(r),
        onContentChanged: () => optionsRef.current.onContentChanged()
      }
    )
  }

  // 纯 selection 投影与代次自增（纯计算，无 render 阶段网络/IPC 副作用）
  scopeRef.current.select({ articleId: options.articleId, accountId: options.accountId })

  const prevArticleIdRef = useRef<string | null>(options.articleId)
  const prevAccountIdRef = useRef<number | null>(options.accountId)

  // 在合法 effect 生命周期中检测切文章/切账户并执行旧请求取消
  useEffect(() => {
    if (
      options.articleId !== prevArticleIdRef.current ||
      options.accountId !== prevAccountIdRef.current
    ) {
      prevArticleIdRef.current = options.articleId
      prevAccountIdRef.current = options.accountId
      requestsRef.current?.cancelActiveFetch()
    }
  }, [options.articleId, options.accountId])

  // 组件卸载时在 cleanup 中调用 invalidate 彻底清理
  useEffect(() => {
    return () => {
      requestsRef.current?.invalidate()
    }
  }, [])

  return requestsRef.current
}
