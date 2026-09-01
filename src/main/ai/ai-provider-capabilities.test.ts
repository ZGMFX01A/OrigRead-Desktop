import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS, type AiProviderProfile } from '../../shared/ai'
import {
  applyAiProviderCapabilityOverride,
  resolveAiOutputTokenLimitStyle,
  resolveAiProviderCapability,
  resolveProviderReasoningParameter
} from './ai-provider-capabilities'

function provider(patch: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: 'provider',
    name: 'Provider',
    enabled: true,
    endpoint: 'https://gateway.example.com/v1',
    defaultModel: 'custom-model',
    models: ['custom-model'],
    streamingCapabilityOverride: 'AUTO',
    toolCallingCapabilityOverride: 'AUTO',
    reasoningCapabilityOverride: 'AUTO',
    outputTokenLimitStyle: 'AUTO',
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    strictStreamTermination: true,
    hasApiKey: false,
    apiKeyLength: 0,
    ...patch
  }
}

describe('AI provider capability resolver', () => {
  it('uses conservative capabilities for an unknown compatible provider', () => {
    expect(resolveAiProviderCapability(provider(), 'custom-model')).toEqual({
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsNativeWebSearch: false,
      supportedReasoningEfforts: new Set(),
      reasoningParameterStyle: 'NONE',
      supportsReasoningOutput: false,
      supportsImageInput: false,
      supportsFileInput: false,
      supportsStructuredOutput: false,
      contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
      outputTokenLimitStyle: 'MAX_TOKENS',
      strictStreamTermination: true
    })
  })

  it('uses max_completion_tokens only for official OpenAI reasoning models in AUTO mode', () => {
    for (const model of ['o1', 'o3-mini', 'o4-mini', 'gpt-5']) {
      expect(resolveAiOutputTokenLimitStyle('https://api.openai.com/v1', model)).toBe('MAX_COMPLETION_TOKENS')
    }
    expect(resolveAiOutputTokenLimitStyle('https://api.openai.com/v1', 'gpt-4o')).toBe('MAX_TOKENS')
    expect(resolveAiOutputTokenLimitStyle('https://gateway.example.com/v1', 'gpt-5')).toBe('MAX_TOKENS')
  })

  it('lets explicit provider overrides replace AUTO detection without using provider names', () => {
    const capability = resolveAiProviderCapability(provider({
      name: 'This name must not matter',
      streamingCapabilityOverride: 'DISABLED',
      toolCallingCapabilityOverride: 'ENABLED',
      reasoningCapabilityOverride: 'ENABLED',
      outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
      contextWindowTokens: 4_096,
      strictStreamTermination: false
    }), 'custom-model')

    expect(capability).toMatchObject({
      supportsStreaming: false,
      supportsToolCalling: true,
      supportsReasoningOutput: true,
      reasoningParameterStyle: 'OPENAI_REASONING_EFFORT',
      contextWindowTokens: 4_096,
      outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
      strictStreamTermination: false
    })
    expect(capability.supportedReasoningEfforts).toEqual(new Set(['LOW', 'MEDIUM', 'HIGH']))
  })

  it('recognizes current DeepSeek V4 dual-mode reasoning and tools, not retired aliases', () => {
    const v4 = resolveAiProviderCapability(provider({ endpoint: 'https://api.deepseek.com/v1' }), 'deepseek-v4-flash')
    expect(v4).toMatchObject({
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsReasoningOutput: true,
      reasoningParameterStyle: 'OPENAI_REASONING_EFFORT'
    })
    expect(v4.supportedReasoningEfforts).toEqual(new Set(['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAXIMUM']))

    expect(resolveAiProviderCapability(provider({ endpoint: 'https://api.deepseek.com/v1' }), 'deepseek-reasoner')).toMatchObject({
      supportsToolCalling: false,
      supportsReasoningOutput: false,
      reasoningParameterStyle: 'NONE'
    })
  })

  it('resolves current OpenAI reasoning effort families without exposing hidden reasoning output', () => {
    const latest = resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5.6-sol')
    expect(latest).toMatchObject({
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsReasoningOutput: false,
      reasoningParameterStyle: 'OPENAI_REASONING_EFFORT'
    })
    expect(latest.supportedReasoningEfforts).toEqual(new Set(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAXIMUM']))

    expect(resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5')).toMatchObject({
      supportsReasoningOutput: false
    })
    expect(resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5').supportedReasoningEfforts)
      .toEqual(new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']))
    expect(resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5.3-codex').supportedReasoningEfforts)
      .toEqual(new Set(['LOW', 'MEDIUM', 'HIGH', 'XHIGH']))
  })

  it('applies request-level capability overrides last and preserves unspecified fields', () => {
    const base = resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5.6-sol')
    const restricted = applyAiProviderCapabilityOverride(base, {
      supportsStreaming: false,
      supportsToolCalling: false,
      supportedReasoningEfforts: new Set(['LOW']),
      supportsFileInput: true
    })

    expect(restricted).toMatchObject({
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsFileInput: true,
      supportsReasoningOutput: false,
      reasoningParameterStyle: 'OPENAI_REASONING_EFFORT',
      contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS
    })
    expect(restricted.supportedReasoningEfforts).toEqual(new Set(['LOW']))
  })

  it('only emits reasoning_effort when the resolved model capability explicitly supports the requested level', () => {
    const latest = resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5.6-sol')
    expect(resolveProviderReasoningParameter(latest, 'AUTO')).toBeNull()
    expect(resolveProviderReasoningParameter(latest, 'MAXIMUM')).toEqual({ key: 'reasoning_effort', value: 'max' })

    const oldReasoning = resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'o3')
    expect(resolveProviderReasoningParameter(oldReasoning, 'XHIGH')).toBeNull()
    expect(resolveProviderReasoningParameter(oldReasoning, 'MEDIUM')).toEqual({ key: 'reasoning_effort', value: 'medium' })
  })

  it('keeps future native-search, image, file and structured-output seams disabled until adapters implement them', () => {
    expect(resolveAiProviderCapability(provider({ endpoint: 'https://api.openai.com/v1' }), 'gpt-5.6-sol')).toMatchObject({
      supportsNativeWebSearch: false,
      supportsImageInput: false,
      supportsFileInput: false,
      supportsStructuredOutput: false
    })
  })
})
