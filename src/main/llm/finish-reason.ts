import type { LlmUnifiedFinishReason } from '../../shared/llm-chat'

/** Provider raw finish reasons must terminate here; persistence/UI only see the unified enum. */
export function normalizeLlmFinishReason(
  rawReason: string | null | undefined,
  state: { cancelled?: boolean; errored?: boolean } = {}
): LlmUnifiedFinishReason {
  if (state.cancelled) return 'CANCELLED'
  if (state.errored) return 'ERROR'
  const value = rawReason?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? ''
  if (!value) return 'OTHER'
  if (['stop', 'end_turn', 'complete', 'completed'].includes(value)) return 'STOP'
  if (['length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens'].includes(value)) return 'LENGTH'
  if (['tool_calls', 'tool_call', 'function_call', 'function_calls'].includes(value)) return 'TOOL_CALLS'
  if (['content_filter', 'content_filtered', 'safety', 'blocked'].includes(value)) return 'CONTENT_FILTER'
  if (['cancelled', 'canceled', 'abort', 'aborted'].includes(value)) return 'CANCELLED'
  if (['error', 'failed', 'failure'].includes(value)) return 'ERROR'
  return 'OTHER'
}
