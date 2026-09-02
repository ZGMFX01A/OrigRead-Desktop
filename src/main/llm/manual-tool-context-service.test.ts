import { describe, expect, it } from 'vitest'
import type { LlmTool } from './tool-runtime'
import { LlmToolRuntime } from './tool-runtime'
import { ManualToolContextService } from './manual-tool-context-service'

function mcpTool(id: string, risk: LlmTool['descriptor']['risk'], execute: LlmTool['execute']): LlmTool {
  return {
    descriptor: {
      id,
      name: id.replace(/[^A-Za-z0-9_-]/g, '_'),
      description: `Tool ${id}`,
      source: 'MCP',
      sourceId: 'server-1',
      risk,
      enabled: true,
      inputSchema: { type: 'object' },
      outputSchema: null
    },
    execute
  }
}

describe('ManualToolContextService', () => {
  it('lists only executable MCP tools and runs read-only tools without a confirmation flag', async () => {
    const runtime = new LlmToolRuntime()
    runtime.register(mcpTool('mcp:read', 'READ_ONLY', async () => ({ status: 'SUCCESS', content: 'manual result' })))
    runtime.register({
      descriptor: {
        id: 'internal', name: 'internal', description: '', source: 'ORIGREAD_INTERNAL', sourceId: null,
        risk: 'READ_ONLY', enabled: true, inputSchema: { type: 'object' }, outputSchema: null
      },
      execute: async () => ({ status: 'SUCCESS', content: 'internal' })
    })
    const service = new ManualToolContextService(runtime)
    expect(service.listTools().map((tool) => tool.id)).toEqual(['mcp:read'])

    const executed = await service.execute({ conversationId: 'conversation-1', toolId: 'mcp:read', argumentsJson: '{}', confirmed: false })
    expect(executed).toMatchObject({ conversationId: 'conversation-1', toolId: 'mcp:read', risk: 'READ_ONLY', resultPreview: 'manual result' })
    const consumed = service.consume('conversation-1', [executed.contextId])
    expect(consumed.contextItems).toMatchObject([{
      id: executed.contextId, type: 'TOOL_RESULT', sourceId: 'mcp:read', content: 'manual result', priority: 90
    }])
    expect(consumed.evidenceGroups[0]?.blocks[0]).toMatchObject({
      kind: 'TOOL_RESULT',
      locator: { sourceKind: 'TOOL_RESULT', toolId: 'mcp:read', toolSourceId: 'server-1' }
    })
    expect(() => service.consume('conversation-1', [executed.contextId])).toThrow('已失效')
  })

  it('requires one-shot confirmation for sensitive/write manual tools', async () => {
    let calls = 0
    const runtime = new LlmToolRuntime()
    runtime.register(mcpTool('mcp:write', 'WRITE', async () => { calls += 1; return { status: 'SUCCESS', content: 'done' } }))
    const service = new ManualToolContextService(runtime)

    await expect(service.execute({ conversationId: 'c', toolId: 'mcp:write', argumentsJson: '{}', confirmed: false }))
      .rejects.toThrow('明确确认')
    expect(calls).toBe(0)
    await expect(service.execute({ conversationId: 'c', toolId: 'mcp:write', argumentsJson: '{}', confirmed: true }))
      .resolves.toMatchObject({ risk: 'WRITE', resultPreview: 'done' })
    expect(calls).toBe(1)
  })

  it('rejects context handles from another conversation without consuming them', async () => {
    const runtime = new LlmToolRuntime()
    runtime.register(mcpTool('mcp:read', 'READ_ONLY', async () => ({ status: 'SUCCESS', content: 'kept' })))
    const service = new ManualToolContextService(runtime)
    const executed = await service.execute({ conversationId: 'owner', toolId: 'mcp:read', argumentsJson: '{}', confirmed: false })
    expect(() => service.consume('attacker', [executed.contextId])).toThrow('不属于当前会话')
    expect(service.consume('owner', [executed.contextId]).contextItems[0]?.content).toBe('kept')
  })
})
