import type { LlmToolCall, LlmToolDescriptor, LlmToolResult } from '../../shared/llm-tool'
import { toolRequiresConfirmation } from '../../shared/llm-tool'

export interface LlmTool {
  descriptor: LlmToolDescriptor
  execute(argumentsJson: string, signal?: AbortSignal): Promise<LlmToolResult> | LlmToolResult
}

export interface LlmToolExecutionPolicy {
  enabledToolIds: ReadonlySet<string>
}

/** Main-process registry shared by provider-native, OrigRead internal and future MCP tools. */
export class LlmToolRuntime {
  private readonly tools = new Map<string, LlmTool>()

  register(tool: LlmTool): void {
    const descriptor = normalizeDescriptor(tool.descriptor)
    const existing = this.tools.get(descriptor.id)
    if (existing && existing !== tool) throw new Error(`Tool id 已被占用：${descriptor.id}`)
    if (descriptor !== tool.descriptor) tool = { ...tool, descriptor }
    this.tools.set(descriptor.id, tool)
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId.trim())
  }

  descriptors(): LlmToolDescriptor[] {
    return [...this.tools.values()].map((tool) => tool.descriptor).sort(compareToolId)
  }

  descriptor(toolId: string): LlmToolDescriptor | null {
    const descriptor = this.tools.get(toolId.trim())?.descriptor
    return descriptor ? cloneDescriptor(descriptor) : null
  }

  resolveAllowed(toolIds: ReadonlySet<string>): LlmToolDescriptor[] {
    return [...toolIds]
      .map((id) => this.tools.get(id)?.descriptor)
      .filter((descriptor): descriptor is LlmToolDescriptor => Boolean(descriptor?.enabled))
      .sort(compareToolId)
  }

  async execute(
    call: LlmToolCall,
    policy: LlmToolExecutionPolicy,
    options: { confirmed?: boolean; signal?: AbortSignal } = {}
  ): Promise<LlmToolResult> {
    const toolId = call.toolId.trim()
    if (!policy.enabledToolIds.has(toolId)) {
      return { status: 'FAILURE', message: `当前执行配置未授权 Tool：${toolId}` }
    }
    const tool = this.tools.get(toolId)
    if (!tool) return { status: 'FAILURE', message: `Tool 不存在或尚未加载：${toolId}` }
    if (!tool.descriptor.enabled) return { status: 'FAILURE', message: `Tool 已停用：${toolId}` }
    if (toolRequiresConfirmation(tool.descriptor) && options.confirmed !== true) {
      return { status: 'CONFIRMATION_REQUIRED', descriptor: tool.descriptor }
    }
    try {
      return await tool.execute(call.argumentsJson, options.signal)
    } catch (error) {
      if (isCancellation(error, options.signal)) throw error
      return { status: 'FAILURE', message: error instanceof Error ? error.message : 'Tool 执行失败' }
    }
  }
}

function normalizeDescriptor(descriptor: LlmToolDescriptor): LlmToolDescriptor {
  const id = descriptor.id.trim()
  const name = descriptor.name.trim()
  const sourceId = descriptor.sourceId?.trim() || null
  if (!id) throw new Error('Tool id 不能为空')
  if (!name) throw new Error('Tool name 不能为空')
  if (descriptor.source === 'MCP' && !sourceId) throw new Error('MCP Tool 必须记录来源 Server')
  if (!isJsonObject(descriptor.inputSchema)) throw new Error(`Tool ${id} inputSchema 必须是 JSON object`)
  if (descriptor.outputSchema != null && !isJsonObject(descriptor.outputSchema)) {
    throw new Error(`Tool ${id} outputSchema 必须是 JSON object`)
  }
  return {
    ...descriptor,
    id,
    name,
    description: descriptor.description.trim(),
    sourceId,
    inputSchema: structuredClone(descriptor.inputSchema),
    outputSchema: descriptor.outputSchema == null ? null : structuredClone(descriptor.outputSchema)
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareToolId(left: LlmToolDescriptor, right: LlmToolDescriptor): number {
  return left.id.localeCompare(right.id)
}

function cloneDescriptor(descriptor: LlmToolDescriptor): LlmToolDescriptor {
  return {
    ...descriptor,
    inputSchema: structuredClone(descriptor.inputSchema),
    outputSchema: descriptor.outputSchema == null ? null : structuredClone(descriptor.outputSchema)
  }
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof DOMException && error.name === 'AbortError'
}
