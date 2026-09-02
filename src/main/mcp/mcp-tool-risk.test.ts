import { describe, expect, it } from 'vitest'
import type { McpToolAnnotationsSnapshot } from '../../shared/mcp'
import { classifyMcpToolRisk } from './mcp-tool-risk'

function annotations(patch: Partial<McpToolAnnotationsSnapshot> = {}): McpToolAnnotationsSnapshot {
  return {
    title: null,
    readOnlyHint: null,
    destructiveHint: null,
    idempotentHint: null,
    openWorldHint: null,
    ...patch
  }
}

describe('classifyMcpToolRisk', () => {
  it('allows only explicitly local/read-only tools into READ_ONLY', () => {
    expect(classifyMcpToolRisk(annotations({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }))).toBe('READ_ONLY')
  })

  it('treats external read operations as SENSITIVE', () => {
    expect(classifyMcpToolRisk(annotations({ readOnlyHint: true, destructiveHint: false, openWorldHint: true }))).toBe('SENSITIVE')
  })

  it('defaults unknown or destructive capabilities to WRITE', () => {
    expect(classifyMcpToolRisk(annotations())).toBe('WRITE')
    expect(classifyMcpToolRisk(annotations({ readOnlyHint: false, destructiveHint: false }))).toBe('WRITE')
    expect(classifyMcpToolRisk(annotations({ readOnlyHint: true, destructiveHint: true }))).toBe('WRITE')
  })
})
