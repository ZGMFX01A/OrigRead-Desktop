import type { SourceType } from './library'

export type SourceCandidateKind =
  | 'RSS_DIRECT'
  | 'RSS_DISCOVERED'
  | 'RSSHUB'
  | 'JSON'
  | 'WEBSITE'
  | 'WEBSITE_DYNAMIC'

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

export interface SourceDiscoveryResult {
  discoveryId: string
  sourceUrl: string
  candidates: SourceCandidateSummary[]
  selectedCandidateId: string | null
  error: string | null
}

export interface SourceSubscriptionResult {
  feedId: string
  selectedCandidate: SourceCandidateSummary
}

