import type { LlmContextType } from './llm-context'

export const LLM_EVIDENCE_SCHEMA_VERSION = 1
export const LLM_CITATION_SCHEMA_VERSION = 1
export const LLM_CITATION_ANNOTATION_SCHEMA_VERSION = 1

export type LlmChatRole = 'SYSTEM' | 'USER' | 'ASSISTANT' | 'TOOL'
export type LlmMessageStatus = 'COMPLETE' | 'STREAMING' | 'STOPPED' | 'ERROR'
export type LlmToolCallStatus = 'PENDING_APPROVAL' | 'RUNNING' | 'COMPLETE' | 'DENIED' | 'ERROR'
export type LlmWebSearchRequestStatus =
  | 'NOT_NEEDED'
  | 'TRIGGERED'
  | 'SUCCESS'
  | 'EMPTY_RESULT'
  | 'FAILED_FALLBACK'
  | 'FAILED_REQUIRED'
  | 'CANCELLED'

export type LlmUnifiedFinishReason =
  | 'STOP'
  | 'LENGTH'
  | 'TOOL_CALLS'
  | 'CONTENT_FILTER'
  | 'ERROR'
  | 'CANCELLED'
  | 'OTHER'

export interface LlmConversationRecord {
  id: string
  title: string
  providerId: string | null
  model: string | null
  skillId: string | null
  articleId: string | null
  articleTitle: string | null
  articleLink: string | null
  createdAt: number
  updatedAt: number
}

export interface LlmConversationArticleRecord {
  conversationId: string
  articleId: string
  title: string
  link: string | null
  originalContent: string
  summary: string | null
  position: number
  createdAt: number
}

export interface LlmMessageRecord {
  id: string
  conversationId: string
  role: LlmChatRole
  content: string
  requestTask: 'CHAT' | 'ARTICLE_ANALYSIS' | null
  providerId: string | null
  model: string | null
  reasoning: string | null
  status: LlmMessageStatus
  errorMessage: string | null
  historyActive: boolean
  webSearchStatus: LlmWebSearchRequestStatus | null
  webSearchQuery: string | null
  webSearchProviderName: string | null
  webSearchResultCount: number | null
  webSearchErrorMessage: string | null
  promptTokens: number | null
  completionTokens: number | null
  durationMs: number | null
  tokenUsageEstimated: boolean
  finishReason: LlmUnifiedFinishReason | null
  createdAt: number
  updatedAt: number
}

export interface LlmToolCallRecord {
  id: string
  conversationId: string
  assistantMessageId: string
  providerCallId: string
  toolId: string
  apiName: string
  argumentsJson: string
  status: LlmToolCallStatus
  resultContent: string | null
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface LlmContextRefRecord {
  id: string
  conversationId: string
  assistantMessageId: string
  contextId: string
  type: LlmContextType
  title: string | null
  sourceId: string | null
  articleId: string | null
  sourceUrl: string | null
  contentSnapshot: string
  promptContentSnapshot: string | null
  contentSha256: string
  priority: number
  includedInPrompt: boolean
  truncatedInPrompt: boolean
  createdAt: number
}

export type LlmEvidenceBlockKind =
  | 'HEADING'
  | 'PARAGRAPH'
  | 'LIST_ITEM'
  | 'BLOCKQUOTE'
  | 'CODE'
  | 'TABLE_ROW'
  | 'SELECTION'
  | 'SEARCH_RESULT'
  | 'TOOL_RESULT'

/** Locator is frozen request history. D7 may add fields, but old rows stay readable by version. */
export interface LlmEvidenceLocatorV1 {
  version: 1
  sourceKind: 'ARTICLE' | 'SELECTION' | 'WEB_SEARCH' | 'TOOL_RESULT'
  /** Stable evidence identity used by Reader DOM anchors when available. */
  stableLocatorKey?: string
  blockIndex?: number
  headingPath?: string[]
  articleId?: string | null
  sourceUrl?: string | null
  /** Frozen tool provenance; do not resolve historical citations against the live MCP catalog. */
  toolCallId?: string | null
  toolId?: string | null
  toolName?: string | null
  toolSourceId?: string | null
  normalizedHash: string
}

export interface LlmEvidenceBlockRecord {
  id: string
  contextRefId: string
  stableLocatorKey: string
  kind: LlmEvidenceBlockKind
  ordinal: number
  textSnapshot: string
  normalizedSha256: string
  locator: LlmEvidenceLocatorV1
  schemaVersion: number
  createdAt: number
}

export type LlmCitationTargetKind = 'EVIDENCE_BLOCK' | 'CONTEXT_REF'

export interface LlmCitationRefRecord {
  /** Stable internal identity. Never use a visual number as this ID. */
  id: string
  conversationId: string
  assistantMessageId: string
  contextRefId: string
  evidenceBlockId: string | null
  targetKind: LlmCitationTargetKind
  /** Provider-neutral request token such as E1. This is not the final visual [1] order. */
  protocolId: string
  displayOrder: number | null
  quoteSnapshot: string
  sourceUrl: string | null
  locatorSnapshot: LlmEvidenceLocatorV1 | null
  schemaVersion: number
  createdAt: number
}

export interface LlmCitationAnnotationRecord {
  id: string
  conversationId: string
  assistantMessageId: string
  /** UTF-16 offset in the canonical assistant Markdown after transport tokens are removed. */
  canonicalInsertionOffset: number
  occurrenceOrdinal: number
  schemaVersion: number
  createdAt: number
}

export interface LlmCitationAnnotationRefRecord {
  annotationId: string
  citationRefId: string
  /** Stable source ordering inside a multi-evidence occurrence. */
  refOrdinal: number
}
