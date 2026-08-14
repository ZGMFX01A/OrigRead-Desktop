import type { SourceType } from './library'

export type SourceSyncStatus = 'success' | 'failed'

export interface SourceSyncItemResult {
  feedId: string
  feedName: string
  sourceType: SourceType
  status: SourceSyncStatus
  fetchedArticles: number
  insertedArticles: number
  deletedArticles: number
  error: string | null
}

export interface SourceSyncBatchResult {
  startedAt: number
  finishedAt: number
  sourceCount: number
  successCount: number
  failedCount: number
  fetchedArticles: number
  insertedArticles: number
  deletedArticles: number
  retryRecommended: boolean
  results: SourceSyncItemResult[]
}

