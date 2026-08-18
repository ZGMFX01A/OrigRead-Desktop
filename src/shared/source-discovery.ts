import type { SourceType } from './library'
import type { RssHubCandidateState } from './rsshub'

export type SourceCandidateKind =
  | 'RSS_DIRECT'
  | 'RSS_DISCOVERED'
  | 'RSSHUB'
  | 'JSON'
  | 'WEBSITE'
  | 'WEBSITE_DYNAMIC'

export type SourceDiscoveryStage =
  | 'rss'
  | 'rsshub'
  | 'json'
  | 'website'
  | 'dynamic_website'
  | 'ranking'

export type SourceDiscoveryStageState = 'running' | 'completed'

export interface SourceDiscoveryProgress {
  requestId: string
  stage: SourceDiscoveryStage
  state: SourceDiscoveryStageState
  at: number
}

export interface SourceCandidateDiagnostics {
  score: number
  accepted: boolean
  articleCount: number
  validTitleRate: number
  validLinkRate: number
  uniqueLinkRate: number
  parsedDateRate: number
  reasons: string[]
}

export interface SourceCandidateSummary {
  id: string
  title: string
  feedLink: string
  sourceType: SourceType
  kind: SourceCandidateKind
  diagnostics: SourceCandidateDiagnostics
  sourceNotice: string | null
  browser: boolean
  dynamicRendering: boolean
}

/**
 * RSSHub 本地路由命中状态独立于“可参与统一评分的来源候选”。
 * 即使实例关闭、超时或返回无效 Feed，本地已命中的路由也必须能展示给用户。
 */
export interface RssHubRouteStatusSummary {
  routeId: string
  name: string
  feedUrl: string | null
  candidateId: string | null
  state: RssHubCandidateState
  available: boolean
  articleCount: number
  message: string | null
}

export interface SourceDiscoveryResult {
  discoveryId: string
  sourceUrl: string
  candidates: SourceCandidateSummary[]
  rssHubRoutes: RssHubRouteStatusSummary[]
  selectedCandidateId: string | null
  error: string | null
}

export interface SourceSubscriptionResult {
  feedId: string
  selectedCandidate: SourceCandidateSummary
}

