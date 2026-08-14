export type ReaderContentMode = 'full' | 'content' | 'description'

export type FullContentFailureReason =
  | 'NO_CONTENT'
  | 'DYNAMIC_CONTENT'
  | 'ACCESS_RESTRICTED'
  | 'PAGE_UNAVAILABLE'
  | 'INVALID_URL'
  | 'NETWORK'
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
}

