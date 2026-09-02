/**
 * D7.8 Context Budget business ordering.
 *
 * Base tiers mirror the current Android product semantics. Desktop ordinary Reader Chat
 * intentionally does not inject Summary/Translation artifacts, but their slots stay explicit
 * so future task-specific contexts cannot accidentally collapse the ordering contract.
 *
 * Effective priorities are scaled by 100. The low two digits are reserved for stable ranking
 * inside one tier (for example Web Search provider rank or attachment order) without allowing a
 * lower-ranked item to cross into the next business tier.
 */
export const LLM_CONTEXT_PRIORITY_BASE = Object.freeze({
  SELECTED_TEXT: 160,
  ARTICLE_SUMMARY: 130,
  ARTICLE_TRANSLATION: 120,
  TOOL_RESULT: 115,
  WEB_SEARCH_RESULT: 110,
  CURRENT_ARTICLE: 100,
  ADDITIONAL_ARTICLE: 90
} as const)

const PRIORITY_SCALE = 100
const MAX_TIER_RANK = PRIORITY_SCALE - 1

export function llmContextPriority(base: number, rank = 0): number {
  if (!Number.isFinite(base)) throw new Error('Context priority base must be finite')
  const normalizedRank = Math.min(MAX_TIER_RANK, Math.max(0, Math.trunc(rank)))
  return Math.trunc(base) * PRIORITY_SCALE - normalizedRank
}

export const SELECTED_TEXT_CONTEXT_PRIORITY = llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.SELECTED_TEXT)
export const MANUAL_TOOL_CONTEXT_PRIORITY = llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.TOOL_RESULT)
export const CURRENT_ARTICLE_CONTEXT_PRIORITY = llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.CURRENT_ARTICLE)

export function webSearchContextPriority(index: number): number {
  return llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.WEB_SEARCH_RESULT, index)
}

export function additionalArticleContextPriority(index: number): number {
  return llmContextPriority(LLM_CONTEXT_PRIORITY_BASE.ADDITIONAL_ARTICLE, index)
}
