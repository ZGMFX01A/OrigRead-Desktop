import { describe, expect, it } from 'vitest'
import type { LlmExecutionPlan } from './execution-runtime'
import { validateLlmPromptBudget } from './prompt-budget-planner'

function plan(windowTokens: number, automaticToolCalling = false): LlmExecutionPlan {
  return {
    task: 'CHAT',
    providerId: 'p',
    providerName: 'Provider',
    model: 'model',
    runtimeConfig: { endpoint: 'https://example.com/v1', model: 'model', apiKey: '' },
    capability: {
      supportsStreaming: true,
      supportsToolCalling: automaticToolCalling,
      supportsNativeWebSearch: false,
      supportedReasoningEfforts: new Set(),
      reasoningParameterStyle: 'NONE',
      supportsReasoningOutput: false,
      supportsImageInput: false,
      supportsFileInput: false,
      supportsStructuredOutput: false,
      contextWindowTokens: windowTokens,
      outputTokenLimitStyle: 'MAX_TOKENS',
      strictStreamTermination: true
    },
    reasoning: {
      preference: { effort: 'AUTO', showReasoning: true },
      providerParameter: null,
      canDisplayReasoning: false,
      displayReasoning: false
    },
    tools: [],
    automaticToolCalling,
    context: { text: '', includedIds: [], omittedIds: [], truncated: false, renderedItems: [], decisions: [] },
    skillId: null,
    skillInstructions: null,
    customInstructions: null
  }
}

describe('validateLlmPromptBudget', () => {
  it('reserves one eighth of the window while clamping output reserve to 1K..8K', () => {
    expect(validateLlmPromptBudget(plan(4_096), [{ role: 'user', content: 'hi' }], []).outputReserveTokens).toBe(1_024)
    expect(validateLlmPromptBudget(plan(32_768), [{ role: 'user', content: 'hi' }], []).outputReserveTokens).toBe(4_096)
    expect(validateLlmPromptBudget(plan(1_000_000), [{ role: 'user', content: 'hi' }], []).outputReserveTokens).toBe(8_192)
  })

  it('counts complete tool topology and rejects requests that cannot safely fit', () => {
    const small: LlmExecutionPlan = {
      ...plan(4_096, true),
      tools: [{
        id: 'tool', name: 'lookup', description: 'D'.repeat(2_000), source: 'ORIGREAD_INTERNAL', sourceId: 'origread',
        risk: 'READ_ONLY', enabled: true, inputSchema: { type: 'object', description: 'S'.repeat(8_000) }, outputSchema: null
      }]
    }
    expect(() => validateLlmPromptBudget(
      small,
      [
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', argumentsJson: '{"q":"x"}' }] },
        { role: 'tool', toolCallId: 'call-1', content: 'R'.repeat(12_000) }
      ],
      [{ name: 'lookup', description: 'D'.repeat(2_000), parameters: { type: 'object', description: 'S'.repeat(8_000) } }]
    )).toThrow('请求超过模型上下文窗口')
  })
})
