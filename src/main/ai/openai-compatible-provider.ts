export interface AiRuntimeConfig {
  endpoint: string
  model: string
  apiKey: string
}

export interface AiCompletionResult {
  content: string
  reasoning: string | null
}

export class OpenAiCompatibleProvider {
  async completeDetailed(systemPrompt: string, userPrompt: string, config: AiRuntimeConfig): Promise<AiCompletionResult> {
    if (!config.endpoint.trim() || !config.model.trim()) throw new Error('AI 服务地址和模型不能为空')
    const response = await fetch(chatEndpoint(config.endpoint), {
      method: 'POST',
      headers: headers(config.apiKey),
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: AbortSignal.timeout(60_000)
    })
    const text = await response.text()
    ensureAiResponse(response.status, text)
    let root: unknown
    try { root = JSON.parse(text) } catch { throw new Error('AI 服务返回了无法解析的 JSON') }
    const choice = getFirstChoice(root)
    const message = isRecord(choice?.message) ? choice.message : null
    const rawContent = stringValue(message?.content) || stringValue(choice?.text)
    if (!rawContent.trim()) throw new Error('AI 服务没有返回有效内容')
    const explicitReasoning = stringValue(message?.reasoning_content) || stringValue(message?.reasoning)
    const extracted = extractThinkBlock(rawContent)
    return {
      content: extracted.content.trim(),
      reasoning: (explicitReasoning || extracted.reasoning || '').trim() || null
    }
  }

  async complete(systemPrompt: string, userPrompt: string, config: AiRuntimeConfig): Promise<string> {
    return (await this.completeDetailed(systemPrompt, userPrompt, config)).content
  }

  async listModels(endpoint: string, apiKey: string): Promise<string[]> {
    const response = await fetch(modelsEndpoint(endpoint), { headers: headers(apiKey), signal: AbortSignal.timeout(20_000) })
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

