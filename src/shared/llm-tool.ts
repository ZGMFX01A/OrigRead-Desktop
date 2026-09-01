export type LlmToolSource = 'NATIVE_PROVIDER' | 'ORIGREAD_INTERNAL' | 'MCP'
export type LlmToolRisk = 'READ_ONLY' | 'SENSITIVE' | 'WRITE'

export interface LlmToolDescriptor {
  /** Globally stable ID. Registry rejects collisions across all sources. */
  id: string
  /** Provider-facing function/tool name. */
  name: string
  description: string
  source: LlmToolSource
  /** Required for MCP; useful for provider/internal namespaces too. */
  sourceId?: string | null
  risk: LlmToolRisk
  enabled: boolean
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown> | null
}

export interface LlmToolCall {
  id: string
  toolId: string
  argumentsJson: string
}

export type LlmToolResult =
  | { status: 'SUCCESS'; content: string }
  | { status: 'FAILURE'; message: string }
  | { status: 'CONFIRMATION_REQUIRED'; descriptor: LlmToolDescriptor }

export function toolRequiresConfirmation(descriptor: LlmToolDescriptor): boolean {
  return descriptor.risk !== 'READ_ONLY'
}
