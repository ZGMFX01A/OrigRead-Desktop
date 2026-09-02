import { createHash, randomUUID } from 'node:crypto'
import { LLM_EVIDENCE_SCHEMA_VERSION } from '../../shared/llm-chat'
import type { LlmContextItem } from '../../shared/llm-context'
import type { LlmExecuteManualToolRequest, LlmManualToolContextView, LlmManualToolView } from '../../shared/llm-ipc'
import { toolRequiresConfirmation } from '../../shared/llm-tool'
import type { BuiltLlmEvidenceBlock } from './evidence-block-builder'
import type { LlmToolRuntime } from './tool-runtime'
import { MANUAL_TOOL_CONTEXT_PRIORITY } from './context-priority'
import { redactLlmToolPreviewText } from './tool-approval-view'

const MAX_PENDING_CONTEXTS = 40
const CONTEXT_TTL_MS = 30 * 60_000
const MAX_RESULT_PREVIEW_CHARS = 8_000
const MANUAL_TOOL_TIMEOUT_MS = 60_000

interface PendingManualToolContext {
  contextId: string
  conversationId: string
  toolId: string
  toolSourceId: string | null
  name: string
  risk: LlmManualToolContextView['risk']
  content: string
  createdAt: number
}

export interface ConsumedManualToolContexts {
  contextItems: LlmContextItem[]
  evidenceGroups: Array<{ contextId: string; blocks: BuiltLlmEvidenceBlock[] }>
}

/**
 * Main-owned one-shot tool-result buffer for models that cannot call tools themselves.
 * Renderer only receives bounded previews + opaque context IDs; the full result stays in Main
 * until it is consumed into the next execution snapshot.
 */
export class ManualToolContextService {
  private readonly pending = new Map<string, PendingManualToolContext>()

  constructor(private readonly tools: LlmToolRuntime) {}

  listTools(): LlmManualToolView[] {
    return this.tools.descriptors()
      .filter((descriptor) => descriptor.source === 'MCP' && descriptor.enabled)
      .map((descriptor) => ({
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        sourceId: descriptor.sourceId ?? null,
        risk: descriptor.risk,
        inputSchema: structuredClone(descriptor.inputSchema)
      }))
  }

  async execute(request: LlmExecuteManualToolRequest): Promise<LlmManualToolContextView> {
    this.prune()
    const conversationId = request.conversationId.trim()
    const toolId = request.toolId.trim()
    if (!conversationId || !toolId) throw new Error('Manual Tool 请求缺少 conversationId 或 toolId')
    const descriptor = this.tools.descriptor(toolId)
    if (!descriptor || descriptor.source !== 'MCP' || !descriptor.enabled) throw new Error('Manual MCP Tool 不存在或已不可用')
    if (toolRequiresConfirmation(descriptor) && request.confirmed !== true) {
      throw new Error('该 MCP Tool 需要用户明确确认后才能执行')
    }
    const result = await this.tools.execute(
      { id: randomUUID(), toolId, argumentsJson: request.argumentsJson },
      { enabledToolIds: new Set([toolId]) },
      { confirmed: request.confirmed === true, signal: AbortSignal.timeout(MANUAL_TOOL_TIMEOUT_MS) }
    )
    if (result.status === 'CONFIRMATION_REQUIRED') throw new Error('该 MCP Tool 需要用户明确确认后才能执行')
    if (result.status === 'FAILURE') throw new Error(result.message)

    const createdAt = Date.now()
    const contextId = `manual-tool:${randomUUID()}`
    const stored: PendingManualToolContext = {
      contextId,
      conversationId,
      toolId,
      toolSourceId: descriptor.sourceId?.trim() || null,
      name: descriptor.description || descriptor.name,
      risk: descriptor.risk,
      content: result.content,
      createdAt
    }
    this.pending.set(contextId, stored)
    this.enforceLimit()
    return publicView(stored)
  }

  discard(contextId: string): boolean {
    return this.pending.delete(contextId.trim())
  }

  consume(conversationId: string, contextIds: readonly string[]): ConsumedManualToolContexts {
    this.prune()
    const ownerId = conversationId.trim()
    const ids = [...new Set(contextIds.map((id) => id.trim()).filter(Boolean))]
    const entries = ids.map((id) => this.pending.get(id))
    if (entries.some((entry) => !entry || entry.conversationId !== ownerId)) {
      throw new Error('Manual Tool Context 已失效或不属于当前会话')
    }
    const contextItems: LlmContextItem[] = []
    const evidenceGroups: ConsumedManualToolContexts['evidenceGroups'] = []
    for (const entry of entries as PendingManualToolContext[]) {
      const normalizedSha256 = sha256(entry.content)
      const stableLocatorKey = `TOOL_RESULT:${normalizedSha256.slice(0, 24)}:0`
      const block: BuiltLlmEvidenceBlock = {
        stableLocatorKey,
        content: entry.content,
        kind: 'TOOL_RESULT',
        ordinal: 0,
        normalizedSha256,
        locator: {
          version: 1,
          sourceKind: 'TOOL_RESULT',
          stableLocatorKey,
          toolCallId: entry.contextId,
          toolId: entry.toolId,
          toolName: entry.name,
          toolSourceId: entry.toolSourceId,
          normalizedHash: normalizedSha256
        },
        schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION
      }
      contextItems.push({
        id: entry.contextId,
        type: 'TOOL_RESULT',
        title: entry.name,
        sourceId: entry.toolId,
        content: entry.content,
        evidenceBlocks: [block],
        priority: MANUAL_TOOL_CONTEXT_PRIORITY
      })
      evidenceGroups.push({ contextId: entry.contextId, blocks: [block] })
    }
    for (const id of ids) this.pending.delete(id)
    return { contextItems, evidenceGroups }
  }

  private prune(now = Date.now()): void {
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > CONTEXT_TTL_MS) this.pending.delete(id)
    }
  }

  private enforceLimit(): void {
    while (this.pending.size > MAX_PENDING_CONTEXTS) {
      const oldest = [...this.pending.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (!oldest) return
      this.pending.delete(oldest.contextId)
    }
  }
}

function publicView(entry: PendingManualToolContext): LlmManualToolContextView {
  const preview = redactLlmToolPreviewText(entry.content, MAX_RESULT_PREVIEW_CHARS)
  return {
    contextId: entry.contextId,
    conversationId: entry.conversationId,
    toolId: entry.toolId,
    name: entry.name,
    risk: entry.risk,
    resultPreview: preview.text,
    resultTruncated: preview.truncated,
    createdAt: entry.createdAt
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
