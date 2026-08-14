import type { SourceSyncBatchResult } from './source-sync'

export type SyncTrigger = 'startup' | 'periodic' | 'manual'

export interface SyncRuntimeState {
  running: boolean
  lastStartedAt: number | null
  lastFinishedAt: number | null
  nextRunAt: number | null
  lastTrigger: SyncTrigger | null
  lastResult: SourceSyncBatchResult | null
}

