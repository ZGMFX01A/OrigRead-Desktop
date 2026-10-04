import { useRef } from 'react'
import type { OrigReadDesktopApi } from '../../shared/contracts'
import { createReaderContentRequestScope, ReaderContentRequests, type ReaderSelection, type ReaderContentPublisher } from './reader-content-requests'

interface Options extends ReaderSelection, ReaderContentPublisher {
  readonly api: Pick<OrigReadDesktopApi, 'getReaderContent' | 'fetchFullContent'>
}

/** React 只维护请求实例；业务读取、身份校验和状态发布由注入接口的执行器负责。 */
export function useReaderContentRequests(options: Options): ReaderContentRequests {
  const scopeRef = useRef<ReturnType<typeof createReaderContentRequestScope> | null>(null)
  if (!scopeRef.current) scopeRef.current = createReaderContentRequestScope()
  scopeRef.current.select({ articleId: options.articleId, accountId: options.accountId })
  return new ReaderContentRequests(scopeRef.current, options.api, options)
}
