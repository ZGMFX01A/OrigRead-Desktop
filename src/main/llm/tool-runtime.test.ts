import { describe, expect, it } from 'vitest'
import type { LlmTool, LlmToolRuntime as RuntimeType } from './tool-runtime'
import { LlmToolRuntime } from './tool-runtime'

function tool(
  id: string,
  patch: Partial<LlmTool['descriptor']> = {},
  execute: LlmTool['execute'] = async (argumentsJson) => ({ status: 'SUCCESS', content: argumentsJson })
): LlmTool {
  return {
    descriptor: {
      id,
      name: id.replace(/[^a-z0-9_]/gi, '_'),
      description: `Tool ${id}`,
      source: 'ORIGREAD_INTERNAL',
      sourceId: 'origread',
      risk: 'READ_ONLY',
      enabled: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: null,
      ...patch
    },
    execute
  }
}

describe('LlmToolRuntime', () => {
  it('rejects duplicate stable IDs instead of silently shadowing another source', () => {
    const runtime = new LlmToolRuntime()
    runtime.register(tool('shared-id'))
    expect(() => runtime.register(tool('shared-id', { source: 'NATIVE_PROVIDER' }))).toThrow('Tool id 已被占用')
  })

  it('requires a stable MCP source server ID', () => {
    const runtime = new LlmToolRuntime()
    expect(() => runtime.register(tool('mcp:tool', { source: 'MCP', sourceId: null }))).toThrow('MCP Tool 必须记录来源 Server')
  })

  it('resolves only enabled tools explicitly allowed by the execution profile', () => {
    const runtime = new LlmToolRuntime()
    runtime.register(tool('b'))
    runtime.register(tool('a'))
    runtime.register(tool('off', { enabled: false }))

    expect(runtime.resolveAllowed(new Set(['off', 'b', 'missing', 'a'])).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('auto-executes only trusted internal read-only tools and gates sensitive/write/MCP tools', async () => {
    const runtime = new LlmToolRuntime()
    runtime.register(tool('read'))
    runtime.register(tool('sensitive', { risk: 'SENSITIVE' }))
    runtime.register(tool('mcp:read', { source: 'MCP', sourceId: 'server-1', risk: 'READ_ONLY' }))
    const policy = { enabledToolIds: new Set(['read', 'sensitive', 'mcp:read']) }

    await expect(runtime.execute({ id: '1', toolId: 'read', argumentsJson: '{}' }, policy)).resolves.toEqual({ status: 'SUCCESS', content: '{}' })
    await expect(runtime.execute({ id: '2', toolId: 'sensitive', argumentsJson: '{}' }, policy)).resolves.toMatchObject({ status: 'CONFIRMATION_REQUIRED' })
    await expect(runtime.execute({ id: '3', toolId: 'mcp:read', argumentsJson: '{}' }, policy)).resolves.toMatchObject({ status: 'CONFIRMATION_REQUIRED' })
    await expect(runtime.execute(
      { id: '4', toolId: 'mcp:read', argumentsJson: '{}' },
      policy,
      { confirmed: true }
    )).resolves.toEqual({ status: 'SUCCESS', content: '{}' })
  })

  it('never executes a tool omitted from the request authorization set', async () => {
    let calls = 0
    const runtime = new LlmToolRuntime()
    runtime.register(tool('read', {}, async () => { calls += 1; return { status: 'SUCCESS', content: 'ok' } }))

    await expect(runtime.execute({ id: '1', toolId: 'read', argumentsJson: '{}' }, { enabledToolIds: new Set() }))
      .resolves.toEqual({ status: 'FAILURE', message: '当前执行配置未授权 Tool：read' })
    expect(calls).toBe(0)
  })

  it('returns ordinary execution failures but preserves cancellation', async () => {
    const runtime = new LlmToolRuntime()
    runtime.register(tool('fail', {}, async () => { throw new Error('boom') }))
    runtime.register(tool('cancel', {}, async (_args, signal) => {
      if (signal?.aborted) throw signal.reason
      return { status: 'SUCCESS', content: 'unexpected' }
    }))
    const policy = { enabledToolIds: new Set(['fail', 'cancel']) }

    await expect(runtime.execute({ id: '1', toolId: 'fail', argumentsJson: '{}' }, policy)).resolves.toEqual({ status: 'FAILURE', message: 'boom' })
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(runtime.execute({ id: '2', toolId: 'cancel', argumentsJson: '{}' }, policy, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

// Compile-time check that the exported class remains constructible without hidden dependencies.
const _runtimeTypeCheck: RuntimeType = new LlmToolRuntime()
void _runtimeTypeCheck
