/** Reasoning effort requested by the user/runtime. AUTO means do not send a provider parameter. */
export type LlmReasoningEffort =
  | 'AUTO'
  | 'NONE'
  | 'MINIMAL'
  | 'LOW'
  | 'MEDIUM'
  | 'HIGH'
  | 'XHIGH'
  | 'MAXIMUM'

/** Wire shape used by the current OpenAI-compatible Chat Completions adapter. */
export type ReasoningParameterStyle = 'NONE' | 'OPENAI_REASONING_EFFORT'

export interface ProviderReasoningParameter {
  key: 'reasoning_effort'
  value: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface LlmReasoningPreference {
  effort: LlmReasoningEffort
  showReasoning: boolean
}

export const DEFAULT_LLM_REASONING_PREFERENCE: LlmReasoningPreference = {
  effort: 'AUTO',
  showReasoning: true
}
