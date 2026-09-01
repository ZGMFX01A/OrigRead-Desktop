export const WEB_SEARCH_PROVIDER_KINDS = ['TAVILY', 'EXA', 'KEENABLE'] as const
export type WebSearchProviderKind = typeof WEB_SEARCH_PROVIDER_KINDS[number]

export type WebSearchBackendKind = 'RAW_SEARCH'
export type WebSearchMode = 'OFF' | 'AUTO' | 'FORCE'
export type PersistentWebSearchMode = Exclude<WebSearchMode, 'FORCE'>

export const WEB_SEARCH_REQUEST_STATUSES = [
  'NOT_NEEDED',
  'TRIGGERED',
  'SUCCESS',
  'EMPTY_RESULT',
  'FAILED_FALLBACK',
  'FAILED_REQUIRED',
  'CANCELLED'
] as const
export type WebSearchRequestStatus = typeof WEB_SEARCH_REQUEST_STATUSES[number]

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5
export const MIN_WEB_SEARCH_MAX_RESULTS = 1
export const MAX_WEB_SEARCH_MAX_RESULTS = 20
export const MAX_WEB_SEARCH_QUERY_LENGTH = 400

export interface WebSearchProviderDefinition {
  kind: WebSearchProviderKind
  defaultName: string
  defaultEndpoint: string
  backendKind: WebSearchBackendKind
  requiresApiKey: boolean
  supportsApiKey: boolean
}

export const WEB_SEARCH_PROVIDER_DEFINITIONS: Readonly<Record<WebSearchProviderKind, WebSearchProviderDefinition>> = Object.freeze({
  TAVILY: {
    kind: 'TAVILY',
    defaultName: 'Tavily',
    defaultEndpoint: 'https://api.tavily.com/search',
    backendKind: 'RAW_SEARCH',
    requiresApiKey: true,
    supportsApiKey: true
  },
  EXA: {
    kind: 'EXA',
    defaultName: 'Exa',
    defaultEndpoint: 'https://api.exa.ai/search',
    backendKind: 'RAW_SEARCH',
    requiresApiKey: true,
    supportsApiKey: true
  },
  KEENABLE: {
    kind: 'KEENABLE',
    defaultName: 'Keenable',
    defaultEndpoint: 'https://api.keenable.ai/v1/search/public',
    backendKind: 'RAW_SEARCH',
    requiresApiKey: false,
    supportsApiKey: true
  }
})

export interface WebSearchProviderProfile {
  id: string
  kind: WebSearchProviderKind
  name: string
  endpoint: string
  enabled: boolean
  hasApiKey: boolean
  apiKeyLength: number
}

export interface WebSearchSettings {
  /** FORCE is request-scoped and is never persisted here. */
  mode: PersistentWebSearchMode
  providers: WebSearchProviderProfile[]
  defaultProviderId: string | null
  maxResults: number
}

export interface WebSearchProviderPatch {
  id: string
  name?: string
  endpoint?: string
  enabled?: boolean
  apiKey?: string
}

export interface WebSearchSettingsPatch {
  mode?: PersistentWebSearchMode
  defaultProviderId?: string | null
  maxResults?: number
}

export interface WebSearchProviderTestResult {
  ok: boolean
  result: WebSearchHealthCheckResult | null
  error: string | null
}

export interface WebSearchRequest {
  query: string
  maxResults: number
  includeContent: boolean
  timeoutMs: number
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  publishedAt: string | null
  source: string | null
  content: string | null
  metadata?: Record<string, string | number | boolean | null>
}

export interface WebSearchResponse {
  providerId: string
  providerName: string
  backendKind: WebSearchBackendKind
  results: WebSearchResult[]
  answer: string | null
}

export interface WebSearchDecision {
  status: WebSearchRequestStatus
  required: boolean
  triggered: boolean
}

export interface WebSearchPreparedPlan {
  decision: WebSearchDecision
  mode: WebSearchMode
  query: string | null
  providerId: string | null
  providerName: string | null
  providerKind: WebSearchProviderKind | null
  request: WebSearchRequest | null
  preflightErrorMessage: string | null
}

export interface WebSearchRouteResult {
  status: WebSearchRequestStatus
  response: WebSearchResponse | null
  providerName: string | null
  errorMessage: string | null
  requiredFailure: boolean
}

export interface WebSearchHealthCheckResult {
  providerId: string
  providerName: string
  latencyMs: number
  resultCount: number
}

export function normalizeWebSearchMaxResults(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEB_SEARCH_MAX_RESULTS
  return Math.min(MAX_WEB_SEARCH_MAX_RESULTS, Math.max(MIN_WEB_SEARCH_MAX_RESULTS, Math.trunc(value)))
}

export function webSearchProviderDefinition(kind: WebSearchProviderKind): WebSearchProviderDefinition {
  return WEB_SEARCH_PROVIDER_DEFINITIONS[kind]
}
