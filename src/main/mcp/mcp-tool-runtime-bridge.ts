import type { LlmToolDescriptor, LlmToolResult } from '../../shared/llm-tool'
import type { McpToolCatalogEntry, McpToolCatalogSnapshot } from '../../shared/mcp'
import type { LlmToolRuntime } from '../llm/tool-runtime'
import type { McpToolCatalogService } from './mcp-tool-catalog-service'
import { classifyMcpToolRisk } from './mcp-tool-risk'

const MAX_TOOL_RESULT_CHARS = 64_000

export interface McpToolCallSource {
  callTool(serverId: string, name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

/**
 * Projects the persisted MCP catalog into the Main-process ToolRuntime.
 * It never performs tools/list itself: stale/missing catalog entries stay unavailable
 * until the user explicitly refreshes that server.
 */
export class McpToolRuntimeBridge {
  constructor(
    private readonly catalog: McpToolCatalogService,
    private readonly remote: McpToolCallSource,
    private readonly runtime: LlmToolRuntime
  ) {}

  sync(): McpToolCatalogSnapshot {
    const snapshot = this.catalog.current()
    for (const descriptor of this.runtime.descriptors()) {
      if (descriptor.source === 'MCP') this.runtime.unregister(descriptor.id)
    }
    for (const server of snapshot.servers) {
      if (server.stale) continue
      for (const tool of server.tools) this.register(tool)
    }
    return snapshot
  }

  enabledToolIds(): string[] {
    return this.runtime.descriptors()
      .filter((descriptor) => descriptor.source === 'MCP' && descriptor.enabled)
      .map((descriptor) => descriptor.id)
  }

  private register(tool: McpToolCatalogEntry): void {
    const descriptor: LlmToolDescriptor = {
      id: tool.id,
      name: tool.providerName,
      description: tool.description || tool.title || tool.rawName,
      source: 'MCP',
      sourceId: tool.serverId,
      risk: classifyMcpToolRisk(tool.annotations),
      enabled: true,
      inputSchema: structuredClone(tool.inputSchema),
      outputSchema: tool.outputSchema == null ? null : structuredClone(tool.outputSchema)
    }
    this.runtime.register({
      descriptor,
      execute: async (argumentsJson, signal) => {
        const argumentsValue = parseToolArguments(argumentsJson)
        const result = await this.remote.callTool(tool.serverId, tool.rawName, argumentsValue, signal)
        return normalizeMcpToolResult(result)
      }
    })
  }
}

export function normalizeMcpToolResult(value: unknown): LlmToolResult {
  if (!isObject(value)) return { status: 'FAILURE', message: 'MCP Tool 返回了无效结果' }
  const content = toolResultContent(value)
  if (value.isError === true) {
    return { status: 'FAILURE', message: truncate(content || 'MCP Tool 返回错误', MAX_TOOL_RESULT_CHARS) }
  }
  return { status: 'SUCCESS', content: truncate(content || '{}', MAX_TOOL_RESULT_CHARS) }
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    throw new Error('MCP Tool 参数不是有效 JSON')
  }
  if (!isObject(parsed)) throw new Error('MCP Tool 参数必须是 JSON object')
  return parsed
}

function toolResultContent(value: Record<string, unknown>): string {
  if (isObject(value.structuredContent)) return safeJson(value.structuredContent)
  if (!Array.isArray(value.content)) return ''
  const parts: string[] = []
  for (const block of value.content) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'resource' && isObject(block.resource) && typeof block.resource.text === 'string') {
      parts.push(block.resource.text)
      continue
    }
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    parts.push(`[MCP ${type} content omitted]`)
  }
  return parts.join('\n\n').trim()
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return '{}' }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n[OrigRead truncated MCP tool result]`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
