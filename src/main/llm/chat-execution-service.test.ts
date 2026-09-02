import { describe, expect, it } from 'vitest'
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
import { LlmChatExecutionService } from './chat-execution-service'
import { buildArticleEvidenceBlocks } from './evidence-block-builder'
import type { LlmExecutionEvent } from '../../shared/llm-ipc'
import type { WebSearchRouter, PreparedWebSearchExecution } from '../search/web-search-router'
import type { WebSearchRouteResult } from '../../shared/web-search'

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
      content: 'Answer [[E1]]',
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
    expect(events.map((event) => event.type)).toEqual(['STARTED', 'REASONING_DELTA', 'CONTENT_DELTA', 'CONTENT_DELTA', 'TERMINAL'])
    expect(events.at(-1)).toMatchObject({ type: 'TERMINAL', finishReason: 'STOP' })
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

    const result = await env.service.execute({
      ...identity,
      requestId: 'request-mcp-citation',
      ownerId: 'renderer-1',
      profile: { enabledToolIds: new Set(['lookup_release']) }
    }, () => undefined)

    expect(result.content).toBe('The release is ready [[E1]].')
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
