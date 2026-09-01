import { requestSignal } from '../network/request-policy'
import {
  webSearchProviderDefinition,
  type WebSearchProviderKind,
  type WebSearchProviderProfile,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult
} from '../../shared/web-search'

export class WebSearchException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebSearchException'
  }
}

export interface WebSearchProviderAdapter {
  readonly kind: WebSearchProviderKind
  search(profile: WebSearchProviderProfile, apiKey: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse>
}

export class TavilyWebSearchAdapter implements WebSearchProviderAdapter {
  readonly kind = 'TAVILY' as const

  async search(profile: WebSearchProviderProfile, apiKey: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
    requireProfile(profile, this.kind)
    if (!apiKey.trim()) throw new WebSearchException('Tavily 缺少 API Key')
    const payload = await fetchSearchJson(profile.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: request.query,
        search_depth: 'basic',
        max_results: request.maxResults,
        include_answer: false,
        include_raw_content: request.includeContent
      })
    }, request.timeoutMs, signal, 'Tavily')
    return parseTavilyResponse(profile, payload)
  }
}

export class ExaWebSearchAdapter implements WebSearchProviderAdapter {
  readonly kind = 'EXA' as const

  async search(profile: WebSearchProviderProfile, apiKey: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
    requireProfile(profile, this.kind)
    if (!apiKey.trim()) throw new WebSearchException('Exa 缺少 API Key')
    const payload = await fetchSearchJson(profile.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey.trim(),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: request.query,
        type: 'auto',
        numResults: request.maxResults,
        contents: {
          highlights: true,
          ...(request.includeContent ? { text: true } : {})
        }
      })
    }, request.timeoutMs, signal, 'Exa')
    return parseExaResponse(profile, payload)
  }
}

export class KeenableWebSearchAdapter implements WebSearchProviderAdapter {
  readonly kind = 'KEENABLE' as const

  async search(profile: WebSearchProviderProfile, apiKey: string, request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResponse> {
    requireProfile(profile, this.kind)
    const normalizedApiKey = apiKey.trim()
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
    if (normalizedApiKey) headers['X-API-Key'] = normalizedApiKey
    else headers['X-Keenable-Title'] = 'OrigRead'
    const payload = await fetchSearchJson(resolveKeenableEndpoint(profile.endpoint, Boolean(normalizedApiKey)), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: request.query, max_results: request.maxResults })
    }, request.timeoutMs, signal, 'Keenable')
    return parseKeenableResponse(profile, payload)
  }
}

export function parseTavilyResponse(profile: WebSearchProviderProfile, payload: unknown): WebSearchResponse {
  const root = asRecord(payload, 'Tavily')
  return response(profile, Array.isArray(root.results) ? root.results.flatMap((item) => {
    const record = isRecord(item) ? item : null
    const url = stringValue(record?.url)
    if (!record || !url) return []
    return [result({
      title: stringValue(record.title) || url,
      url,
      snippet: stringValue(record.content),
      publishedAt: stringValue(record.published_date) || null,
      content: stringValue(record.raw_content) || null,
      metadata: typeof record.score === 'number' ? { score: record.score } : undefined
    })]
  }) : [], stringValue(root.answer) || null)
}

export function parseExaResponse(profile: WebSearchProviderProfile, payload: unknown): WebSearchResponse {
  const root = asRecord(payload, 'Exa')
  return response(profile, Array.isArray(root.results) ? root.results.flatMap((item) => {
    const record = isRecord(item) ? item : null
    const url = stringValue(record?.url)
    if (!record || !url) return []
    const highlights = Array.isArray(record.highlights)
      ? record.highlights.map(stringValue).filter(Boolean).join(' … ')
      : ''
    const text = stringValue(record.text)
    return [result({
      title: stringValue(record.title) || url,
      url,
      snippet: highlights || text.slice(0, 1_500),
      publishedAt: stringValue(record.publishedDate) || null,
      content: text || null,
      metadata: stringValue(record.author) ? { author: stringValue(record.author) } : undefined
    })]
  }) : [])
}

export function parseKeenableResponse(profile: WebSearchProviderProfile, payload: unknown): WebSearchResponse {
  const root = asRecord(payload, 'Keenable')
  return response(profile, Array.isArray(root.results) ? root.results.flatMap((item) => {
    const record = isRecord(item) ? item : null
    const url = stringValue(record?.url)
    if (!record || !url) return []
    return [result({
      title: stringValue(record.title) || url,
      url,
      snippet: stringValue(record.snippet) || stringValue(record.description),
      publishedAt: stringValue(record.published_at) || null,
      content: null
    })]
  }) : [])
}

export function resolveKeenableEndpoint(endpoint: string, hasApiKey: boolean): string {
  const url = new URL(endpoint.trim())
  if (url.hostname !== 'api.keenable.ai') return url.toString()
  const path = url.pathname.replace(/\/+$/, '')
  if (path === '/v1/search' || path === '/v1/search/public') {
    url.pathname = hasApiKey ? '/v1/search' : '/v1/search/public'
  }
  return url.toString()
}

async function fetchSearchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  providerName: string
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: requestSignal(signal, timeoutMs) })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new WebSearchException(`${providerName} 搜索超时`, { cause: error })
    throw error
  }
  const text = await response.text()
  if (!response.ok) throw new WebSearchException(`${providerName} 搜索失败：HTTP ${response.status}${searchErrorSuffix(text)}`)
  try { return JSON.parse(text) } catch (error) { throw new WebSearchException(`${providerName} 返回了无效 JSON`, { cause: error }) }
}

function response(profile: WebSearchProviderProfile, results: WebSearchResult[], answer: string | null = null): WebSearchResponse {
  return {
    providerId: profile.id,
    providerName: profile.name,
    backendKind: webSearchProviderDefinition(profile.kind).backendKind,
    results,
    answer
  }
}

function result(value: Omit<WebSearchResult, 'source'>): WebSearchResult {
  return { ...value, source: sourceFromUrl(value.url) }
}

function sourceFromUrl(value: string): string | null {
  try { return new URL(value).hostname || null } catch { return null }
}

function requireProfile(profile: WebSearchProviderProfile, kind: WebSearchProviderKind): void {
  if (profile.kind !== kind) throw new WebSearchException(`${kind} Adapter 收到错误 Provider 类型`)
}

function asRecord(value: unknown, providerName: string): Record<string, unknown> {
  if (!isRecord(value)) throw new WebSearchException(`${providerName} 返回了无效 JSON`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function searchErrorSuffix(text: string): string {
  try {
    const root = JSON.parse(text) as unknown
    if (!isRecord(root)) return ''
    const message = stringValue(root.detail) || stringValue(root.message) || stringValue(root.error)
    return message ? `：${message.slice(0, 240)}` : ''
  } catch {
    return ''
  }
}
