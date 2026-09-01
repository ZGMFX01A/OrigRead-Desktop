import { NETWORK_REQUEST_TIMEOUT_MS } from '../network/request-policy'
import type { WebSearchRepository } from './web-search-repository'
import type { WebSearchProviderSnapshot, WebSearchService } from './web-search-service'
import { WebSearchException } from './web-search-adapters'
import {
  MAX_WEB_SEARCH_QUERY_LENGTH,
  normalizeWebSearchMaxResults,
  type WebSearchDecision,
  type WebSearchMode,
  type WebSearchPreparedPlan,
  type WebSearchResponse,
  type WebSearchRouteResult
} from '../../shared/web-search'

export interface PreparedWebSearchExecution {
  plan: WebSearchPreparedPlan
  providerSnapshot: WebSearchProviderSnapshot | null
}

export class WebSearchRouter {
  constructor(private readonly repository: WebSearchRepository, private readonly service: WebSearchService) {}

  prepareSearch(mode: WebSearchMode, userInput: string, articleTitle?: string | null): PreparedWebSearchExecution {
    const settings = this.repository.current()
    const decision = resolveWebSearchDecision(mode, userInput)
    if (!decision.triggered) return { plan: emptyPlan(mode, decision), providerSnapshot: null }
    const query = buildSearchQuery(articleTitle, userInput)
    const provider = selectConfiguredSearchProvider(this.repository.configuredProviders(), settings.defaultProviderId)
    if (!provider) {
      return {
        plan: {
          ...emptyPlan(mode, decision),
          query,
          preflightErrorMessage: '尚未配置可用的 Web Search Provider'
        },
        providerSnapshot: null
      }
    }
    const timeoutMs = decision.required
      ? NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_FORCE
      : NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_AUTO
    return {
      plan: {
        decision,
        mode,
        query,
        providerId: provider.id,
        providerName: provider.name,
        providerKind: provider.kind,
        request: { query, maxResults: normalizeWebSearchMaxResults(settings.maxResults), includeContent: false, timeoutMs },
        preflightErrorMessage: null
      },
      providerSnapshot: { profile: provider, apiKey: this.repository.getApiKey(provider.id) }
    }
  }

  async executePreparedSearch(prepared: PreparedWebSearchExecution, signal?: AbortSignal): Promise<WebSearchRouteResult> {
    const { plan, providerSnapshot } = prepared
    if (!plan.decision.triggered) return routeResult('NOT_NEEDED')
    if (plan.preflightErrorMessage) {
      return routeResult(plan.decision.required ? 'FAILED_REQUIRED' : 'FAILED_FALLBACK', {
        providerName: plan.providerName,
        errorMessage: plan.preflightErrorMessage,
        requiredFailure: plan.decision.required
      })
    }
    if (!plan.request || !providerSnapshot) throw new Error('已触发 Web Search 但缺少冻结请求')
    try {
      const response = deduplicateWebSearchResults(await this.service.searchPrepared(plan.request, providerSnapshot, signal))
      return buildWebSearchResult(response, plan.decision.required)
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      return buildWebSearchFailureResult(plan.decision.required, plan.providerName ?? providerSnapshot.profile.name, error)
    }
  }
}

export function resolveWebSearchDecision(mode: WebSearchMode, userInput: string): WebSearchDecision {
  if (mode === 'OFF') return { status: 'NOT_NEEDED', required: false, triggered: false }
  const required = mode === 'FORCE'
  const triggered = required || shouldAutoSearch(userInput)
  return { status: triggered ? 'TRIGGERED' : 'NOT_NEEDED', required, triggered }
}

export function shouldAutoSearch(userInput: string): boolean {
  const normalized = userInput.trim()
  if (!normalized) return false
  return CHINESE_DIRECT_TIME_PATTERN.test(normalized)
    || CHINESE_FRESHNESS_PATTERN.test(normalized)
    || CHINESE_EXPLICIT_SEARCH_PATTERN.test(normalized)
    || ENGLISH_AUTO_SEARCH_PATTERN.test(normalized)
    || ENGLISH_CURRENT_FRESHNESS_PATTERN.test(normalized)
    || ENGLISH_UPDATE_FRESHNESS_PATTERN.test(normalized)
}

export function buildSearchQuery(articleTitle: string | null | undefined, userInput: string): string {
  const title = articleTitle?.trim() ?? ''
  const input = userInput.trim()
  const combined = !title || input.toLocaleLowerCase().includes(title.toLocaleLowerCase()) ? input : `${title} — ${input}`
  return combined.slice(0, MAX_WEB_SEARCH_QUERY_LENGTH)
}

export function deduplicateWebSearchResults(response: WebSearchResponse): WebSearchResponse {
  const seen = new Set<string>()
  const results = response.results.filter((result) => {
    const key = webSearchUrlComparisonKey(result.url)
    return Boolean(key) && !seen.has(key) && Boolean(seen.add(key))
  })
  return results.length === response.results.length ? response : { ...response, results }
}

export function buildWebSearchResult(response: WebSearchResponse, required: boolean): WebSearchRouteResult {
  if (response.results.length > 0) return routeResult('SUCCESS', { response, providerName: response.providerName })
  if (required) return routeResult('FAILED_REQUIRED', {
    providerName: response.providerName,
    errorMessage: `${response.providerName} 没有返回可用搜索结果`,
    requiredFailure: true
  })
  return routeResult('EMPTY_RESULT', {
    response,
    providerName: response.providerName,
    errorMessage: `${response.providerName} 没有返回可用搜索结果`
  })
}

export function buildWebSearchFailureResult(required: boolean, providerName: string, error: unknown): WebSearchRouteResult {
  const message = webSearchUserError(providerName, error)
  return routeResult(required ? 'FAILED_REQUIRED' : 'FAILED_FALLBACK', {
    providerName,
    errorMessage: message,
    requiredFailure: required
  })
}

function webSearchUserError(providerName: string, error: unknown): string {
  const existing = error instanceof Error ? error.message.trim() : String(error).trim()
  if (error instanceof WebSearchException && existing) return existing.includes(providerName) ? existing : `${providerName}：${existing}`
  return existing ? `${providerName} 搜索失败：${existing}` : `${providerName} 搜索失败`
}

function routeResult(status: WebSearchRouteResult['status'], patch: Partial<WebSearchRouteResult> = {}): WebSearchRouteResult {
  return {
    status,
    response: null,
    providerName: null,
    errorMessage: null,
    requiredFailure: false,
    ...patch
  }
}

function emptyPlan(mode: WebSearchMode, decision: WebSearchDecision): WebSearchPreparedPlan {
  return {
    decision,
    mode,
    query: null,
    providerId: null,
    providerName: null,
    providerKind: null,
    request: null,
    preflightErrorMessage: null
  }
}

function selectConfiguredSearchProvider(providers: ReturnType<WebSearchRepository['configuredProviders']>, defaultProviderId: string | null) {
  return providers.find((provider) => provider.id === defaultProviderId) ?? providers[0] ?? null
}

function webSearchUrlComparisonKey(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key)
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    url.searchParams.sort()
    return url.toString()
  } catch {
    return ''
  }
}

const CHINESE_DIRECT_TIME_PATTERN = /最新(?!颖)|今天|今日|昨天|昨日|截至(?:目前|现在|今天|今日)/
const CHINESE_FRESHNESS_PATTERN = /(?:目前|当前|现在)(?:的)?(?:消息|新闻|进展|近况|现状|状态|动态|版本|发布|价格|行情|政策|规则|法规|数据|排名|结果|负责人|领导人|总统|总理|CEO)|(?:目前|当前|现在)(?:怎么样|如何|是什么情况|发生了什么)|(?:最近|近期|近日)(?:的)?(?:消息|新闻|进展|近况|动态|更新|变化|发布|价格|行情|数据|结果)|(?:后来|后续)(?:又)?(?:有|有什么|有何|的)?(?:进展|变化|更新|消息|结果|情况|发展)|(?:有|有什么|有何|有哪些)(?:最新|新的)?更新/i
const CHINESE_EXPLICIT_SEARCH_PATTERN = /(?:联网|上网|网络|网上)(?:搜索|查询|查找|检索|搜|查)|(?:帮我|请|麻烦|能否|可以帮我)(?:联网|上网|网络|网上)?(?:搜索|查询|查找|检索|搜|查)|(?:搜索|查询|查找|检索|搜|查)(?:一下|一查|最新)/
const ENGLISH_AUTO_SEARCH_PATTERN = /\b(latest|recent|recently|today|tonight|yesterday|currently|news)\b|\bthis\s+(week|month|year)\b|\bright\s+now\b|\bas\s+of\b|\bwhat\s+happened\s+since\b|\bfollow[- ]?up\b|\bsearch\s+(the\s+)?web\b|\bsearch\s+online\b|\blook\s+up\b/i
const ENGLISH_CURRENT_FRESHNESS_PATTERN = /\bcurrent\s+(news|status|situation|state|events?|developments?|updates?|version|release|price|weather|forecast|president|prime\s+minister|ceo|leader|policy|rules?|law|regulations?)\b/i
const ENGLISH_UPDATE_FRESHNESS_PATTERN = /\b(latest|recent|new|any)\s+updates?\b|\bupdates?\s+(on|about|since)\b|\bupdate\s+me\s+(on|about)\b|\bwhat(?:'s|\s+is)\s+new\b/i
