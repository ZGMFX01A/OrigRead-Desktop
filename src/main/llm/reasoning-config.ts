import type { LlmReasoningPreference, ProviderReasoningParameter } from '../../shared/llm'
import type { AiProviderCapability } from '../ai/ai-provider-capabilities'
import { resolveProviderReasoningParameter } from '../ai/ai-provider-capabilities'

export interface ResolvedLlmReasoningConfig {
  /** Keep the user's choice even when the current model cannot honor that effort value. */
  preference: LlmReasoningPreference
  /** Non-null only when capability resolution explicitly allows this exact effort. */
  providerParameter: ProviderReasoningParameter | null
  /** Whether the provider/model is known to return reasoning text to the client. */
  canDisplayReasoning: boolean
  /** UI-only decision. It never enables or disables provider-side reasoning. */
  displayReasoning: boolean
}

export function resolveLlmReasoningConfig(
  capability: AiProviderCapability,
  preference: LlmReasoningPreference
): ResolvedLlmReasoningConfig {
  return {
    preference,
    providerParameter: resolveProviderReasoningParameter(capability, preference.effort),
    canDisplayReasoning: capability.supportsReasoningOutput,
    displayReasoning: preference.showReasoning && capability.supportsReasoningOutput
  }
}
