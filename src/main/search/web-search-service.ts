import { performance } from 'node:perf_hooks'
import { NETWORK_REQUEST_TIMEOUT_MS } from '../network/request-policy'
import type { WebSearchRepository } from './web-search-repository'
import {
  ExaWebSearchAdapter,
  KeenableWebSearchAdapter,
  TavilyWebSearchAdapter,
  WebSearchException,
  type WebSearchProviderAdapter
} from './web-search-adapters'
import type {
  WebSearchHealthCheckResult,
  WebSearchProviderKind,
  WebSearchProviderProfile,
  WebSearchRequest,
  WebSearchResponse
} from '../../shared/web-search'

export interface WebSearchProviderSnapshot {
  profile: WebSearchProviderProfile
  apiKey: string
}

export class WebSearchService {
  private readonly adapters: ReadonlyMap<WebSearchProviderKind, WebSearchProviderAdapter>

  constructor(
    private readonly repository: WebSearchRepository,
    adapters: readonly WebSearchProviderAdapter[] = [
      new TavilyWebSearchAdapter(),
      new ExaWebSearchAdapter(),
      new KeenableWebSearchAdapter()
    ]
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]))
  }

  async search(request: WebSearchRequest, providerId?: string | null, signal?: AbortSignal): Promise<WebSearchResponse> {
    const profile = this.configuredProfile(providerId)
    return this.searchPrepared(request, { profile, apiKey: this.repository.getApiKey(profile.id) }, signal)
  }

  async searchPrepared(request: WebSearchRequest, snapshot: WebSearchProviderSnapshot, signal?: AbortSignal): Promise<WebSearchResponse> {
    this.validateRuntimeProfile(snapshot.profile, snapshot.apiKey)
    const adapter = this.adapters.get(snapshot.profile.kind)
    if (!adapter) throw new WebSearchException(`暂不支持搜索服务：${snapshot.profile.kind}`)
    return adapter.search(snapshot.profile, snapshot.apiKey, request, signal)
  }

  async checkHealth(providerId: string, signal?: AbortSignal): Promise<WebSearchHealthCheckResult> {
    const profile = this.configuredProfile(providerId)
    const startedAt = performance.now()
    const response = await this.searchPrepared({
      query: 'OpenAI',
      maxResults: 1,
      includeContent: false,
      timeoutMs: NETWORK_REQUEST_TIMEOUT_MS.DEDICATED_SEARCH_HEALTH
    }, { profile, apiKey: this.repository.getApiKey(profile.id) }, signal)
    return {
      providerId: profile.id,
      providerName: profile.name,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      resultCount: response.results.length
    }
  }

  private configuredProfile(providerId?: string | null): WebSearchProviderProfile {
    const settings = this.repository.current()
    const profile = providerId
      ? settings.providers.find((provider) => provider.id === providerId)
      : settings.providers.find((provider) => provider.id === settings.defaultProviderId && provider.enabled)
        ?? settings.providers.find((provider) => provider.enabled)
    if (!profile) throw new WebSearchException('没有配置 Web Search Provider')
    if (!this.repository.isConfigured(profile.id)) throw new WebSearchException(`Web Search Provider 未完成配置：${profile.name}`)
    return profile
  }

  private validateRuntimeProfile(profile: WebSearchProviderProfile, apiKey: string): void {
    if (!profile.enabled || !profile.endpoint.trim()) throw new WebSearchException(`Web Search Provider 未完成配置：${profile.name}`)
    if ((profile.kind === 'TAVILY' || profile.kind === 'EXA') && !apiKey.trim()) {
      throw new WebSearchException(`Web Search Provider 缺少 API Key：${profile.name}`)
    }
  }
}
