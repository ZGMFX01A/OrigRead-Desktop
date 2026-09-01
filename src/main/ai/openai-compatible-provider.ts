import type { ResolvedAiOutputTokenLimitStyle } from './ai-provider-capabilities'
import { NETWORK_REQUEST_TIMEOUT_MS, requestSignal } from '../network/request-policy'
import type { ProviderReasoningParameter } from '../../shared/llm'

export interface AiRuntimeConfig {
  endpoint: string
  model: string
  apiKey: string
  temperature?: number
  maxOutputTokens?: number
  outputTokenLimitStyle?: ResolvedAiOutputTokenLimitStyle
  strictStreamTermination?: boolean
  requestTimeoutMs?: number
  reasoningParameter?: ProviderReasoningParameter | null
  onTiming?: AiTransportTimingListener
}

export type AiTransportTimingMetric = 'request_start' | 'TTFB' | 'first_sse' | 'TTFR' | 'TTFC'
export interface AiTransportTimingEvent { metric: AiTransportTimingMetric; elapsedMs: number }
export type AiTransportTimingListener = (event: AiTransportTimingEvent) => void

export interface AiCompletionResult {
  content: string
  reasoning: string | null
}

export interface AiCompletionDelta {
  content: string
  reasoning: string
  finishReason: string | null
}

export type AiCompletionDeltaListener = (delta: AiCompletionDelta) => void

export interface AiChatToolCall {
  id: string
  name: string
  argumentsJson: string
}

export interface AiChatToolCallDelta {
  index: number
  id: string
  name: string
  argumentsDelta: string
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: readonly AiChatToolCall[]
}

export interface AiChatToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AiChatCompletionResult extends AiCompletionResult {
  finishReason: string | null
  toolCalls: AiChatToolCall[]
}

export interface AiChatCompletionDelta extends AiCompletionDelta {
  toolCalls: AiChatToolCallDelta[]
}

export type AiChatCompletionDeltaListener = (delta: AiChatCompletionDelta) => void

export class OpenAiCompatibleProvider {
  async completeDetailed(systemPrompt: string, userPrompt: string, config: AiRuntimeConfig, signal?: AbortSignal): Promise<AiCompletionResult> {
    const result = await this.completeChatDetailed(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      config,
      [],
      signal
    )
    if (!result.content.trim()) throw new Error('AI 服务没有返回有效内容')
    return { content: result.content, reasoning: result.reasoning }
  }

  async completeChatDetailed(
    messages: readonly AiChatMessage[],
    config: AiRuntimeConfig,
    tools: readonly AiChatToolDefinition[] = [],
    signal?: AbortSignal
  ): Promise<AiChatCompletionResult> {
    if (!config.endpoint.trim() || !config.model.trim()) throw new Error('AI 服务地址和模型不能为空')
    validateChatMessages(messages)
    const requestStartedAt = performance.now()
    emitTiming(config.onTiming, 'request_start', 0)
    const response = await fetch(chatEndpoint(config.endpoint), {
      method: 'POST',
      headers: headers(config.apiKey),
      body: JSON.stringify(chatCompletionRequestBody(messages, config, false, tools)),
      signal: requestSignal(signal, config.requestTimeoutMs ?? NETWORK_REQUEST_TIMEOUT_MS.AI_COMPLETION)
    })
    emitTiming(config.onTiming, 'TTFB', performance.now() - requestStartedAt)
    const text = await response.text()
    ensureAiResponse(response.status, text)
    const parsed = parseChatCompletionResponse(text)
    if (parsed.reasoning) emitTiming(config.onTiming, 'TTFR', performance.now() - requestStartedAt)
    if (parsed.content) emitTiming(config.onTiming, 'TTFC', performance.now() - requestStartedAt)
    return parsed
  }

  /**
   * OpenAI-compatible Chat Completions 真流式请求。
   *
   * 不依赖响应 Content-Type：只要正文出现 `data:` SSE 就按流解析；若兼容服务忽略
   * `stream=true` 并直接返回完整 JSON，则回退到与 completeDetailed 相同的解析逻辑。
   */
  async streamDetailed(
    systemPrompt: string,
    userPrompt: string,
    config: AiRuntimeConfig,
    onDelta: AiCompletionDeltaListener,
    signal?: AbortSignal
  ): Promise<AiCompletionResult> {
    const result = await this.streamChatDetailed(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      config,
      (delta) => onDelta({ content: delta.content, reasoning: delta.reasoning, finishReason: delta.finishReason }),
      [],
      signal
    )
    return { content: result.content, reasoning: result.reasoning }
  }

  async streamChatDetailed(
    messages: readonly AiChatMessage[],
    config: AiRuntimeConfig,
    onDelta: AiChatCompletionDeltaListener,
    tools: readonly AiChatToolDefinition[] = [],
    signal?: AbortSignal
  ): Promise<AiChatCompletionResult> {
    if (!config.endpoint.trim() || !config.model.trim()) throw new Error('AI 服务地址和模型不能为空')
    validateChatMessages(messages)
    const requestStartedAt = performance.now()
    emitTiming(config.onTiming, 'request_start', 0)
    const response = await fetch(chatEndpoint(config.endpoint), {
      method: 'POST',
      headers: { ...headers(config.apiKey), Accept: 'text/event-stream, application/json' },
      body: JSON.stringify(chatCompletionRequestBody(messages, config, true, tools)),
      signal: requestSignal(signal, config.requestTimeoutMs ?? NETWORK_REQUEST_TIMEOUT_MS.AI_STREAMING)
    })
    emitTiming(config.onTiming, 'TTFB', performance.now() - requestStartedAt)

    if (!response.ok) {
      const body = await response.text()
      ensureAiResponse(response.status, body)
    }
    if (!response.body) throw new Error('AI 服务返回了空响应')
    return readStreamingChatCompletion(
      response.body,
      onDelta,
      config.strictStreamTermination !== false,
      requestStartedAt,
      config.onTiming
    )
  }

  async complete(systemPrompt: string, userPrompt: string, config: AiRuntimeConfig): Promise<string> {
    return (await this.completeDetailed(systemPrompt, userPrompt, config)).content
  }

  async listModels(endpoint: string, apiKey: string): Promise<string[]> {
    const response = await fetch(modelsEndpoint(endpoint), {
      headers: headers(apiKey),
      signal: requestSignal(undefined, NETWORK_REQUEST_TIMEOUT_MS.AI_MODEL_LIST)
    })
    const text = await response.text()
    ensureAiResponse(response.status, text)
    let root: unknown
    try { root = JSON.parse(text) } catch { throw new Error('AI 模型接口返回了无法解析的 JSON') }
    const items = Array.isArray(root)
      ? root
      : isRecord(root) && Array.isArray(root.data)
        ? root.data
        : isRecord(root) && Array.isArray(root.models)
          ? root.models
          : []
    return [...new Set(items.map(modelId).filter(Boolean))].sort() as string[]
  }
}

export function chatEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, '')
  if (!endpoint) throw new Error('AI 服务地址不能为空')
  if (endpoint.endsWith('/chat/completions')) return endpoint
  if (endpoint.endsWith('/v1')) return `${endpoint}/chat/completions`
  const url = new URL(endpoint)
  if (url.pathname === '/' || url.pathname === '') return `${endpoint}/v1/chat/completions`
  return `${endpoint}/v1/chat/completions`
}

export function modelsEndpoint(value: string): string {
  const endpoint = value.trim().replace(/\/+$/, '')
  if (!endpoint) throw new Error('AI 服务地址不能为空')
  if (endpoint.endsWith('/models')) return endpoint
  if (endpoint.endsWith('/chat/completions')) return `${endpoint.slice(0, -'/chat/completions'.length)}/models`
  if (endpoint.endsWith('/v1')) return `${endpoint}/models`
  const url = new URL(endpoint)
  if (url.pathname === '/' || url.pathname === '') return `${endpoint}/v1/models`
  return `${endpoint}/v1/models`
}

function headers(apiKey: string): Record<string, string> {
  const result: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (apiKey.trim()) result.Authorization = `Bearer ${apiKey.trim()}`
  return result
}

function ensureAiResponse(status: number, body: string): void {
  if (status >= 200 && status < 300) return
  const detail = errorDetail(body)
  const suffix = detail ? `：${detail}` : ''
  if ([400,404,405,422].includes(status)) throw new Error(`AI 请求参数或接口地址无效（HTTP ${status}）${suffix}`)
  if ([401,403].includes(status)) throw new Error(`AI 服务鉴权失败（HTTP ${status}）${suffix}`)
  if (status === 429) throw new Error(`AI 服务请求过于频繁或额度已用尽（HTTP 429）${suffix}`)
  if (status >= 500) throw new Error(`AI 服务暂时不可用（HTTP ${status}）${suffix}`)
  throw new Error(`AI 网络请求失败（HTTP ${status}）${suffix}`)
}

function errorDetail(body: string): string {
  try {
    const value = JSON.parse(body) as unknown
    if (isRecord(value)) {
      const nested = isRecord(value.error) ? value.error : null
      return (stringValue(value.message) || stringValue(value.detail) || stringValue(value.description) || stringValue(nested?.message)).slice(0, 400)
    }
  } catch { /* ignore */ }
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)
}

function chatCompletionRequestBody(
  messages: readonly AiChatMessage[],
  config: AiRuntimeConfig,
  stream: boolean,
  tools: readonly AiChatToolDefinition[] = []
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream,
    temperature: config.temperature ?? 0.2,
    messages: messages.map(chatMessageRequestBody)
  }
  if (tools.length > 0) body.tools = tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }))
  if (config.reasoningParameter) body[config.reasoningParameter.key] = config.reasoningParameter.value
  const maxOutputTokens = config.maxOutputTokens
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    const field = config.outputTokenLimitStyle === 'MAX_COMPLETION_TOKENS' ? 'max_completion_tokens' : 'max_tokens'
    body[field] = Math.trunc(maxOutputTokens)
  }
  return body
}

async function readStreamingChatCompletion(
  body: ReadableStream<Uint8Array>,
  onDelta: AiChatCompletionDeltaListener,
  strictStreamTermination: boolean,
  requestStartedAt: number,
  onTiming?: AiTransportTimingListener
): Promise<AiChatCompletionResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const fallbackBody: string[] = []
  const content: string[] = []
  const explicitReasoning: string[] = []
  const inlineReasoning: string[] = []
  const thinkSplitter = new ThinkStreamSplitter()
  const toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>()
  let pending = ''
  let sawSseData = false
  let sawTerminalEvent = false
  let sawReasoning = false
  let sawContent = false
  let finishReason: string | null = null

  const consumeLine = (line: string): void => {
    if (line.startsWith('data:')) {
      if (!sawSseData) {
        sawSseData = true
        emitTiming(onTiming, 'first_sse', performance.now() - requestStartedAt)
      }
      const payload = line.slice('data:'.length).trim()
      if (!payload) return
      if (payload === '[DONE]') {
        sawTerminalEvent = true
        return
      }
      const raw = parseCompletionStreamPayload(payload)
      if (!raw) return
      if (raw.finishReason) {
        sawTerminalEvent = true
        finishReason = raw.finishReason
      }
      const split = thinkSplitter.accept(raw.content)
      if (raw.reasoning) explicitReasoning.push(raw.reasoning)
      if (split.reasoning) inlineReasoning.push(split.reasoning)
      if (split.content) content.push(split.content)
      const reasoning = raw.reasoning + split.reasoning
      for (const call of raw.toolCalls) {
        const current = toolCalls.get(call.index) ?? { id: '', name: '', argumentsJson: '' }
        if (call.id) current.id = call.id
        if (call.name) current.name = call.name
        current.argumentsJson += call.argumentsDelta
        toolCalls.set(call.index, current)
      }
      if (reasoning && !sawReasoning) {
        sawReasoning = true
        emitTiming(onTiming, 'TTFR', performance.now() - requestStartedAt)
      }
      if (split.content && !sawContent) {
        sawContent = true
        emitTiming(onTiming, 'TTFC', performance.now() - requestStartedAt)
      }
      if (split.content || reasoning || raw.finishReason || raw.toolCalls.length > 0) {
        onDelta({ content: split.content, reasoning, finishReason: raw.finishReason, toolCalls: raw.toolCalls })
      }
      return
    }
    if (!sawSseData && line.trim()) fallbackBody.push(line)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        consumeLine(line)
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending) consumeLine(pending.replace(/\r$/, ''))
  } finally {
    reader.releaseLock()
  }

  if (!sawSseData) {
    const parsed = parseChatCompletionResponse(fallbackBody.join('\n'))
    if (parsed.reasoning) emitTiming(onTiming, 'TTFR', performance.now() - requestStartedAt)
    if (parsed.content) emitTiming(onTiming, 'TTFC', performance.now() - requestStartedAt)
    onDelta({
      content: parsed.content,
      reasoning: parsed.reasoning ?? '',
      finishReason: parsed.finishReason,
      toolCalls: parsed.toolCalls.map((call, index) => ({
        index, id: call.id, name: call.name, argumentsDelta: call.argumentsJson
      }))
    })
    return parsed
  }
  if (strictStreamTermination && !sawTerminalEvent) throw new Error('AI 流式响应提前结束，未收到完成标记')

  const tail = thinkSplitter.finish()
  if (tail.content) content.push(tail.content)
  if (tail.reasoning) inlineReasoning.push(tail.reasoning)
  if (tail.content || tail.reasoning) onDelta({ ...tail, finishReason: null, toolCalls: [] })

  const finalContent = content.join('').trim()
  const finalReasoning = (explicitReasoning.join('').trim() || inlineReasoning.join('').trim()) || null
  const finalToolCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([_index, call]) => ({ ...call }))
  if (!finalContent && !finalReasoning && finalToolCalls.length === 0) throw new Error('AI 服务没有返回有效内容')
  if (finalToolCalls.some((call) => !call.id.trim() || !call.name.trim())) throw new Error('AI Tool Call 流式响应不完整')
  return { content: finalContent, reasoning: finalReasoning, finishReason, toolCalls: finalToolCalls }
}

function parseCompletionStreamPayload(payload: string): AiChatCompletionDelta | null {
  let root: unknown
  try { root = JSON.parse(payload) } catch { throw new Error('AI 流式响应不是有效 JSON') }
  if (!isRecord(root)) return null
  if (isRecord(root.error)) {
    const detail = stringValue(root.error.message) || 'AI 服务返回错误'
    throw new Error(detail)
  }
  const choice = getFirstChoice(root)
  if (!choice) return null
  const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null
  const finishReason = stringValue(choice.finish_reason).trim() || null
  if (!delta) return finishReason ? { content: '', reasoning: '', finishReason, toolCalls: [] } : null
  const content = contentValue(delta.content)
  const reasoning = contentValue(delta.reasoning_content) || contentValue(delta.reasoning)
  const toolCalls = parseToolCallDeltas(delta.tool_calls)
  if (!content && !reasoning && !finishReason && toolCalls.length === 0) return null
  return { content, reasoning, finishReason, toolCalls }
}

function parseChatCompletionResponse(text: string): AiChatCompletionResult {
  let root: unknown
  try { root = JSON.parse(text) } catch { throw new Error('AI 服务返回了无法解析的 JSON') }
  const choice = getFirstChoice(root)
  const message = isRecord(choice?.message) ? choice.message : null
  const rawContent = contentValue(message?.content) || stringValue(choice?.text)
  const explicitReasoning = contentValue(message?.reasoning_content) || contentValue(message?.reasoning)
  const extracted = extractThinkBlock(rawContent)
  const content = extracted.content.trim()
  const reasoning = (explicitReasoning || extracted.reasoning || '').trim() || null
  const finishReason = stringValue(choice?.finish_reason).trim() || null
  const toolCalls = parseToolCalls(message?.tool_calls)
  if (!content && !reasoning && toolCalls.length === 0) throw new Error('AI 服务没有返回有效内容')
  return { content, reasoning, finishReason, toolCalls }
}

function chatMessageRequestBody(message: AiChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    if (!message.toolCallId?.trim()) throw new Error('Tool message 缺少 toolCallId')
    return { role: 'tool', tool_call_id: message.toolCallId.trim(), content: message.content }
  }
  const result: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson }
    }))
  }
  return result
}

function validateChatMessages(messages: readonly AiChatMessage[]): void {
  if (messages.length === 0) throw new Error('AI Chat messages 不能为空')
  for (const message of messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('AI Chat message role 无效')
    if (message.role === 'tool' && !message.toolCallId?.trim()) throw new Error('Tool message 缺少 toolCallId')
  }
}

function parseToolCallDeltas(value: unknown): AiChatToolCallDelta[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, fallbackIndex) => {
    if (!isRecord(item)) return []
    const fn = isRecord(item.function) ? item.function : null
    const rawIndex = typeof item.index === 'number' && Number.isFinite(item.index) ? Math.trunc(item.index) : fallbackIndex
    return [{
      index: Math.max(0, rawIndex),
      id: stringValue(item.id),
      name: stringValue(fn?.name),
      argumentsDelta: stringValue(fn?.arguments)
    }]
  })
}

function parseToolCalls(value: unknown): AiChatToolCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const fn = isRecord(item.function) ? item.function : null
    const id = stringValue(item.id).trim()
    const name = stringValue(fn?.name).trim()
    if (!id || !name) return []
    return [{ id, name, argumentsJson: stringValue(fn?.arguments) }]
  })
}

function contentValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    if (!isRecord(part)) return ''
    return stringValue(part.text) || stringValue(part.content)
  }).join('')
}

function emitTiming(listener: AiTransportTimingListener | undefined, metric: AiTransportTimingMetric, elapsedMs: number): void {
  listener?.({ metric, elapsedMs: Math.max(0, Math.round(elapsedMs * 10) / 10) })
}

class ThinkStreamSplitter {
  private pending = ''
  private insideThink = false

  accept(chunk: string): Omit<AiCompletionDelta, 'finishReason'> {
    if (chunk) this.pending += chunk
    return this.drain(false)
  }

  finish(): Omit<AiCompletionDelta, 'finishReason'> {
    return this.drain(true)
  }

  private drain(finishing: boolean): Omit<AiCompletionDelta, 'finishReason'> {
    let content = ''
    let reasoning = ''
    while (this.pending) {
      const tag = this.insideThink ? '</think>' : '<think>'
      const tagIndex = this.pending.toLowerCase().indexOf(tag)
      if (tagIndex >= 0) {
        const visible = this.pending.slice(0, tagIndex)
        if (this.insideThink) reasoning += visible
        else content += visible
        this.pending = this.pending.slice(tagIndex + tag.length)
        this.insideThink = !this.insideThink
        continue
      }

      if (finishing) {
        if (this.insideThink) reasoning += this.pending
        else content += this.pending
        this.pending = ''
        break
      }

      const retained = longestTagPrefixSuffix(this.pending, tag)
      const emitLength = this.pending.length - retained
      if (emitLength > 0) {
        const visible = this.pending.slice(0, emitLength)
        if (this.insideThink) reasoning += visible
        else content += visible
        this.pending = this.pending.slice(emitLength)
      }
      break
    }
    return { content, reasoning }
  }
}

function longestTagPrefixSuffix(value: string, tag: string): number {
  const normalizedValue = value.toLowerCase()
  const maxLength = Math.min(value.length, tag.length - 1)
  for (let length = maxLength; length >= 1; length -= 1) {
    if (normalizedValue.slice(-length) === tag.slice(0, length)) return length
  }
  return 0
}

function getFirstChoice(root: unknown): Record<string, unknown> | null {
  if (!isRecord(root) || !Array.isArray(root.choices)) return null
  return isRecord(root.choices[0]) ? root.choices[0] : null
}
function modelId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  return (stringValue(value.id) || stringValue(value.model) || stringValue(value.name)).trim()
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function extractThinkBlock(value: string): { content: string; reasoning: string | null } {
  const matches = [...value.matchAll(/<think>([\s\S]*?)<\/think>/gi)]
  if (!matches.length) return { content: value, reasoning: null }
  const reasoning = matches.map((match) => match[1]?.trim()).filter(Boolean).join('\n\n')
  return { content: value.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(), reasoning: reasoning || null }
}

