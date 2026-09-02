import { describe, expect, it } from 'vitest'
import type { LlmToolCallRecord } from '../../shared/llm-chat'
import type { LlmToolDescriptor } from '../../shared/llm-tool'
import { buildLlmToolActivityView } from './tool-approval-view'

function record(argumentsJson: string): LlmToolCallRecord {
  return {
    id: 'call-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1', providerCallId: 'provider-1',
    toolId: 'tool-1', apiName: 'tool_api', argumentsJson, status: 'PENDING_APPROVAL', resultContent: null,
    errorMessage: null, createdAt: 1, updatedAt: 1
  }
}

const descriptor: LlmToolDescriptor = {
  id: 'tool-1', name: 'write_note', description: 'Write a note', source: 'MCP', sourceId: 'server-1',
  risk: 'WRITE', enabled: true, inputSchema: { type: 'object' }, outputSchema: null
}

describe('buildLlmToolActivityView', () => {
  it('redacts common secret-shaped fields while keeping useful arguments', () => {
    const view = buildLlmToolActivityView(record(JSON.stringify({ title: 'Hello', apiKey: 'secret', nested: { authorization: 'Bearer x', id: 7 } })), descriptor)
    expect(view).toMatchObject({ name: 'write_note', risk: 'WRITE', source: 'MCP', status: 'PENDING_APPROVAL' })
    expect(view.argumentsPreview).toContain('Hello')
    expect(view.argumentsPreview).toContain('[redacted]')
    expect(view.argumentsPreview).not.toContain('Bearer x')
    expect(view.argumentsPreview).not.toContain('secret')
  })

  it('bounds malformed or oversized raw arguments', () => {
    const view = buildLlmToolActivityView(record('x'.repeat(8_000)), descriptor)
    expect(view.argumentsTruncated).toBe(true)
    expect(view.argumentsPreview.length).toBeLessThan(4_100)
  })

  it('redacts secret-shaped Tool results and errors before they enter Renderer memory', () => {
    const input = record('{}')
    input.resultContent = JSON.stringify({ value: 'ok', token: 'result-secret', nested: { apiKey: 'api-secret' } })
    input.errorMessage = 'Authorization: Bearer error-secret password=hunter2'
    const view = buildLlmToolActivityView(input, descriptor)
    expect(view.resultPreview).toContain('ok')
    expect(view.resultPreview).toContain('[redacted]')
    expect(view.resultPreview).not.toContain('result-secret')
    expect(view.resultPreview).not.toContain('api-secret')
    expect(view.errorMessage).not.toContain('error-secret')
    expect(view.errorMessage).not.toContain('hunter2')
  })

  it('falls back to WRITE when the original descriptor is no longer registered', () => {
    expect(buildLlmToolActivityView(record('{}'), null)).toMatchObject({ risk: 'WRITE', source: 'MCP' })
  })
})
