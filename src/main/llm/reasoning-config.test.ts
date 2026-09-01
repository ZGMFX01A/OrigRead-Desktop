import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS, type AiProviderProfile } from '../../shared/ai'
import { resolveAiProviderCapability } from '../ai/ai-provider-capabilities'
import { resolveLlmReasoningConfig } from './reasoning-config'

function provider(endpoint: string): AiProviderProfile {
  return {
    id: 'provider',
    name: 'Provider',
    enabled: true,
    endpoint,
    defaultModel: '',
    models: [],
    streamingCapabilityOverride: 'AUTO',
    toolCallingCapabilityOverride: 'AUTO',
    reasoningCapabilityOverride: 'AUTO',
    outputTokenLimitStyle: 'AUTO',
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    strictStreamTermination: true,
    hasApiKey: false,
    apiKeyLength: 0
  }
}

describe('LLM reasoning config', () => {
  it('sends effort for a supported model even when reasoning display is disabled', () => {
    const capability = resolveAiProviderCapability(provider('https://api.deepseek.com/v1'), 'deepseek-v4-flash')
    const resolved = resolveLlmReasoningConfig(capability, { effort: 'HIGH', showReasoning: false })

    expect(resolved.providerParameter).toEqual({ key: 'reasoning_effort', value: 'high' })
    expect(resolved.canDisplayReasoning).toBe(true)
    expect(resolved.displayReasoning).toBe(false)
  })

  it('keeps show reasoning independent from provider effort on hidden-reasoning OpenAI models', () => {
    const capability = resolveAiProviderCapability(provider('https://api.openai.com/v1'), 'gpt-5.6-sol')
    const resolved = resolveLlmReasoningConfig(capability, { effort: 'MAXIMUM', showReasoning: true })

    expect(resolved.providerParameter).toEqual({ key: 'reasoning_effort', value: 'max' })
    expect(resolved.canDisplayReasoning).toBe(false)
    expect(resolved.displayReasoning).toBe(false)
  })

  it('does not send unsupported effort values even when display is enabled', () => {
    const capability = resolveAiProviderCapability(provider('https://gateway.example.com/v1'), 'custom-model')
    const resolved = resolveLlmReasoningConfig(capability, { effort: 'HIGH', showReasoning: true })

    expect(resolved.providerParameter).toBeNull()
    expect(resolved.displayReasoning).toBe(false)
    expect(resolved.preference).toEqual({ effort: 'HIGH', showReasoning: true })
  })

  it('AUTO emits no provider parameter while independently allowing returned reasoning to display', () => {
    const capability = resolveAiProviderCapability(provider('https://api.deepseek.com/v1'), 'deepseek-v4-pro')
    const resolved = resolveLlmReasoningConfig(capability, { effort: 'AUTO', showReasoning: true })

    expect(resolved.providerParameter).toBeNull()
    expect(resolved.displayReasoning).toBe(true)
  })
})
