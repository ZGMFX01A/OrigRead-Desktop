export type LlmContextType =
  | 'ARTICLE'
  | 'ARTICLE_SUMMARY'
  | 'ARTICLE_TRANSLATION'
  | 'SELECTED_TEXT'
  | 'WEB_SEARCH_RESULT'
  | 'TOOL_RESULT'
  | 'ADDITIONAL_ARTICLE'
  | 'MANUAL'

export const LLM_CONTEXT_TYPES: ReadonlySet<LlmContextType> = new Set([
  'ARTICLE',
  'ARTICLE_SUMMARY',
  'ARTICLE_TRANSLATION',
  'SELECTED_TEXT',
  'WEB_SEARCH_RESULT',
  'TOOL_RESULT',
  'ADDITIONAL_ARTICLE',
  'MANUAL'
])

export interface LlmContextItem {
  /** Stable request-local ID. Duplicate IDs are rejected because bookkeeping is ID-based. */
  id: string
  type: LlmContextType
  content: string
  title?: string | null
  /** Stable source identity such as article URL, search URL, or tool source ID. */
  sourceId?: string | null
  /** OrigRead internal article ID for in-app navigation; never used as an external source locator. */
  internalArticleId?: string | null
  /** Reserve a minimum future budget so high-priority auxiliary text cannot evict raw evidence. */
  reserveEvidenceBudget?: boolean
  /** Citation-eligible evidence is atomic and may only be budgeted as complete blocks. */
  evidenceBlocks?: readonly LlmContextEvidenceBlock[]
  priority?: number
}

export interface LlmContextEvidenceBlock {
  stableLocatorKey: string
  content: string
}

export interface LlmContextPolicy {
  /** Approximate token budget for injected context, not the provider's declared model window. */
  maxTokens: number
  allowedTypes?: ReadonlySet<LlmContextType>
}

export type LlmContextDecisionStatus =
  | 'INCLUDED'
  | 'INCLUDED_TRUNCATED'
  | 'OMITTED_BUDGET'
  | 'OMITTED_FILTERED'

export interface LlmRenderedContextItem {
  id: string
  content: string
  truncated: boolean
  /** Exact whole evidence blocks that entered the prompt, in prompt order. */
  evidenceBlockKeys?: string[]
}

export interface LlmContextDecision {
  id: string
  status: LlmContextDecisionStatus
}

export interface ComposedLlmContext {
  text: string
  includedIds: string[]
  omittedIds: string[]
  truncated: boolean
  renderedItems: LlmRenderedContextItem[]
  decisions: LlmContextDecision[]
}
export function llmEvidenceRequestIdentity(contextId: string, stableLocatorKey: string): string {
  return `${contextId.length}:${contextId}${stableLocatorKey.length}:${stableLocatorKey}`
}
