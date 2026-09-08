import { describe, expect, it, vi } from 'vitest'
import type { AiChatCompletionDeltaListener, AiChatCompletionResult, AiChatMessage, AiChatToolDefinition, AiRuntimeConfig } from '../ai/openai-compatible-provider'
import { AiSettingsRepository } from '../ai/ai-settings-repository'
import { MemorySecretStore } from '../security/secret-store'
import { DesktopDatabase } from '../database/database'
import { LlmChatRepository } from './chat-repository'
import { OpenAiCompatibleLlmAdapter } from './openai-compatible-llm-adapter'
import { LlmRuntime } from './execution-runtime'
import { LlmContextComposer } from './context-composer'
import { LlmToolRuntime, type LlmTool } from './tool-runtime'
import { LlmExecutionRegistry } from './execution-registry'
import { LlmChatExecutionService, stripHistoricalCitationProtocolTokens } from './chat-execution-service'
import { buildArticleEvidenceBlocks } from './evidence-block-builder'
import type { LlmExecutionEvent } from '../../shared/llm-ipc'
import type { WebSearchRouter, PreparedWebSearchExecution } from '../search/web-search-router'
import type { WebSearchRouteResult } from '../../shared/web-search'
import {
  CURRENT_ARTICLE_CONTEXT_PRIORITY,
  additionalArticleContextPriority,
  webSearchContextPriority
} from './context-priority'

type StreamHandler = (input: {
  messages: readonly AiChatMessage[]
  config: AiRuntimeConfig
  onDelta: AiChatCompletionDeltaListener
  tools: readonly AiChatToolDefinition[]
  signal?: AbortSignal
}) => Promise<AiChatCompletionResult>

class QueueTransport {
  readonly calls: Array<{ messages: readonly AiChatMessage[]; tools: readonly AiChatToolDefinition[] }> = []
  constructor(private readonly handlers: StreamHandler[]) {}

  async streamChatDetailed(
    messages: readonly AiChatMessage[],
    config: AiRuntimeConfig,
    onDelta: AiChatCompletionDeltaListener,
    tools: readonly AiChatToolDefinition[] = [],
    signal?: AbortSignal
  ): Promise<AiChatCompletionResult> {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
    const handler = this.handlers.shift()
    if (!handler) throw new Error('unexpected provider round')
    return handler({ messages, config, onDelta, tools, signal })
  }
}

function setup(transport: QueueTransport, webSearchRouter?: WebSearchRouter): {
  database: DesktopDatabase
  repository: LlmChatRepository
  toolRuntime: LlmToolRuntime
  registry: LlmExecutionRegistry
  service: LlmChatExecutionService
} {
  const database = new DesktopDatabase(':memory:')
  const repository = new LlmChatRepository(database.connection)
  const settings = new AiSettingsRepository(database.connection, new MemorySecretStore())
  const providerId = settings.current().providers[0]!.id
  settings.setEnabled(true)
  settings.updateProvider({
    id: providerId,
    endpoint: 'https://example.com/v1',
    models: ['test-model'],
    defaultModel: 'test-model',
    streamingCapabilityOverride: 'ENABLED',
    toolCallingCapabilityOverride: 'ENABLED'
  })
  const adapter = new OpenAiCompatibleLlmAdapter(settings)
  const toolRuntime = new LlmToolRuntime()
  const runtime = new LlmRuntime(adapter, new LlmContextComposer(), toolRuntime)
  const registry = new LlmExecutionRegistry()
  return {
    database,
    repository,
    toolRuntime,
    registry,
    service: new LlmChatExecutionService(repository, runtime, transport, toolRuntime, registry, webSearchRouter)
  }
}

async function waitForPendingToolCall(repository: LlmChatRepository, conversationId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = repository.getToolCalls(conversationId).find((call) => call.status === 'PENDING_APPROVAL')
    if (pending) return pending
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for pending tool approval')
}

function preparedSearch(required = false): PreparedWebSearchExecution {
  return {
    plan: {
      decision: { status: 'TRIGGERED', required, triggered: true },
      mode: required ? 'FORCE' : 'AUTO',
      query: 'Article — latest developments',
      providerId: 'search-provider',
      providerName: 'Fixture Search',
      providerKind: 'KEENABLE',
      request: { query: 'Article — latest developments', maxResults: 5, includeContent: false, timeoutMs: required ? 12_000 : 4_000 },
      preflightErrorMessage: null
    },
    providerSnapshot: {
      profile: {
        id: 'search-provider', kind: 'KEENABLE', name: 'Fixture Search', endpoint: 'https://search.example/api',
        enabled: true, hasApiKey: false, apiKeyLength: 0
      },
      apiKey: ''
    }
  }
}

function searchRouter(result: WebSearchRouteResult | ((signal?: AbortSignal) => Promise<WebSearchRouteResult>)): WebSearchRouter {
  return {
    executePreparedSearch: async (_prepared: PreparedWebSearchExecution, signal?: AbortSignal) =>
      typeof result === 'function' ? result(signal) : result
  } as unknown as WebSearchRouter
}

function successfulSearch(): WebSearchRouteResult {
  return {
    status: 'SUCCESS',
    providerName: 'Fixture Search',
    errorMessage: null,
    requiredFailure: false,
    response: {
      providerId: 'search-provider',
      providerName: 'Fixture Search',
      backendKind: 'RAW_SEARCH',
      answer: null,
      results: [{
        title: 'Fresh source',
        url: 'https://news.example/fresh',
        snippet: 'A fresh fact from the web.',
        publishedAt: '2026-09-01T00:00:00Z',
        source: 'news.example',
        content: null
      }]
    }
  }
}

function createConversation(repository: LlmChatRepository): { conversationId: string; assistantMessageId: string } {
  const conversationId = 'conversation-1'
  const assistantMessageId = 'assistant-1'
  repository.createConversation({ id: conversationId, title: 'Test', articleId: 'article-1', articleTitle: 'Article', now: 10 })
  repository.appendMessage(conversationId, { id: 'user-1', role: 'USER', content: 'What happened?', now: 20 })
  repository.appendMessage(conversationId, { id: assistantMessageId, role: 'ASSISTANT', content: '', status: 'STREAMING', now: 30 })
  return { conversationId, assistantMessageId }
}

function readOnlyTool(id = 'lookup'): LlmTool {
  return {
    descriptor: {
      id,
      name: id,
      description: 'Look up local data',
      source: 'ORIGREAD_INTERNAL',
      sourceId: 'origread',
      risk: 'READ_ONLY',
      enabled: true,
      inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
      outputSchema: null
    },
    execute: async () => ({ status: 'SUCCESS', content: '{"value":"tool-result"}' })
  }
}

describe('LlmChatExecutionService D2 pipeline', () => {
  it('removes prior-turn request-local citation tokens before reusing assistant text as provider history', () => {
    expect(stripHistoricalCitationProtocolTokens('First claim [[E1]], second claim [[E12]].')).toBe('First claim, second claim.')
    expect(stripHistoricalCitationProtocolTokens('结论一 [[E2]]，结论二[[E3]]。')).toBe('结论一，结论二。')
    expect(stripHistoricalCitationProtocolTokens('No citation tokens here.')).toBe('No citation tokens here.')
  })

  it('records D8.1 end-to-end performance without logging request content or secrets', async () => {
    const transport = new QueueTransport([
      async ({ config }) => {
        config.onTiming?.({ metric: 'TTFB', elapsedMs: 2.1 })
        config.onTiming?.({ metric: 'first_sse', elapsedMs: 3.2 })
        return {
          content: '', reasoning: null, finishReason: 'tool_calls',
          toolCalls: [{ id: 'provider-perf-tool', name: 'perf_lookup', argumentsJson: '{"id":1}' }]
        }
      },
      async ({ config, onDelta }) => {
        config.onTiming?.({ metric: 'TTFB', elapsedMs: 1.1 })
        config.onTiming?.({ metric: 'first_sse', elapsedMs: 1.4 })
        config.onTiming?.({ metric: 'TTFR', elapsedMs: 2.2 })
        onDelta({ content: '', reasoning: 'checking', finishReason: null, toolCalls: [] })
        config.onTiming?.({ metric: 'TTFC', elapsedMs: 3.3 })
        for (let index = 0; index < 40; index += 1) {
          onDelta({ content: `chunk-${index} `, reasoning: '', finishReason: null, toolCalls: [] })
        }
        return { content: 'done', reasoning: 'checking', finishReason: 'stop', toolCalls: [] }
      }
    ])
    const router = searchRouter(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 8))
      return successfulSearch()
    })
    const env = setup(transport, router)
    env.toolRuntime.register({
      descriptor: {
        id: 'perf_lookup', name: 'perf_lookup', description: 'Performance fixture lookup', source: 'ORIGREAD_INTERNAL',
        sourceId: 'origread', risk: 'READ_ONLY', enabled: true,
        inputSchema: { type: 'object', properties: { id: { type: 'number' } } }, outputSchema: null
      },
      execute: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 6))
        return { status: 'SUCCESS', content: '{"value":"fixture"}' }
      }
    })
    const identity = createConversation(env.repository)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    await env.service.execute({
      ...identity,
      requestId: 'request-perf',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['perf_lookup']) },
      webSearch: preparedSearch()
    }, () => undefined)

    const perfCall = info.mock.calls.find(([prefix]) => prefix === '[OrigRead][LLM Perf]')
    expect(perfCall).toBeDefined()
    const perf = JSON.parse(String(perfCall?.[1])) as Record<string, unknown>
    expect(perf).toMatchObject({
      task: 'chat',
      provider_rounds: 2,
      tool_calls: 1,
      streaming_snapshot_interval_ms: 300,
      outcome: 'complete'
    })
    expect(Number(perf.search_ms)).toBeGreaterThanOrEqual(5)
    expect(Number(perf.search_to_model_gap_ms)).toBeGreaterThanOrEqual(0)
    expect(Number(perf.provider_first_start_ms)).toBeGreaterThanOrEqual(Number(perf.search_ms))
    expect(Number(perf.TTFB_ms)).toBeGreaterThanOrEqual(0)
    expect(Number(perf.first_sse_ms)).toBeGreaterThanOrEqual(Number(perf.TTFB_ms))
    expect(Number(perf.TTFR_ms)).toBeGreaterThan(Number(perf.first_sse_ms))
    expect(Number(perf.TTFC_ms)).toBeGreaterThan(Number(perf.TTFR_ms))
    expect(Number(perf.tool_execution_total_ms)).toBeGreaterThanOrEqual(4)
    expect(Number(perf.tool_execution_max_ms)).toBeGreaterThanOrEqual(4)
    expect(Number(perf.streaming_snapshot_writes)).toBeLessThanOrEqual(2)
    expect(Number(perf.total_ms)).toBeGreaterThan(0)
    const serialized = String(perfCall?.[1])
    expect(serialized).not.toContain('What happened?')
    expect(serialized).not.toContain('fixture')
    expect(serialized).not.toContain('provider-perf-tool')
    info.mockRestore()
    env.database.close()
  })

  it('streams, freezes evidence, resolves valid citations, and persists a terminal assistant message', async () => {
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        expect(messages[0]?.role).toBe('system')
        expect(messages[0]?.content).toContain('[ORIGREAD_EVIDENCE id="E1"]')
        onDelta({ content: 'Answer ', reasoning: 'checked source', finishReason: null, toolCalls: [] })
        onDelta({ content: '[[E1]]', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Answer [[E1]]', reasoning: 'checked source', finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const identity = createConversation(env.repository)
    const blocks = buildArticleEvidenceBlocks('<h2>Facts</h2><p>Revenue rose 20%.</p>', {
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article'
    })
    const events: LlmExecutionEvent[] = []

    const result = await env.service.execute({
      ...identity,
      requestId: 'request-1',
      ownerId: 'renderer-1',
      contextItems: [{
        id: 'article:article-1',
        type: 'ARTICLE',
        content: blocks.map((block) => block.content).join('\n\n'),
        title: 'Article',
        sourceId: 'https://example.com/article',
        internalArticleId: 'article-1',
        reserveEvidenceBudget: true,
        evidenceBlocks: blocks,
        priority: 100
      }],
      evidenceGroups: [{ contextId: 'article:article-1', blocks }]
    }, (event) => events.push(event))

    expect(result).toMatchObject({
      content: 'Answer',
      reasoning: 'checked source',
      status: 'COMPLETE',
      finishReason: 'STOP',
      model: 'test-model',
      tokenUsageEstimated: true
    })
    expect(result.providerId).toBeTruthy()
    expect(result.promptTokens).toBeGreaterThan(0)
    expect(result.completionTokens).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    const refs = env.repository.getContextRefsForAssistant(identity.assistantMessageId)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ includedInPrompt: true, articleId: 'article-1' })
    expect(env.repository.getEvidenceBlocks(refs[0]!.id)).toHaveLength(2)
    expect(env.repository.getCitationRefsForAssistant(identity.assistantMessageId)).toMatchObject([
      { protocolId: 'E1', displayOrder: 1, targetKind: 'EVIDENCE_BLOCK' }
    ])
    const annotations = env.repository.getCitationAnnotationsForAssistant(identity.assistantMessageId)
    expect(annotations).toMatchObject([{
      canonicalInsertionOffset: 6,
      occurrenceOrdinal: 0
    }])
    expect(env.repository.getCitationAnnotationRefsForAssistant(identity.assistantMessageId)).toMatchObject([{
      annotationId: annotations[0]!.id,
      citationRefId: env.repository.getCitationRefsForAssistant(identity.assistantMessageId)[0]!.id,
      refOrdinal: 0
    }])
    expect(events.map((event) => event.type)).toEqual(['STARTED', 'REASONING_DELTA', 'CONTENT_DELTA', 'CONTENT_DELTA', 'TERMINAL'])
    expect(events.at(-1)).toMatchObject({ type: 'TERMINAL', finishReason: 'STOP' })
    env.database.close()
  })

  it('canonicalizes and preserves valid citations when generation is stopped or errors after partial output', async () => {
    for (const terminal of ['stopped', 'error'] as const) {
      const transport = new QueueTransport([
        async ({ onDelta }) => {
          onDelta({ content: 'Partial answer [[E1]]', reasoning: '', finishReason: null, toolCalls: [] })
          if (terminal === 'stopped') throw new DOMException('cancelled', 'AbortError')
          throw new Error('provider failed after partial output')
        }
      ])
      const env = setup(transport)
      const identity = createConversation(env.repository)
      const blocks = buildArticleEvidenceBlocks('<p>Partial-output evidence.</p>', {
        articleId: 'article-1',
        sourceUrl: 'https://example.com/article'
      })

      const result = await env.service.execute({
        ...identity,
        requestId: `request-partial-${terminal}`,
        ownerId: 'renderer-1',
        contextItems: [{
          id: 'article:article-1',
          type: 'ARTICLE',
          content: blocks.map((block) => block.content).join('\n\n'),
          sourceId: 'https://example.com/article',
          internalArticleId: 'article-1',
          reserveEvidenceBudget: true,
          evidenceBlocks: blocks,
          priority: 100
        }],
        evidenceGroups: [{ contextId: 'article:article-1', blocks }]
      }, () => undefined)

      expect(result).toMatchObject({
        content: 'Partial answer',
        status: terminal === 'stopped' ? 'STOPPED' : 'ERROR'
      })
      expect(env.repository.getCitationRefsForAssistant(identity.assistantMessageId)).toMatchObject([
        { protocolId: 'E1', quoteSnapshot: 'Partial-output evidence.' }
      ])
      expect(env.repository.getCitationAnnotationsForAssistant(identity.assistantMessageId)).toHaveLength(1)
      env.database.close()
    }
  })

  it('keeps second-turn citation IDs scoped to the new request instead of colliding with prior assistant tokens', async () => {
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        const historicalAssistant = messages.find((message) => message.role === 'assistant')
        expect(historicalAssistant?.content).toBe('Earlier supported claim.')
        expect(historicalAssistant?.content).not.toContain('[[E1]]')
        expect(messages[0]?.content).toContain('[ORIGREAD_EVIDENCE id="E1"]')
        onDelta({ content: 'Follow-up answer [[E1]]', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Follow-up answer [[E1]]', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const conversationId = 'conversation-multi-turn-citations'
    env.repository.createConversation({ id: conversationId, title: 'Citation follow-up', articleId: 'article-1', articleTitle: 'Article', now: 10 })
    env.repository.appendMessage(conversationId, { id: 'user-old', role: 'USER', content: 'First question', now: 20 })
    env.repository.appendMessage(conversationId, {
      id: 'assistant-old',
      role: 'ASSISTANT',
      content: 'Earlier supported claim [[E1]].',
      status: 'COMPLETE',
      now: 30
    })
    env.repository.appendMessage(conversationId, { id: 'user-new', role: 'USER', content: 'Follow up', now: 40 })
    env.repository.appendMessage(conversationId, { id: 'assistant-new', role: 'ASSISTANT', content: '', status: 'STREAMING', now: 50 })
    const blocks = buildArticleEvidenceBlocks('<p>Current-turn evidence.</p>', {
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article'
    })

    await env.service.execute({
      conversationId,
      assistantMessageId: 'assistant-new',
      requestId: 'request-second-turn',
      ownerId: 'renderer-1',
      contextItems: [{
        id: 'article:article-1',
        type: 'ARTICLE',
        content: blocks.map((block) => block.content).join('\n\n'),
        title: 'Article',
        sourceId: 'https://example.com/article',
        internalArticleId: 'article-1',
        reserveEvidenceBudget: true,
        evidenceBlocks: blocks,
        priority: 100
      }],
      evidenceGroups: [{ contextId: 'article:article-1', blocks }]
    }, () => undefined)

    expect(env.repository.getCitationRefsForAssistant('assistant-new')).toMatchObject([
      { protocolId: 'E1', displayOrder: 1, quoteSnapshot: 'Current-turn evidence.' }
    ])
    env.database.close()
  })

  it('reissues historical COMPLETE Tool results with current request-local citation IDs', async () => {
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        const historicalTool = messages.find((message) => message.role === 'tool')
        expect(historicalTool?.content).toContain('[ORIGREAD_EVIDENCE id="E2"]')
        expect(historicalTool?.content).toContain('Historical tool evidence')
        onDelta({ content: 'Follow-up from tool [[E2]]', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Follow-up from tool [[E2]]', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const conversationId = 'conversation-historical-tool-citation'
    env.repository.createConversation({ id: conversationId, title: 'Tool history', articleId: 'article-1', articleTitle: 'Article', now: 10 })
    env.repository.appendMessage(conversationId, { id: 'user-old-tool', role: 'USER', content: 'Use a tool', now: 20 })
    env.repository.appendMessage(conversationId, {
      id: 'assistant-old-tool', role: 'ASSISTANT', content: 'Earlier tool-backed answer', status: 'COMPLETE', now: 30
    })
    env.repository.appendToolCalls([{
      id: 'tool-call-old',
      conversationId,
      assistantMessageId: 'assistant-old-tool',
      providerCallId: 'provider-tool-old',
      toolId: 'historical-tool',
      apiName: 'historical_tool',
      argumentsJson: '{}',
      status: 'COMPLETE',
      resultContent: 'Historical tool evidence',
      errorMessage: null,
      createdAt: 31,
      updatedAt: 32
    }])
    env.repository.appendMessage(conversationId, { id: 'user-new-tool', role: 'USER', content: 'Use that result', now: 40 })
    env.repository.appendMessage(conversationId, { id: 'assistant-new-tool', role: 'ASSISTANT', content: '', status: 'STREAMING', now: 50 })
    const blocks = buildArticleEvidenceBlocks('<p>Current article evidence.</p>', {
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article'
    })

    const result = await env.service.execute({
      conversationId,
      assistantMessageId: 'assistant-new-tool',
      requestId: 'request-historical-tool-citation',
      ownerId: 'renderer-1',
      contextItems: [{
        id: 'article:article-1',
        type: 'ARTICLE',
        content: blocks.map((block) => block.content).join('\n\n'),
        sourceId: 'https://example.com/article',
        internalArticleId: 'article-1',
        reserveEvidenceBudget: true,
        evidenceBlocks: blocks,
        priority: 100
      }],
      evidenceGroups: [{ contextId: 'article:article-1', blocks }]
    }, () => undefined)

    expect(result.content).toBe('Follow-up from tool')
    expect(env.repository.getCitationRefsForAssistant('assistant-new-tool')).toMatchObject([
      {
        protocolId: 'E2',
        quoteSnapshot: 'Historical tool evidence',
        locatorSnapshot: { sourceKind: 'TOOL_RESULT', toolCallId: 'tool-call-old' }
      }
    ])
    env.database.close()
  })

  it('does not replay ERROR assistants or their completed Tool results into the next request', async () => {
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        expect(messages.some((message) => message.role === 'assistant' && message.content.includes('failed answer'))).toBe(false)
        expect(messages.some((message) => message.role === 'tool' && String(message.content).includes('failed tool evidence'))).toBe(false)
        onDelta({ content: 'Recovered answer', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Recovered answer', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const conversationId = 'conversation-error-history'
    env.repository.createConversation({ id: conversationId, title: 'Error history', articleId: 'article-1', articleTitle: 'Article', now: 10 })
    env.repository.appendMessage(conversationId, { id: 'user-old', role: 'USER', content: 'Old request', now: 20 })
    env.repository.appendMessage(conversationId, {
      id: 'assistant-error', role: 'ASSISTANT', content: 'failed answer', status: 'ERROR', now: 30
    })
    env.repository.appendToolCalls([{
      id: 'tool-call-error-history',
      conversationId,
      assistantMessageId: 'assistant-error',
      providerCallId: 'provider-tool-error-history',
      toolId: 'historical-tool',
      apiName: 'historical_tool',
      argumentsJson: '{}',
      status: 'COMPLETE',
      resultContent: 'failed tool evidence',
      errorMessage: null,
      createdAt: 31,
      updatedAt: 32
    }])
    env.repository.appendMessage(conversationId, { id: 'user-new', role: 'USER', content: 'Try again', now: 40 })
    env.repository.appendMessage(conversationId, { id: 'assistant-new', role: 'ASSISTANT', content: '', status: 'STREAMING', now: 50 })

    const result = await env.service.execute({
      conversationId,
      assistantMessageId: 'assistant-new',
      requestId: 'request-error-history',
      ownerId: 'renderer-1'
    }, () => undefined)

    expect(result).toMatchObject({ content: 'Recovered answer', status: 'COMPLETE' })
    expect(env.repository.getCitationRefsForAssistant('assistant-new')).toEqual([])
    env.database.close()
  })

  it('executes a trusted read-only tool, persists its terminal state, and continues the same provider request', async () => {
    const transport = new QueueTransport([
      async ({ tools }) => {
        expect(tools.map((tool) => tool.name)).toEqual(['lookup'])
        return {
          content: '', reasoning: null, finishReason: 'tool_calls',
          toolCalls: [{ id: 'provider-call-1', name: 'lookup', argumentsJson: '{"id":1}' }]
        }
      },
      async ({ messages, onDelta }) => {
        expect(messages.at(-2)).toEqual({
          role: 'assistant', content: '',
          toolCalls: [{ id: 'provider-call-1', name: 'lookup', argumentsJson: '{"id":1}' }]
        })
        expect(messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'provider-call-1' })
        expect(String(messages.at(-1)?.content)).toContain('[ORIGREAD_EVIDENCE id="E1"]')
        expect(String(messages.at(-1)?.content)).toContain('{"value":"tool-result"}')
        onDelta({ content: 'Final', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Final', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    env.toolRuntime.register(readOnlyTool())
    const identity = createConversation(env.repository)

    const result = await env.service.execute({
      ...identity,
      requestId: 'request-tool',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['lookup']) }
    }, () => undefined)

    expect(result).toMatchObject({ content: 'Final', status: 'COMPLETE', finishReason: 'STOP' })
    expect(env.repository.getToolCalls(identity.conversationId)).toMatchObject([
      { providerCallId: 'provider-call-1', toolId: 'lookup', status: 'COMPLETE', resultContent: '{"value":"tool-result"}' }
    ])
    expect(transport.calls).toHaveLength(2)
    env.database.close()
  })

  it('stops promptly when a Tool ignores AbortSignal and waits for its drain before the next request', async () => {
    let markToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve })
    let releaseTool!: () => void
    const toolRelease = new Promise<void>((resolve) => { releaseTool = resolve })
    const transport = new QueueTransport([
      async () => ({
        content: '', reasoning: null, finishReason: 'tool_calls',
        toolCalls: [{ id: 'provider-stuck-tool', name: 'slow_lookup', argumentsJson: '{}' }]
      }),
      async ({ onDelta }) => {
        onDelta({ content: 'Second request completed', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Second request completed', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const slowTool = readOnlyTool('slow_lookup')
    slowTool.execute = async () => {
      markToolStarted()
      await toolRelease // Deliberately ignores the AbortSignal supplied by ToolRuntime.
      return { status: 'SUCCESS', content: 'late result that must be discarded' }
    }
    env.toolRuntime.register(slowTool)
    const identity = createConversation(env.repository)

    const first = env.service.execute({
      ...identity,
      requestId: 'request-stuck-tool',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['slow_lookup']) }
    }, () => undefined)
    await toolStarted

    const stopStartedAt = performance.now()
    expect(env.registry.cancel('request-stuck-tool')).toBe(true)
    const stopped = await Promise.race([
      first,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Stop waited for the ignored Tool drain')), 250))
    ])
    expect(performance.now() - stopStartedAt).toBeLessThan(250)
    expect(stopped).toMatchObject({ status: 'STOPPED', finishReason: 'CANCELLED' })
    expect(env.repository.getToolCalls(identity.conversationId)).toMatchObject([
      { providerCallId: 'provider-stuck-tool', status: 'ERROR', errorMessage: expect.stringContaining('cancelled') }
    ])

    env.repository.appendMessage(identity.conversationId, { id: 'user-2', role: 'USER', content: 'Continue safely.', now: 40 })
    env.repository.appendMessage(identity.conversationId, { id: 'assistant-2', role: 'ASSISTANT', content: '', status: 'STREAMING', now: 50 })
    const second = env.service.execute({
      conversationId: identity.conversationId,
      assistantMessageId: 'assistant-2',
      requestId: 'request-after-stuck-tool',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['slow_lookup']) }
    }, () => undefined)

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(transport.calls).toHaveLength(1)
    releaseTool()
    await expect(second).resolves.toMatchObject({ content: 'Second request completed', status: 'COMPLETE', finishReason: 'STOP' })
    expect(transport.calls).toHaveLength(2)
    env.database.close()
  })

  it('waits for risky-tool denial, never executes it, and returns denial as a tool result before model continuation', async () => {
    let executions = 0
    const transport = new QueueTransport([
      async () => ({
        content: '', reasoning: 'need permission', finishReason: 'tool_calls',
        toolCalls: [{ id: 'provider-call-write', name: 'write_note', argumentsJson: '{}' }]
      }),
      async ({ messages, onDelta }) => {
        expect(messages.slice(-2)).toEqual([
          { role: 'assistant', content: '', toolCalls: [{ id: 'provider-call-write', name: 'write_note', argumentsJson: '{}' }] },
          { role: 'tool', toolCallId: 'provider-call-write', content: 'Tool execution was denied by the user.' }
        ])
        onDelta({ content: 'I will not change it.', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'I will not change it.', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const risky = readOnlyTool('write_note')
    risky.descriptor.risk = 'WRITE'
    risky.execute = async () => { executions += 1; return { status: 'SUCCESS', content: 'unexpected' } }
    env.toolRuntime.register(risky)
    const identity = createConversation(env.repository)
    const events: LlmExecutionEvent[] = []

    const running = env.service.execute({
      ...identity,
      requestId: 'request-write',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['write_note']) }
    }, (event) => events.push(event))

    const pending = await waitForPendingToolCall(env.repository, identity.conversationId)
    expect(executions).toBe(0)
    expect(env.service.toolActivity(identity.conversationId)[0]).toMatchObject({ toolCallId: pending.id, risk: 'WRITE', status: 'PENDING_APPROVAL' })
    expect(env.service.resolveToolApproval(pending.id, 'DENY')).toBe(true)
    const result = await running
    expect(result).toMatchObject({ content: 'I will not change it.', status: 'COMPLETE', finishReason: 'STOP' })
    expect(env.repository.getToolCalls(identity.conversationId)).toMatchObject([{ status: 'DENIED', resultContent: 'Tool execution was denied by the user.' }])
    expect(events).toContainEqual(expect.objectContaining({ type: 'TOOL_STATE', status: 'PENDING_APPROVAL' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'TOOL_STATE', status: 'DENIED' }))
    expect(events.at(-1)).toMatchObject({ type: 'TERMINAL', finishReason: 'STOP' })
    expect(transport.calls).toHaveLength(2)
    env.database.close()
  })

  it('executes a risky tool only after approval and continues with its result', async () => {
    let executions = 0
    const transport = new QueueTransport([
      async () => ({
        content: '', reasoning: null, finishReason: 'tool_calls',
        toolCalls: [{ id: 'provider-call-write', name: 'write_note', argumentsJson: '{"title":"safe","apiKey":"do-not-render"}' }]
      }),
      async ({ messages, onDelta }) => {
        expect(messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'provider-call-write' })
        expect(String(messages.at(-1)?.content)).toContain('[ORIGREAD_EVIDENCE id="E1"]')
        expect(String(messages.at(-1)?.content)).toContain('written')
        onDelta({ content: 'Done', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Done', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const risky = readOnlyTool('write_note')
    risky.descriptor.risk = 'WRITE'
    risky.execute = async () => { executions += 1; return { status: 'SUCCESS', content: 'written' } }
    env.toolRuntime.register(risky)
    const identity = createConversation(env.repository)

    const running = env.service.execute({
      ...identity,
      requestId: 'request-write-approved',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['write_note']) }
    }, () => undefined)
    const pending = await waitForPendingToolCall(env.repository, identity.conversationId)
    expect(executions).toBe(0)
    const activity = env.service.toolActivity(identity.conversationId)[0]!
    expect(activity.argumentsPreview).toContain('safe')
    expect(activity.argumentsPreview).toContain('[redacted]')
    expect(activity.argumentsPreview).not.toContain('do-not-render')
    expect(env.service.resolveToolApproval(pending.id, 'APPROVE')).toBe(true)
    const result = await running

    expect(executions).toBe(1)
    expect(result).toMatchObject({ content: 'Done', finishReason: 'STOP' })
    expect(env.repository.getToolCalls(identity.conversationId)).toMatchObject([{ status: 'COMPLETE', resultContent: 'written' }])
    expect(env.service.resolveToolApproval(pending.id, 'APPROVE')).toBe(false)
    env.database.close()
  })

  it('freezes an automatic MCP Tool result as citation-ready evidence with tool/server provenance', async () => {
    const transport = new QueueTransport([
      async () => ({
        content: '', reasoning: null, finishReason: 'tool_calls',
        toolCalls: [{ id: 'provider-call-mcp', name: 'lookup_release', argumentsJson: '{}' }]
      }),
      async ({ messages, onDelta }) => {
        const toolMessage = messages.at(-1)
        expect(toolMessage).toMatchObject({ role: 'tool', toolCallId: 'provider-call-mcp' })
        expect(String(toolMessage?.content)).toContain('[ORIGREAD_EVIDENCE id="E1"]')
        expect(String(toolMessage?.content)).toContain('Release evidence from MCP')
        onDelta({ content: 'The release is ready [[E1]].', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'The release is ready [[E1]].', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport)
    const tool = readOnlyTool('lookup_release')
    tool.descriptor.source = 'MCP'
    tool.descriptor.sourceId = 'mcp-server-1'
    tool.descriptor.description = 'Release lookup'
    tool.execute = async () => ({ status: 'SUCCESS', content: 'Release evidence from MCP' })
    env.toolRuntime.register(tool)
    const identity = createConversation(env.repository)

    const running = env.service.execute({
      ...identity,
      requestId: 'request-mcp-citation',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['lookup_release']) }
    }, () => undefined)
    const pending = await waitForPendingToolCall(env.repository, identity.conversationId)
    expect(env.service.toolActivity(identity.conversationId)[0]).toMatchObject({
      toolCallId: pending.id,
      risk: 'READ_ONLY',
      source: 'MCP',
      status: 'PENDING_APPROVAL'
    })
    expect(env.service.resolveToolApproval(pending.id, 'APPROVE')).toBe(true)
    const result = await running

    expect(result.content).toBe('The release is ready.')
    const toolRef = env.repository.getContextRefsForAssistant(identity.assistantMessageId).find((ref) => ref.type === 'TOOL_RESULT')
    expect(toolRef).toMatchObject({ sourceId: 'mcp-server-1', contentSnapshot: 'Release evidence from MCP', includedInPrompt: true })
    const blocks = env.repository.getEvidenceBlocks(toolRef!.id)
    expect(blocks).toMatchObject([{
      kind: 'TOOL_RESULT',
      textSnapshot: 'Release evidence from MCP',
      locator: {
        sourceKind: 'TOOL_RESULT',
        toolId: 'lookup_release',
        toolName: 'Release lookup',
        toolSourceId: 'mcp-server-1'
      }
    }])
    expect(env.repository.getCitationRefsForAssistant(identity.assistantMessageId)).toMatchObject([{
      protocolId: 'E1', contextRefId: toolRef!.id, evidenceBlockId: blocks[0]!.id,
      locatorSnapshot: { sourceKind: 'TOOL_RESULT', toolSourceId: 'mcp-server-1' }
    }])
    env.database.close()
  })

  it('cancels by requestId, preserves streamed partial output, and leaves no active registry entry', async () => {
    const transport = new QueueTransport([
      async ({ onDelta, signal }) => {
        onDelta({ content: 'partial', reasoning: '', finishReason: null, toolCalls: [] })
        return new Promise<AiChatCompletionResult>((_resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    ])
    const env = setup(transport)
    const identity = createConversation(env.repository)
    const events: LlmExecutionEvent[] = []

    const running = env.service.execute({
      ...identity,
      requestId: 'request-cancel',
      ownerId: 'renderer-1'
    }, (event) => events.push(event))
    await Promise.resolve()
    expect(env.registry.cancel('request-cancel')).toBe(true)
    const result = await running

    expect(result).toMatchObject({ content: 'partial', status: 'STOPPED', finishReason: 'CANCELLED' })
    expect(env.repository.getMessage(identity.assistantMessageId)).toMatchObject({ content: 'partial', status: 'STOPPED', finishReason: 'CANCELLED' })
    expect(events.at(-1)).toMatchObject({ type: 'TERMINAL', finishReason: 'CANCELLED' })
    expect(env.registry.size()).toBe(0)
    env.database.close()
  })

  it('persists successful Search evidence before generation and feeds only frozen Search context to the model', async () => {
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        const system = String(messages[0]?.content ?? '')
        expect(system).toContain('type=WEB_SEARCH_RESULT')
        expect(system).toContain('https://news.example/fresh')
        expect(system).toContain('A fresh fact from the web.')
        onDelta({ content: 'Fresh answer [[E1]]', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Fresh answer [[E1]]', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport, searchRouter(successfulSearch()))
    const identity = createConversation(env.repository)
    const events: LlmExecutionEvent[] = []

    const result = await env.service.execute({
      ...identity,
      requestId: 'request-search-success',
      ownerId: 'renderer-1',
      webSearch: preparedSearch(false)
    }, (event) => events.push(event))

    expect(result).toMatchObject({ webSearchStatus: 'SUCCESS', webSearchQuery: 'Article — latest developments', webSearchProviderName: 'Fixture Search' })
    const refs = env.repository.getContextRefsForAssistant(identity.assistantMessageId)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ type: 'WEB_SEARCH_RESULT', sourceUrl: 'https://news.example/fresh', includedInPrompt: true })
    expect(env.repository.getEvidenceBlocks(refs[0]!.id)).toMatchObject([
      { kind: 'SEARCH_RESULT', locator: { sourceKind: 'WEB_SEARCH', sourceUrl: 'https://news.example/fresh' } }
    ])
    expect(events.filter((event) => event.type === 'WEB_SEARCH_STATE')).toMatchObject([
      { status: 'TRIGGERED', query: 'Article — latest developments', providerName: 'Fixture Search' },
      { status: 'SUCCESS', resultCount: 1, providerName: 'Fixture Search' }
    ])
    env.database.close()
  })

  it('projects small Search context budgets into persisted USED/OMITTED ContextRefs without slicing evidence blocks', async () => {
    const route: WebSearchRouteResult = {
      status: 'SUCCESS',
      providerName: 'Fixture Search',
      errorMessage: null,
      requiredFailure: false,
      response: {
        providerId: 'search-provider',
        providerName: 'Fixture Search',
        backendKind: 'RAW_SEARCH',
        answer: null,
        results: [
          {
            title: 'Highest priority result',
            url: 'https://one.example/current',
            snippet: 'Primary current fact with concise supporting evidence.',
            publishedAt: '2026-09-01T00:00:00Z',
            source: 'one.example',
            content: null
          },
          {
            title: 'Second result',
            url: 'https://two.example/current',
            snippet: 'Secondary current fact with another concise supporting detail.',
            publishedAt: null,
            source: 'two.example',
            content: null
          },
          {
            title: 'Third result',
            url: 'https://three.example/current',
            snippet: 'Third current fact that should remain inspectable even when omitted from the prompt.',
            publishedAt: null,
            source: 'three.example',
            content: null
          }
        ]
      }
    }
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        const system = String(messages[0]?.content ?? '')
        expect(system).toContain('https://one.example/current')
        expect(system).not.toContain('https://three.example/current')
        onDelta({ content: 'Budgeted answer', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Budgeted answer', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport, searchRouter(route))
    const identity = createConversation(env.repository)

    await env.service.execute({
      ...identity,
      requestId: 'request-search-small-budget',
      ownerId: 'renderer-1',
      profile: { contextPolicy: { maxTokens: 180 } },
      webSearch: preparedSearch(false)
    }, () => undefined)

    const refs = env.repository.getContextRefsForAssistant(identity.assistantMessageId)
      .filter((ref) => ref.type === 'WEB_SEARCH_RESULT')
    expect(refs).toHaveLength(3)
    expect(refs.some((ref) => ref.includedInPrompt)).toBe(true)
    expect(refs.some((ref) => !ref.includedInPrompt)).toBe(true)
    expect(refs.every((ref) => !ref.truncatedInPrompt)).toBe(true)
    const omitted = refs.find((ref) => !ref.includedInPrompt)
    expect(omitted).toMatchObject({ sourceUrl: expect.stringMatching(/^https:\/\//), promptContentSnapshot: null })
    expect(omitted?.contentSnapshot).toContain('current fact')
    env.database.close()
  })

  it('applies D7.8 priorities so Web Search and current evidence survive before an oversized attachment', async () => {
    const route: WebSearchRouteResult = {
      status: 'SUCCESS',
      providerName: 'Fixture Search',
      errorMessage: null,
      requiredFailure: false,
      response: {
        providerId: 'search-provider',
        providerName: 'Fixture Search',
        backendKind: 'RAW_SEARCH',
        answer: null,
        results: [{
          title: 'Fresh compact source',
          url: 'https://fresh.example/result',
          snippet: 'Fresh compact evidence.',
          publishedAt: null,
          source: 'fresh.example',
          content: null
        }]
      }
    }
    const currentBlocks = buildArticleEvidenceBlocks(`<p>${'当'.repeat(80)}</p>`, {
      articleId: 'article-1',
      sourceUrl: 'https://example.com/current'
    })
    const attachmentBlocks = buildArticleEvidenceBlocks(`<p>${'附'.repeat(800)}</p>`, {
      articleId: 'article-2',
      sourceUrl: 'https://example.com/attached'
    })
    const transport = new QueueTransport([
      async ({ messages, onDelta }) => {
        const system = String(messages[0]?.content ?? '')
        expect(system).toContain('Fresh compact evidence.')
        expect(system).toContain('当'.repeat(20))
        expect(system).not.toContain('附'.repeat(20))
        onDelta({ content: 'Budget priority answer', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Budget priority answer', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const env = setup(transport, searchRouter(route))
    const identity = createConversation(env.repository)

    await env.service.execute({
      ...identity,
      requestId: 'request-d78-budget-order',
      ownerId: 'renderer-1',
      profile: { contextPolicy: { maxTokens: 500 } },
      contextItems: [
        {
          id: 'article:article-1:reader',
          type: 'ARTICLE',
          content: currentBlocks.map((block) => block.content).join('\n\n'),
          title: 'Current article',
          sourceId: 'https://example.com/current',
          internalArticleId: 'article-1',
          reserveEvidenceBudget: true,
          evidenceBlocks: currentBlocks,
          priority: CURRENT_ARTICLE_CONTEXT_PRIORITY
        },
        {
          id: 'article:article-2:reader',
          type: 'ARTICLE',
          content: attachmentBlocks.map((block) => block.content).join('\n\n'),
          title: 'Attached article',
          sourceId: 'https://example.com/attached',
          internalArticleId: 'article-2',
          reserveEvidenceBudget: false,
          evidenceBlocks: attachmentBlocks,
          priority: additionalArticleContextPriority(0)
        }
      ],
      evidenceGroups: [
        { contextId: 'article:article-1:reader', blocks: currentBlocks },
        { contextId: 'article:article-2:reader', blocks: attachmentBlocks }
      ],
      webSearch: preparedSearch(false)
    }, () => undefined)

    const refs = env.repository.getContextRefsForAssistant(identity.assistantMessageId)
    const search = refs.find((ref) => ref.type === 'WEB_SEARCH_RESULT')
    const current = refs.find((ref) => ref.articleId === 'article-1')
    const attachment = refs.find((ref) => ref.articleId === 'article-2')
    expect(search).toMatchObject({ priority: webSearchContextPriority(0), includedInPrompt: true })
    expect(current).toMatchObject({ priority: CURRENT_ARTICLE_CONTEXT_PRIORITY, includedInPrompt: true })
    expect(attachment).toMatchObject({ priority: additionalArticleContextPriority(0), includedInPrompt: false })
    expect(attachment?.promptContentSnapshot).toBeNull()
    env.database.close()
  })

  it('soft-falls back on AUTO Search failure but stops before the model on FORCE failure', async () => {
    const fallback: WebSearchRouteResult = {
      status: 'FAILED_FALLBACK', response: null, providerName: 'Fixture Search',
      errorMessage: 'Fixture Search unavailable', requiredFailure: false
    }
    const autoTransport = new QueueTransport([
      async ({ onDelta }) => {
        onDelta({ content: 'Answered without search', reasoning: '', finishReason: 'stop', toolCalls: [] })
        return { content: 'Answered without search', reasoning: null, finishReason: 'stop', toolCalls: [] }
      }
    ])
    const autoEnv = setup(autoTransport, searchRouter(fallback))
    const autoIdentity = createConversation(autoEnv.repository)
    const autoResult = await autoEnv.service.execute({
      ...autoIdentity, requestId: 'request-search-auto-fail', ownerId: 'renderer-1', webSearch: preparedSearch(false)
    }, () => undefined)
    expect(autoResult).toMatchObject({ status: 'COMPLETE', content: 'Answered without search', webSearchStatus: 'FAILED_FALLBACK', webSearchErrorMessage: 'Fixture Search unavailable' })
    expect(autoTransport.calls).toHaveLength(1)
    autoEnv.database.close()

    const forceFailure: WebSearchRouteResult = {
      status: 'FAILED_REQUIRED', response: null, providerName: 'Fixture Search',
      errorMessage: 'Fixture Search required request failed', requiredFailure: true
    }
    const forceTransport = new QueueTransport([])
    const forceEnv = setup(forceTransport, searchRouter(forceFailure))
    const forceIdentity = createConversation(forceEnv.repository)
    const forceEvents: LlmExecutionEvent[] = []
    const forceResult = await forceEnv.service.execute({
      ...forceIdentity, requestId: 'request-search-force-fail', ownerId: 'renderer-1', webSearch: preparedSearch(true)
    }, (event) => forceEvents.push(event))
    expect(forceResult).toMatchObject({ status: 'ERROR', finishReason: 'ERROR', webSearchStatus: 'FAILED_REQUIRED', webSearchErrorMessage: 'Fixture Search required request failed' })
    expect(forceTransport.calls).toHaveLength(0)
    expect(forceEvents).toContainEqual(expect.objectContaining({ type: 'WEB_SEARCH_STATE', status: 'FAILED_REQUIRED' }))
    forceEnv.database.close()
  })

  it('maps Stop during an in-flight Search to CANCELLED and never starts the model', async () => {
    let searchStarted!: () => void
    const started = new Promise<void>((resolve) => { searchStarted = resolve })
    const router = searchRouter(async (signal) => {
      searchStarted()
      return new Promise<WebSearchRouteResult>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const transport = new QueueTransport([])
    const env = setup(transport, router)
    const identity = createConversation(env.repository)
    const events: LlmExecutionEvent[] = []
    const running = env.service.execute({
      ...identity, requestId: 'request-stop-during-search', ownerId: 'renderer-1', webSearch: preparedSearch(false)
    }, (event) => events.push(event))
    await started
    expect(env.registry.cancel('request-stop-during-search')).toBe(true)
    const result = await running

    expect(result).toMatchObject({ status: 'STOPPED', finishReason: 'CANCELLED', webSearchStatus: 'CANCELLED' })
    expect(transport.calls).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'WEB_SEARCH_STATE', status: 'CANCELLED' }))
    env.database.close()
  })

  it('preserves Search SUCCESS and frozen evidence when Stop happens after Search but during model generation', async () => {
    let modelStarted!: () => void
    const started = new Promise<void>((resolve) => { modelStarted = resolve })
    const transport = new QueueTransport([
      async ({ signal }) => {
        modelStarted()
        return new Promise<AiChatCompletionResult>((_resolve, reject) => {
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    ])
    const env = setup(transport, searchRouter(successfulSearch()))
    const identity = createConversation(env.repository)
    const running = env.service.execute({
      ...identity, requestId: 'request-stop-after-search', ownerId: 'renderer-1', webSearch: preparedSearch(false)
    }, () => undefined)
    await started
    expect(env.registry.cancel('request-stop-after-search')).toBe(true)
    const result = await running

    expect(result).toMatchObject({ status: 'STOPPED', finishReason: 'CANCELLED', webSearchStatus: 'SUCCESS' })
    const refs = env.repository.getContextRefsForAssistant(identity.assistantMessageId)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ type: 'WEB_SEARCH_RESULT', includedInPrompt: true })
    expect(env.repository.getEvidenceBlocks(refs[0]!.id)).toHaveLength(1)
    env.database.close()
  })
})
