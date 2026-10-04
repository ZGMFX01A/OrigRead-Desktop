export type ReaderContentMode = 'full' | 'content' | 'description'

export type FullContentFailureReason =
  | 'NO_CONTENT'
  | 'DYNAMIC_CONTENT'
  | 'ACCESS_RESTRICTED'
  | 'PAGE_UNAVAILABLE'
  | 'INVALID_URL'
  | 'NETWORK'
  | 'ARTICLE_UNAVAILABLE'
  | 'CACHE_STORAGE'
  | 'UNKNOWN'

export interface ReaderArticleContent {
  articleId: string
  mode: ReaderContentMode
  html: string
  sourceUrl: string | null
}

export interface FullContentFetchResult {
  ok: boolean
  content: ReaderArticleContent | null
  failureReason: FullContentFailureReason | null
  /** 正文仍可阅读，但离线缓存写入失败；不得将此状态报告为保存成功。 */
  cacheWriteError?: string
}

