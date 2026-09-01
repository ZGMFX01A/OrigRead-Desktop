import type { LlmExecutionIdentity, LlmSerializedError } from '../../shared/llm-ipc'

export interface RegisteredLlmExecution extends LlmExecutionIdentity {
  ownerId: string
  signal: AbortSignal
}

interface ActiveExecution extends LlmExecutionIdentity {
  ownerId: string
  controller: AbortController
}

/**
 * Main-process lifecycle owner for long LLM requests.
 * One Renderer/WebContents owner may have multiple requests; destroying that owner aborts all of them.
 */
export class LlmExecutionRegistry {
  private readonly active = new Map<string, ActiveExecution>()

  begin(identity: LlmExecutionIdentity, ownerId: string): RegisteredLlmExecution {
    const requestId = requiredId(identity.requestId, 'requestId')
    if (this.active.has(requestId)) throw new Error(`LLM requestId 已存在：${requestId}`)
    const execution: ActiveExecution = {
      requestId,
      conversationId: requiredId(identity.conversationId, 'conversationId'),
      assistantMessageId: requiredId(identity.assistantMessageId, 'assistantMessageId'),
      ownerId: requiredId(ownerId, 'ownerId'),
      controller: new AbortController()
    }
    this.active.set(requestId, execution)
    return { ...identityFromActive(execution), ownerId: execution.ownerId, signal: execution.controller.signal }
  }

  finish(requestId: string): boolean {
    return this.active.delete(requestId.trim())
  }

  cancel(requestId: string, reason = 'LLM request cancelled'): boolean {
    const execution = this.active.get(requestId.trim())
    if (!execution) return false
    this.active.delete(execution.requestId)
    execution.controller.abort(new DOMException(reason, 'AbortError'))
    return true
  }

  cancelOwned(requestId: string, ownerId: string, reason = 'LLM request cancelled'): boolean {
    const execution = this.active.get(requestId.trim())
    if (!execution || execution.ownerId !== ownerId.trim()) return false
    return this.cancel(execution.requestId, reason)
  }

  cancelOwner(ownerId: string, reason = 'Renderer was destroyed'): number {
    const normalizedOwner = ownerId.trim()
    let cancelled = 0
    for (const execution of [...this.active.values()]) {
      if (execution.ownerId !== normalizedOwner) continue
      if (this.cancel(execution.requestId, reason)) cancelled += 1
    }
    return cancelled
  }

  get(requestId: string): RegisteredLlmExecution | null {
    const execution = this.active.get(requestId.trim())
    return execution
      ? { ...identityFromActive(execution), ownerId: execution.ownerId, signal: execution.controller.signal }
      : null
  }

  size(): number { return this.active.size }
}

export function serializeLlmIpcError(error: unknown, signal?: AbortSignal): LlmSerializedError {
  if (signal?.aborted || isAbortError(error)) {
    return { code: 'CANCELLED', message: '请求已停止', retryable: true }
  }
  const message = safeErrorMessage(error)
  if (/不存在|not found/i.test(message)) return { code: 'NOT_FOUND', message, retryable: false }
  if (/无效|不能为空|invalid|unsupported/i.test(message)) return { code: 'INVALID_REQUEST', message, retryable: false }
  if (/provider|模型|AI 服务|HTTP|network|网络|timeout|timed out/i.test(message)) {
    return { code: 'PROVIDER_ERROR', message, retryable: true }
  }
  if (/tool/i.test(message)) return { code: 'TOOL_ERROR', message, retryable: true }
  return { code: 'INTERNAL_ERROR', message: 'LLM 请求失败', retryable: false }
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) throw new TypeError(`${field} 无效`)
  return normalized
}

function identityFromActive(execution: ActiveExecution): LlmExecutionIdentity {
  return {
    requestId: execution.requestId,
    conversationId: execution.conversationId,
    assistantMessageId: execution.assistantMessageId
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '请求失败'
}
