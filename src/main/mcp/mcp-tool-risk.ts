import type { LlmToolRisk } from '../../shared/llm-tool'
import type { McpToolAnnotationsSnapshot } from '../../shared/mcp'

/**
 * MCP annotations are hints supplied by the remote server, not authorization.
 * OrigRead deliberately maps missing/ambiguous hints to the more restrictive bucket.
 */
export function classifyMcpToolRisk(annotations: McpToolAnnotationsSnapshot): LlmToolRisk {
  if (annotations.readOnlyHint !== true || annotations.destructiveHint === true) return 'WRITE'
  if (annotations.openWorldHint === true) return 'SENSITIVE'
  return 'READ_ONLY'
}
