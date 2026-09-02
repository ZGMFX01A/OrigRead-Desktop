import { createHash, randomUUID } from 'node:crypto'
import type { LlmContextItem } from '../../shared/llm-context'
import type {
  LlmContextRefRecord,
  LlmEvidenceBlockRecord,
  LlmMessageRecord,
  LlmToolCallRecord,
  LlmUnifiedFinishReason
} from '../../shared/llm-chat'
import { LLM_EVIDENCE_SCHEMA_VERSION } from '../../shared/llm-chat'
import type { LlmExecutionEvent, LlmExecutionIdentity, LlmToolActivityView, LlmToolApprovalDecision } from '../../shared/llm-ipc'
import { toolRequiresConfirmation, type LlmToolDescriptor } from '../../shared/llm-tool'
import type {
  AiChatCompletionDelta,
  AiChatCompletionResult,
  AiChatMessage,
  AiChatToolDefinition,
  OpenAiCompatibleProvider
} from '../ai/openai-compatible-provider'
import { buildCitationRefsFromAssistantOutput, prepareCitationProtocol, type LlmCitationEvidenceCandidate } from './citation-protocol'
import type { BuiltLlmEvidenceBlock } from './evidence-block-builder'
import type { LlmExecutionPlan, LlmExecutionProfile, LlmRuntime } from './execution-runtime'
import { LlmExecutionRegistry, serializeLlmIpcError } from './execution-registry'
import { normalizeLlmFinishReason } from './finish-reason'
import type { LlmChatRepository } from './chat-repository'
import type { LlmToolRuntime } from './tool-runtime'
import { validateLlmPromptBudget } from './prompt-budget-planner'
import { estimateLlmTokens } from './context-composer'
import { composeCustomInstructionsSystemPrompt, composeSkillSystemPrompt } from './prompt-customization'
import { buildLlmTaskBaseSystemPrompt } from './task-system-prompt'
import type { PreparedWebSearchExecution, WebSearchRouter } from '../search/web-search-router'
import { buildUnconsumedWebSearchContextRefs, buildWebSearchContext } from '../search/web-search-context'
import { buildLlmToolActivityView } from './tool-approval-view'

const MAX_AUTOMATIC_TOOL_ROUNDS = 8

export interface LlmExecutionEvidenceGroup {
  contextId: string
  blocks: readonly BuiltLlmEvidenceBlock[]
}

export interface ExecuteLlmChatInput extends LlmExecutionIdentity {
  ownerId: string
  profile?: LlmExecutionProfile
  contextItems?: readonly LlmContextItem[]
  evidenceGroups?: readonly LlmExecutionEvidenceGroup[]
  webSearch?: PreparedWebSearchExecution
}

export type LlmExecutionEventSink = (event: LlmExecutionEvent) => void

interface LlmChatTransport {
  streamChatDetailed: OpenAiCompatibleProvider['streamChatDetailed']
}

interface PersistedContextState {
  promptText: string
  citationInstruction: string
  citationEntries: ReturnType<typeof prepareCitationProtocol>['protocolEntries']
}

/**
 * D2 execution loop. It owns one complete request from persisted history to terminal state.
 * Renderer only observes typed events; Provider secrets, prompt construction and DB handles stay in Main.
 */
export class LlmChatExecutionService {
  private readonly pendingToolApprovals = new Map<string, {
    conversationId: string
    resolve(decision: LlmToolApprovalDecision): void
  }>()

  constructor(
    private readonly repository: LlmChatRepository,
    private readonly runtime: LlmRuntime,
    private readonly transport: LlmChatTransport,
    private readonly tools: LlmToolRuntime,
    private readonly registry: LlmExecutionRegistry,
    private readonly webSearchRouter?: WebSearchRouter
  ) {}

  toolActivity(conversationId: string): LlmToolActivityView[] {
    return this.repository.getToolCalls(conversationId).map((record) =>
      buildLlmToolActivityView(record, this.tools.descriptor(record.toolId))
    )
  }

  resolveToolApproval(toolCallId: string, decision: LlmToolApprovalDecision): boolean {
    const id = toolCallId.trim()
    const pending = this.pendingToolApprovals.get(id)
    if (!pending) return false
    this.pendingToolApprovals.delete(id)
    pending.resolve(decision)
    return true
  }

  async execute(input: ExecuteLlmChatInput, emit: LlmExecutionEventSink): Promise<LlmMessageRecord> {
    const identity = normalizeIdentity(input)
    const registered = this.registry.begin(identity, input.ownerId)
    const executionStartedAt = Date.now()
    let sequence = 0
    let latestAssistant: LlmMessageRecord | null = null
    let accumulatedContent = ''
    let accumulatedReasoning = ''
    let estimatedPromptTokens = 0
    let lastStreamingPersistAt = 0
    const emitEvent = (event: LlmExecutionEventPayload): void => {
      emit({
        ...identity,
        ...event,
        sequence: sequence++,
        emittedAt: Date.now()
      } as LlmExecutionEvent)
    }

    try {
      const conversation = this.repository.getConversation(identity.conversationId)
      if (!conversation) throw new Error('会话不存在')
      const currentAssistant = this.repository.getMessage(identity.assistantMessageId)
      if (!currentAssistant || currentAssistant.conversationId !== identity.conversationId || currentAssistant.role !== 'ASSISTANT') {
        throw new Error('Assistant 消息不存在或不属于当前会话')
      }
      const history = this.repository.getMessages(identity.conversationId, true)
      if (!history.some((message) => message.id !== identity.assistantMessageId && message.role === 'USER')) {
        throw new Error('当前会话没有可发送的用户消息')
      }

      let assistant = currentAssistant
      latestAssistant = assistant
      emitEvent({ type: 'STARTED' })

      const contextItems: LlmContextItem[] = [...(input.contextItems ?? [])]
      const evidenceGroups: LlmExecutionEvidenceGroup[] = [...(input.evidenceGroups ?? [])]
      if (input.webSearch) {
        const searchPlan = input.webSearch.plan
        assistant = {
          ...assistant,
          webSearchStatus: searchPlan.decision.status,
          webSearchQuery: searchPlan.query,
          webSearchProviderName: searchPlan.providerName,
          webSearchResultCount: null,
          webSearchErrorMessage: searchPlan.preflightErrorMessage,
          updatedAt: Date.now()
        }
        latestAssistant = assistant
        this.repository.updateMessage(assistant, false)
        if (searchPlan.decision.triggered) {
          emitEvent({
            type: 'WEB_SEARCH_STATE',
            status: 'TRIGGERED',
            query: searchPlan.query,
            providerName: searchPlan.providerName,
            resultCount: null,
            errorMessage: null
          })
          if (!this.webSearchRouter) throw new Error('Web Search runtime is not ready')
          const route = await this.webSearchRouter.executePreparedSearch(input.webSearch, registered.signal)
          const searchContext = route.response ? buildWebSearchContext(route.response) : { contextItems: [], evidenceGroups: [] }
          assistant = {
            ...assistant,
            webSearchStatus: route.status,
            webSearchProviderName: route.providerName ?? searchPlan.providerName,
            webSearchResultCount: route.response?.results.length ?? 0,
            webSearchErrorMessage: route.errorMessage,
            updatedAt: Date.now()
          }
          latestAssistant = assistant
          const unconsumedRefs = route.status === 'SUCCESS'
            ? buildUnconsumedWebSearchContextRefs(identity.conversationId, identity.assistantMessageId, searchContext.contextItems, assistant.updatedAt)
            : []
          this.repository.finalizeWebSearch(assistant, unconsumedRefs)
          emitEvent({
            type: 'WEB_SEARCH_STATE',
            status: route.status,
            query: searchPlan.query,
            providerName: assistant.webSearchProviderName,
            resultCount: route.response?.results.length ?? 0,
            errorMessage: route.errorMessage
          })
          if (route.requiredFailure) throw new Error(route.errorMessage ?? 'Web Search 强制联网失败')
          contextItems.push(...searchContext.contextItems)
          evidenceGroups.push(...searchContext.evidenceGroups)
        }
      }

      const plan = this.runtime.prepare(input.profile, contextItems)
      const contextState = this.persistContext(identity, plan, contextItems, evidenceGroups)
      assistant = markAssistantStreaming(assistant, plan.providerId, plan.model)
      latestAssistant = assistant
      this.repository.updateMessage(assistant, false)

      const providerMessages = this.buildProviderHistory(
        history.filter((message) => message.id !== identity.assistantMessageId),
        this.repository.getToolCalls(identity.conversationId),
        buildSystemPrompt(plan, contextState)
      )
      const toolDefinitions = plan.automaticToolCalling ? buildToolDefinitions(plan) : []
      const descriptorByName = uniqueToolDescriptorByName(plan)
      let finalResult: AiChatCompletionResult | null = null

      for (let round = 0; round < MAX_AUTOMATIC_TOOL_ROUNDS; round += 1) {
        const budget = validateLlmPromptBudget(plan, providerMessages, toolDefinitions)
        estimatedPromptTokens += budget.promptTokens
        const result = await this.transport.streamChatDetailed(
          providerMessages,
          plan.runtimeConfig,
          (delta) => {
            appendDelta(delta, (reasoning) => {
              accumulatedReasoning += reasoning
              assistant = { ...assistant, reasoning: accumulatedReasoning || null, updatedAt: Date.now() }
              latestAssistant = assistant
              lastStreamingPersistAt = this.persistStreamingSnapshotIfDue(assistant, lastStreamingPersistAt)
              emitEvent({ type: 'REASONING_DELTA', delta: reasoning })
            }, (content) => {
              accumulatedContent += content
              assistant = { ...assistant, content: accumulatedContent, updatedAt: Date.now() }
              latestAssistant = assistant
              lastStreamingPersistAt = this.persistStreamingSnapshotIfDue(assistant, lastStreamingPersistAt)
              emitEvent({ type: 'CONTENT_DELTA', delta: content })
            })
          },
          toolDefinitions,
          registered.signal
        )
        finalResult = result

        if (result.toolCalls.length === 0 || normalizeLlmFinishReason(result.finishReason) !== 'TOOL_CALLS') break
        if (!plan.automaticToolCalling) throw new Error('Provider 返回了未授权的 Tool Call')

        providerMessages.push({
          role: 'assistant',
          content: result.content,
          toolCalls: result.toolCalls
        })
        const toolRound = await this.executeToolRound(
          identity,
          result,
          descriptorByName,
          contextState,
          registered.signal,
          emitEvent
        )
        providerMessages.push(...toolRound.providerMessages)
      }

      if (!finalResult) throw new Error('Provider 没有返回执行结果')
      if (finalResult.toolCalls.length > 0 && normalizeLlmFinishReason(finalResult.finishReason) === 'TOOL_CALLS') {
        throw new Error('Tool 调用轮次超过安全上限')
      }
      const finishReason = normalizeLlmFinishReason(finalResult.finishReason)
      assistant = withEstimatedUsage(
        finalizeAssistant(assistant, accumulatedContent, accumulatedReasoning, finishReason, 'COMPLETE'),
        estimatedPromptTokens,
        accumulatedContent,
        accumulatedReasoning,
        executionStartedAt
      )
      latestAssistant = assistant
      this.persistAssistantTerminal(assistant, contextState)
      emitEvent({ type: 'TERMINAL', finishReason })
      return assistant
    } catch (error) {
      const serialized = serializeLlmIpcError(error, registered.signal)
      const existing = latestAssistant ?? this.repository.getMessage(identity.assistantMessageId)
      if (existing) {
        const cancelled = serialized.code === 'CANCELLED'
        const finalContent = accumulatedContent || existing.content
        const finalReasoning = accumulatedReasoning || existing.reasoning || ''
        const searchAwareExisting = cancelled && existing.webSearchStatus === 'TRIGGERED'
          ? { ...existing, webSearchStatus: 'CANCELLED' as const, webSearchErrorMessage: null, updatedAt: Date.now() }
          : existing
        if (searchAwareExisting !== existing) {
          emitEvent({
            type: 'WEB_SEARCH_STATE',
            status: 'CANCELLED',
            query: searchAwareExisting.webSearchQuery,
            providerName: searchAwareExisting.webSearchProviderName,
            resultCount: null,
            errorMessage: null
          })
        }
        const terminal = withEstimatedUsage(
          finalizeAssistant(
            searchAwareExisting,
            finalContent,
            finalReasoning,
            cancelled ? 'CANCELLED' : 'ERROR',
            cancelled ? 'STOPPED' : 'ERROR',
            cancelled ? null : serialized.message
          ),
          estimatedPromptTokens,
          finalContent,
          finalReasoning,
          executionStartedAt
        )
        this.repository.updateMessage(terminal)
        if (cancelled) emitEvent({ type: 'TERMINAL', finishReason: 'CANCELLED' })
        else emitEvent({ type: 'ERROR', error: serialized })
        return terminal
      }
      if (serialized.code === 'CANCELLED') emitEvent({ type: 'TERMINAL', finishReason: 'CANCELLED' })
      else emitEvent({ type: 'ERROR', error: serialized })
      throw error
    } finally {
      this.registry.finish(identity.requestId)
    }
  }

  private persistContext(
    identity: LlmExecutionIdentity,
    plan: LlmExecutionPlan,
    items: readonly LlmContextItem[],
    evidenceGroups: readonly LlmExecutionEvidenceGroup[]
  ): PersistedContextState {
    const now = Date.now()
    const renderedById = new Map(plan.context.renderedItems.map((item) => [item.id, item] as const))
    const decisionById = new Map(plan.context.decisions.map((decision) => [decision.id, decision.status] as const))
    const contextRefByContextId = new Map<string, LlmContextRefRecord>()
    const contextRefs = items.map((item): LlmContextRefRecord => {
      const rendered = renderedById.get(item.id)
      const decision = decisionById.get(item.id)
      const ref: LlmContextRefRecord = {
        id: randomUUID(),
        conversationId: identity.conversationId,
        assistantMessageId: identity.assistantMessageId,
        contextId: item.id,
        type: item.type,
        title: item.title?.trim() || null,
        sourceId: item.sourceId?.trim() || null,
        articleId: item.internalArticleId?.trim() || null,
        sourceUrl: httpSourceUrl(item.sourceId),
        contentSnapshot: item.content,
        promptContentSnapshot: rendered?.content ?? null,
        contentSha256: sha256(item.content),
        priority: item.priority ?? 0,
        includedInPrompt: decision === 'INCLUDED' || decision === 'INCLUDED_TRUNCATED',
        truncatedInPrompt: decision === 'INCLUDED_TRUNCATED',
        createdAt: now
      }
      contextRefByContextId.set(item.id, ref)
      return ref
    })
    this.repository.replaceContextRefsForAssistant(identity.assistantMessageId, contextRefs)

    const evidenceByContextId = new Map<string, readonly BuiltLlmEvidenceBlock[]>()
    for (const group of evidenceGroups) {
      const contextId = group.contextId.trim()
      if (!contextId || evidenceByContextId.has(contextId)) throw new Error(`Evidence group contextId 重复或为空：${contextId}`)
      evidenceByContextId.set(contextId, group.blocks)
    }
    const citationCandidates: LlmCitationEvidenceCandidate[] = []
    for (const [contextId, blocks] of evidenceByContextId) {
      const contextRef = contextRefByContextId.get(contextId)
      if (!contextRef) throw new Error(`Evidence group 找不到对应 ContextRef：${contextId}`)
      const records = blocks.map((block): LlmEvidenceBlockRecord => ({
        id: randomUUID(),
        contextRefId: contextRef.id,
        stableLocatorKey: block.stableLocatorKey,
        kind: block.kind,
        ordinal: block.ordinal,
        textSnapshot: block.content,
        normalizedSha256: block.normalizedSha256,
        locator: block.locator,
        schemaVersion: block.schemaVersion,
        createdAt: now
      }))
      this.repository.replaceEvidenceBlocks(contextRef.id, records)
      for (const record of records) {
        citationCandidates.push({
          stableLocatorKey: record.stableLocatorKey,
          contextRefId: contextRef.id,
          evidenceBlockId: record.id,
          targetKind: 'EVIDENCE_BLOCK',
          quoteSnapshot: record.textSnapshot,
          sourceUrl: record.locator.sourceUrl ?? contextRef.sourceUrl,
          locatorSnapshot: record.locator
        })
      }
    }
    const citation = prepareCitationProtocol(plan.context, citationCandidates)
    return { promptText: citation.text, citationInstruction: citation.instruction, citationEntries: citation.protocolEntries }
  }

  private buildProviderHistory(
    history: readonly LlmMessageRecord[],
    toolCalls: readonly LlmToolCallRecord[],
    systemPrompt: string
  ): AiChatMessage[] {
    const callsByAssistant = new Map<string, LlmToolCallRecord[]>()
    for (const call of toolCalls) {
      const list = callsByAssistant.get(call.assistantMessageId) ?? []
      list.push(call)
      callsByAssistant.set(call.assistantMessageId, list)
    }
    const result: AiChatMessage[] = [{ role: 'system', content: systemPrompt }]
    for (const message of history) {
      if (message.role === 'USER') {
        result.push({ role: 'user', content: message.content })
        continue
      }
      if (message.role === 'SYSTEM') {
        result.push({ role: 'system', content: message.content })
        continue
      }
      if (message.role === 'TOOL') {
        continue
      }
      const calls = (callsByAssistant.get(message.id) ?? []).filter(isProviderHistoryToolCall)
      result.push({
        role: 'assistant',
        content: message.content,
        toolCalls: calls.length > 0 ? calls.map((call) => ({
          id: call.providerCallId,
          name: call.apiName,
          argumentsJson: call.argumentsJson
        })) : undefined
      })
      for (const call of calls) {
        result.push({ role: 'tool', toolCallId: call.providerCallId, content: toolHistoryContent(call) })
      }
    }
    return result
  }

  private async executeToolRound(
    identity: LlmExecutionIdentity,
    result: AiChatCompletionResult,
    descriptorByName: ReadonlyMap<string, LlmExecutionPlan['tools'][number]>,
    contextState: PersistedContextState,
    signal: AbortSignal,
    emit: (event: LlmExecutionEventPayload) => void
  ): Promise<{ providerMessages: AiChatMessage[] }> {
    const now = Date.now()
    const records: LlmToolCallRecord[] = result.toolCalls.map((call): LlmToolCallRecord => {
      const descriptor = descriptorByName.get(call.name)
      return {
        id: randomUUID(),
        conversationId: identity.conversationId,
        assistantMessageId: identity.assistantMessageId,
        providerCallId: call.id,
        toolId: descriptor?.id ?? `unknown:${call.name}`,
        apiName: call.name,
        argumentsJson: call.argumentsJson,
        status: descriptor ? (toolRequiresConfirmation(descriptor) ? 'PENDING_APPROVAL' : 'RUNNING') : 'ERROR',
        resultContent: null,
        errorMessage: descriptor ? null : `Provider 请求了未注册的 Tool：${call.name}`,
        createdAt: now,
        updatedAt: now
      }
    })
    this.repository.appendToolCalls(records)

    const approvalPromises = new Map<string, Promise<LlmToolApprovalDecision>>()
    for (const record of records) {
      emit({ type: 'TOOL_STATE', toolCallId: record.id, status: record.status })
      if (record.status === 'PENDING_APPROVAL') {
        const pending = this.waitForToolApproval(record, signal)
        void pending.catch(() => undefined)
        approvalPromises.set(record.id, pending)
      }
    }

    const providerMessages: AiChatMessage[] = []
    for (const record of records) {
      const descriptor = descriptorByName.get(record.apiName)
      if (!descriptor) {
        providerMessages.push({ role: 'tool', toolCallId: record.providerCallId, content: record.errorMessage ?? 'Tool unavailable' })
        continue
      }
      if (record.status === 'PENDING_APPROVAL') {
        let decision: LlmToolApprovalDecision
        try {
          decision = await approvalPromises.get(record.id)!
        } catch (error) {
          const updated = {
            ...record,
            status: 'ERROR' as const,
            errorMessage: 'Tool 审批已取消，Tool 未执行。',
            updatedAt: Date.now()
          }
          this.repository.updateToolCall(updated)
          emit({ type: 'TOOL_STATE', toolCallId: record.id, status: updated.status })
          throw error
        }
        if (decision === 'DENY') {
          const resultContent = 'Tool execution was denied by the user.'
          const updated = {
            ...record,
            status: 'DENIED' as const,
            resultContent,
            errorMessage: null,
            updatedAt: Date.now()
          }
          this.repository.updateToolCall(updated)
          emit({ type: 'TOOL_STATE', toolCallId: record.id, status: updated.status })
          providerMessages.push({ role: 'tool', toolCallId: record.providerCallId, content: resultContent })
          continue
        }
      }
      const execution = await this.tools.execute(
        { id: record.id, toolId: descriptor.id, argumentsJson: record.argumentsJson },
        { enabledToolIds: new Set([descriptor.id]) },
        { signal, confirmed: record.status === 'PENDING_APPROVAL' }
      )
      if (execution.status === 'CONFIRMATION_REQUIRED') {
        const updated = { ...record, status: 'ERROR' as const, errorMessage: 'Tool 审批状态失效，Tool 未执行。', updatedAt: Date.now() }
        this.repository.updateToolCall(updated)
        emit({ type: 'TOOL_STATE', toolCallId: record.id, status: updated.status })
        providerMessages.push({ role: 'tool', toolCallId: record.providerCallId, content: 'Tool execution failed: approval state was invalid.' })
        continue
      }
      if (execution.status === 'SUCCESS') {
        const updated = { ...record, status: 'COMPLETE' as const, resultContent: execution.content, updatedAt: Date.now() }
        this.repository.updateToolCall(updated)
        emit({ type: 'TOOL_STATE', toolCallId: record.id, status: updated.status })
        const protocolId = this.persistAutomaticToolEvidence(identity, updated, descriptor, execution.content, contextState)
        providerMessages.push({
          role: 'tool',
          toolCallId: record.providerCallId,
          content: wrapToolResultEvidence(execution.content, protocolId)
        })
      } else {
        const updated = { ...record, status: 'ERROR' as const, errorMessage: execution.message, updatedAt: Date.now() }
        this.repository.updateToolCall(updated)
        emit({ type: 'TOOL_STATE', toolCallId: record.id, status: updated.status })
        providerMessages.push({ role: 'tool', toolCallId: record.providerCallId, content: `Tool execution failed: ${execution.message}` })
      }
    }
    return { providerMessages }
  }

  private persistAutomaticToolEvidence(
    identity: LlmExecutionIdentity,
    record: LlmToolCallRecord,
    descriptor: LlmToolDescriptor,
    content: string,
    contextState: PersistedContextState
  ): string {
    const createdAt = Date.now()
    const normalizedSha256 = sha256(content)
    const stableLocatorKey = `TOOL_RESULT:${record.id}:${normalizedSha256.slice(0, 20)}`
    const contextRef: LlmContextRefRecord = {
      id: randomUUID(),
      conversationId: identity.conversationId,
      assistantMessageId: identity.assistantMessageId,
      contextId: `tool-result:${record.id}`,
      type: 'TOOL_RESULT',
      title: descriptor.description.trim() || descriptor.name,
      sourceId: descriptor.sourceId?.trim() || descriptor.id,
      articleId: null,
      sourceUrl: null,
      contentSnapshot: content,
      promptContentSnapshot: content,
      contentSha256: normalizedSha256,
      priority: 90,
      includedInPrompt: true,
      truncatedInPrompt: false,
      createdAt
    }
    this.repository.appendContextRef(contextRef)
    const evidenceBlock: LlmEvidenceBlockRecord = {
      id: randomUUID(),
      contextRefId: contextRef.id,
      stableLocatorKey,
      kind: 'TOOL_RESULT',
      ordinal: 0,
      textSnapshot: content,
      normalizedSha256,
      locator: {
        version: 1,
        sourceKind: 'TOOL_RESULT',
        stableLocatorKey,
        toolCallId: record.id,
        toolId: descriptor.id,
        toolName: descriptor.description.trim() || descriptor.name,
        toolSourceId: descriptor.sourceId?.trim() || null,
        normalizedHash: normalizedSha256
      },
      schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION,
      createdAt
    }
    this.repository.replaceEvidenceBlocks(contextRef.id, [evidenceBlock])
    const protocolId = `E${contextState.citationEntries.length + 1}`
    contextState.citationEntries.push({
      stableLocatorKey,
      contextRefId: contextRef.id,
      evidenceBlockId: evidenceBlock.id,
      targetKind: 'EVIDENCE_BLOCK',
      quoteSnapshot: content,
      sourceUrl: null,
      locatorSnapshot: evidenceBlock.locator,
      protocolId
    })
    return protocolId
  }

  private waitForToolApproval(record: LlmToolCallRecord, signal: AbortSignal): Promise<LlmToolApprovalDecision> {
    if (this.pendingToolApprovals.has(record.id)) throw new Error(`Tool 已在等待审批：${record.id}`)
    return new Promise<LlmToolApprovalDecision>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        this.pendingToolApprovals.delete(record.id)
      }
      const onAbort = (): void => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Tool approval cancelled', 'AbortError'))
      }
      this.pendingToolApprovals.set(record.id, {
        conversationId: record.conversationId,
        resolve: (decision) => {
          cleanup()
          resolve(decision)
        }
      })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private persistAssistantTerminal(assistant: LlmMessageRecord, context: PersistedContextState): void {
    this.repository.updateMessage(assistant)
    const citationResult = buildCitationRefsFromAssistantOutput(
      assistant.content,
      context.citationEntries,
      { conversationId: assistant.conversationId, assistantMessageId: assistant.id }
    )
    this.repository.replaceCitationRefsForAssistant(assistant.id, citationResult.refs)
  }

  private persistStreamingSnapshotIfDue(assistant: LlmMessageRecord, lastPersistAt: number): number {
    const now = Date.now()
    if (now - lastPersistAt < 150) return lastPersistAt
    this.repository.updateMessage({ ...assistant, updatedAt: now }, false)
    return now
  }
}

type LlmExecutionEventPayload =
  | { type: 'STARTED' }
  | {
      type: 'WEB_SEARCH_STATE'
      status: LlmMessageRecord['webSearchStatus'] extends infer T ? Exclude<T, null> : never
      query: string | null
      providerName: string | null
      resultCount: number | null
      errorMessage: string | null
    }
  | { type: 'REASONING_DELTA'; delta: string }
  | { type: 'CONTENT_DELTA'; delta: string }
  | { type: 'TOOL_STATE'; toolCallId: string; status: string }
  | { type: 'TERMINAL'; finishReason: LlmUnifiedFinishReason }
  | { type: 'ERROR'; error: ReturnType<typeof serializeLlmIpcError> }

function normalizeIdentity(input: ExecuteLlmChatInput): LlmExecutionIdentity {
  return {
    requestId: requiredText(input.requestId, 'requestId'),
    conversationId: requiredText(input.conversationId, 'conversationId'),
    assistantMessageId: requiredText(input.assistantMessageId, 'assistantMessageId')
  }
}

export function buildSystemPrompt(plan: LlmExecutionPlan, context: PersistedContextState): string {
  // Citation/data-boundary protocol is part of OrigRead's hard contract and therefore precedes all
  // user-controlled Skill/Custom Instructions. Context data itself is appended last and remains data.
  let systemPrompt = [
    buildLlmTaskBaseSystemPrompt(plan.task),
    context.citationInstruction
  ].filter(Boolean).join('\n\n')
  if (plan.skillId && plan.skillInstructions) systemPrompt = composeSkillSystemPrompt(systemPrompt, plan.skillId, plan.skillInstructions)
  if (plan.customInstructions) systemPrompt = composeCustomInstructionsSystemPrompt(systemPrompt, plan.customInstructions)
  if (context.promptText) systemPrompt += `\n\n<context_data>\n${context.promptText}\n</context_data>`
  return systemPrompt
}

function buildToolDefinitions(plan: LlmExecutionPlan): AiChatToolDefinition[] {
  return plan.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.inputSchema) }))
}

function uniqueToolDescriptorByName(plan: LlmExecutionPlan): ReadonlyMap<string, LlmExecutionPlan['tools'][number]> {
  const result = new Map<string, LlmExecutionPlan['tools'][number]>()
  for (const descriptor of plan.tools) {
    const name = descriptor.name.trim()
    if (!name) throw new Error('Tool API name 不能为空')
    if (result.has(name)) throw new Error(`本次执行存在重复 Tool API name：${name}`)
    result.set(name, descriptor)
  }
  return result
}

function appendDelta(
  delta: AiChatCompletionDelta,
  onReasoning: (value: string) => void,
  onContent: (value: string) => void
): void {
  if (delta.reasoning) onReasoning(delta.reasoning)
  if (delta.content) onContent(delta.content)
}

function markAssistantStreaming(message: LlmMessageRecord, providerId: string, model: string): LlmMessageRecord {
  return {
    ...message,
    providerId,
    model,
    status: 'STREAMING',
    errorMessage: null,
    finishReason: null,
    updatedAt: Date.now()
  }
}

function finalizeAssistant(
  message: LlmMessageRecord,
  content: string,
  reasoning: string,
  finishReason: LlmUnifiedFinishReason,
  status: LlmMessageRecord['status'],
  errorMessage: string | null = null
): LlmMessageRecord {
  return {
    ...message,
    content,
    reasoning: reasoning.trim() || null,
    status,
    errorMessage,
    finishReason,
    updatedAt: Date.now()
  }
}

function withEstimatedUsage(
  message: LlmMessageRecord,
  promptTokens: number,
  content: string,
  reasoning: string,
  executionStartedAt: number
): LlmMessageRecord {
  return {
    ...message,
    promptTokens: Math.max(0, Math.trunc(promptTokens)),
    completionTokens: Math.max(0, estimateLlmTokens(`${reasoning}\n${content}`)),
    durationMs: Math.max(0, Date.now() - executionStartedAt),
    tokenUsageEstimated: true
  }
}

function isProviderHistoryToolCall(call: LlmToolCallRecord): boolean {
  return call.status === 'COMPLETE' || call.status === 'DENIED' || call.status === 'ERROR'
}

function toolHistoryContent(call: LlmToolCallRecord): string {
  if (call.status === 'COMPLETE') return call.resultContent ?? ''
  if (call.status === 'DENIED') return call.resultContent ?? 'Tool execution was denied by the user.'
  return call.resultContent ?? `Tool execution failed: ${call.errorMessage ?? 'unknown error'}`
}

function httpSourceUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function wrapToolResultEvidence(content: string, protocolId: string): string {
  return [
    `[ORIGREAD_EVIDENCE id="${protocolId}"]`,
    content,
    '[/ORIGREAD_EVIDENCE]',
    `If a claim in the answer depends on this tool result, cite [[${protocolId}]] immediately after that claim.`
  ].join('\n')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new TypeError(`${field} 无效`)
  return normalized
}
