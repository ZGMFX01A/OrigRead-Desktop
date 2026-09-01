import { describe, expect, it } from 'vitest'
import { LlmExecutionRegistry, serializeLlmIpcError } from './execution-registry'

describe('LlmExecutionRegistry D2.7 lifecycle', () => {
  it('tracks request/message identity and propagates explicit cancellation through AbortSignal', () => {
    const registry = new LlmExecutionRegistry()
    const execution = registry.begin({ requestId: 'request-1', conversationId: 'conversation-1', assistantMessageId: 'assistant-1' }, 'renderer-1')
    expect(execution.signal.aborted).toBe(false)
    expect(registry.get('request-1')).toMatchObject({ requestId: 'request-1', assistantMessageId: 'assistant-1', ownerId: 'renderer-1' })
    expect(registry.cancel('request-1')).toBe(true)
    expect(execution.signal.aborted).toBe(true)
    expect(registry.size()).toBe(0)
    expect(registry.cancel('request-1')).toBe(false)
  })

  it('cancels every request owned by a destroyed Renderer without touching other owners', () => {
    const registry = new LlmExecutionRegistry()
    const first = registry.begin({ requestId: 'r1', conversationId: 'c', assistantMessageId: 'a1' }, 'renderer-a')
    const second = registry.begin({ requestId: 'r2', conversationId: 'c', assistantMessageId: 'a2' }, 'renderer-a')
    const other = registry.begin({ requestId: 'r3', conversationId: 'c', assistantMessageId: 'a3' }, 'renderer-b')
    expect(registry.cancelOwner('renderer-a')).toBe(2)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(false)
    expect(registry.size()).toBe(1)
  })

  it('does not let one Renderer cancel another owner request by guessing requestId', () => {
    const registry = new LlmExecutionRegistry()
    const execution = registry.begin({ requestId: 'private-request', conversationId: 'c', assistantMessageId: 'a' }, 'renderer-a')
    expect(registry.cancelOwned('private-request', 'renderer-b')).toBe(false)
    expect(execution.signal.aborted).toBe(false)
    expect(registry.cancelOwned('private-request', 'renderer-a')).toBe(true)
    expect(execution.signal.aborted).toBe(true)
  })

  it('rejects duplicate request IDs and removes completed requests without aborting them', () => {
    const registry = new LlmExecutionRegistry()
    const execution = registry.begin({ requestId: 'same', conversationId: 'c', assistantMessageId: 'a' }, 'renderer')
    expect(() => registry.begin({ requestId: 'same', conversationId: 'c', assistantMessageId: 'b' }, 'renderer')).toThrow('已存在')
    expect(registry.finish('same')).toBe(true)
    expect(execution.signal.aborted).toBe(false)
  })
})

describe('serializeLlmIpcError', () => {
  it('does not serialize stack, prompt or arbitrary internal details for unknown failures', () => {
    const error = new Error('database exploded secret-api-key prompt body')
    const serialized = serializeLlmIpcError(error)
    expect(serialized).toEqual({ code: 'INTERNAL_ERROR', message: 'LLM 请求失败', retryable: false })
    expect(JSON.stringify(serialized)).not.toContain('secret-api-key')
    expect(JSON.stringify(serialized)).not.toContain('prompt body')
    expect(serialized).not.toHaveProperty('stack')
  })

  it('serializes cancellation and expected provider failures without exposing Error objects', () => {
    expect(serializeLlmIpcError(new DOMException('user stopped', 'AbortError'))).toEqual({
      code: 'CANCELLED', message: '请求已停止', retryable: true
    })
    expect(serializeLlmIpcError(new Error('AI 服务暂时不可用（HTTP 503）'))).toEqual({
      code: 'PROVIDER_ERROR', message: 'AI 服务暂时不可用（HTTP 503）', retryable: true
    })
  })
})
