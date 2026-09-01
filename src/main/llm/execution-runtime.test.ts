import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS, type AiProviderProfile, type AiSettings } from '../../shared/ai'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import { OpenAiCompatibleLlmAdapter } from './openai-compatible-llm-adapter'
import { LlmRuntime } from './execution-runtime'
import { LlmToolRuntime, type LlmTool } from './tool-runtime'

function provider(patch: Partial<AiProviderProfile> = {}): AiProviderProfile {
  return {
    id: 'provider', name: 'Provider', enabled: true, endpoint: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol'],
    streamingCapabilityOverride: 'AUTO', toolCallingCapabilityOverride: 'AUTO', reasoningCapabilityOverride: 'AUTO', outputTokenLimitStyle: 'AUTO',
    contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS, strictStreamTermination: true, hasApiKey: true, apiKeyLength: 6, ...patch
  }
}

function settingsRepository(currentProvider = provider()): AiSettingsRepository {
  const state: AiSettings = { enabled: true, providers: [currentProvider], defaultProviderId: currentProvider.id, outputLanguage: 'zh-CN', summaryLength: 'STANDARD' }
  return { current: () => state, getApiKey: () => 'secret' } as unknown as AiSettingsRepository
}

function readTool(id = 'read'): LlmTool {
  return {
    descriptor: { id, name: id, description: id, source: 'ORIGREAD_INTERNAL', sourceId: 'origread', risk: 'READ_ONLY', enabled: true, inputSchema: { type: 'object' }, outputSchema: null },
    execute: async () => ({ status: 'SUCCESS', content: 'ok' })
  }
}

describe('LlmRuntime execution plan', () => {
  it('resolves provider, model, reasoning, tools, context and instructions into one snapshot', () => {
    const tools = new LlmToolRuntime(); tools.register(readTool())
    const runtime = new LlmRuntime(
      new OpenAiCompatibleLlmAdapter(settingsRepository()),
      undefined,
      tools,
      { resolve: (id) => id === 'skill-1' ? { id, instructions: 'Use a concise evidence-first workflow.' } : null }
    )
    const plan = runtime.prepare({
      task: 'ARTICLE_ANALYSIS',
      reasoning: { effort: 'HIGH', showReasoning: false },
      skillId: 'skill-1',
      customInstructions: ' Prefer short answers. ',
      enabledToolIds: new Set(['read']),
      contextPolicy: { maxTokens: 4_096 }
    }, [{ id: 'article', type: 'ARTICLE', content: 'evidence', sourceId: 'https://example.com/article', priority: 100 }])

    expect(plan).toMatchObject({ task: 'ARTICLE_ANALYSIS', providerId: 'provider', providerName: 'Provider', model: 'gpt-5.6-sol', automaticToolCalling: true, skillId: 'skill-1', customInstructions: 'Prefer short answers.' })
    expect(plan.reasoning.providerParameter).toEqual({ key: 'reasoning_effort', value: 'high' })
    expect(plan.reasoning.displayReasoning).toBe(false)
    expect(plan.runtimeConfig).toMatchObject({ apiKey: 'secret', reasoningParameter: { key: 'reasoning_effort', value: 'high' } })
    expect(plan.tools.map((tool) => tool.id)).toEqual(['read'])
    expect(plan.context.includedIds).toEqual(['article'])
    expect(plan.skillInstructions).toContain('evidence-first')
  })

  it('applies request capability restrictions last and disables automatic tool calling without removing manual tool availability', () => {
    const tools = new LlmToolRuntime(); tools.register(readTool())
    const runtime = new LlmRuntime(new OpenAiCompatibleLlmAdapter(settingsRepository()), undefined, tools)
    const plan = runtime.prepare({ enabledToolIds: new Set(['read']), capabilityOverride: { supportsToolCalling: false } })

    expect(plan.capability.supportsToolCalling).toBe(false)
    expect(plan.tools.map((tool) => tool.id)).toEqual(['read'])
    expect(plan.automaticToolCalling).toBe(false)
  })

  it('caps a requested context budget to the resolved model window', () => {
    const runtime = new LlmRuntime(new OpenAiCompatibleLlmAdapter(settingsRepository(provider({ contextWindowTokens: 4_096 }))))
    const plan = runtime.prepare({ contextPolicy: { maxTokens: 128_000 } }, [{ id: 'article', type: 'ARTICLE', content: 'A'.repeat(40_000) }])
    expect(plan.context.truncated).toBe(true)
    expect(plan.context.text.length).toBeGreaterThan(0)
  })

  it('rejects missing skill, disabled provider and invalid explicit model before provider I/O', () => {
    const runtime = new LlmRuntime(new OpenAiCompatibleLlmAdapter(settingsRepository()))
    expect(() => runtime.prepare({ skillId: 'missing' })).toThrow('Skill 不存在或未启用')
    expect(() => new LlmRuntime(new OpenAiCompatibleLlmAdapter(settingsRepository(provider({ enabled: false })))).prepare()).toThrow('所选 AI 服务未启用')
    expect(() => runtime.prepare({ model: 'not-configured' })).toThrow('所选模型不属于当前 AI Provider')
  })

  it('returns a snapshot that is not mutated by later caller profile changes', () => {
    const runtime = new LlmRuntime(new OpenAiCompatibleLlmAdapter(settingsRepository()))
    const enabledToolIds = new Set<string>()
    const reasoning = { effort: 'LOW' as const, showReasoning: true }
    const profile = { enabledToolIds, reasoning, customInstructions: 'first' }
    const plan = runtime.prepare(profile)
    enabledToolIds.add('later')
    reasoning.showReasoning = false
    profile.customInstructions = 'later'

    expect(plan.reasoning.preference).toEqual({ effort: 'LOW', showReasoning: true })
    expect(plan.customInstructions).toBe('first')
    expect(plan.tools).toEqual([])
  })
})
