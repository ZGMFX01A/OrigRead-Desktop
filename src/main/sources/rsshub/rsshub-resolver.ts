import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubProbeResult, RssHubRouteMatch } from '../../../shared/rsshub'
import { RssDiscoveryService, type RssFetchPayload } from '../rss/rss-discovery-service'
import { RssHubRouteMatcher } from './rsshub-route-matcher'
import { normalizeRssHubInstanceUrl } from './rsshub-route-matcher'
import { RssHubSettingsRepository } from './rsshub-settings-repository'

const MAX_ROUTE_CANDIDATES = 5
const CALL_TIMEOUT_MILLIS = 5_000
const TOTAL_PROBE_TIMEOUT_MILLIS = 12_000

export type RssHubFeedProbe = (feedUrl: string, sourceUrl: string) => Promise<DiscoveredRssFeed>

export class RssHubResolver {
  static readonly DEFAULT_INSTANCE = 'https://rsshub.app'

  constructor(
    private readonly routeMatcher: RssHubRouteMatcher,
    private readonly settingsRepository: RssHubSettingsRepository,
    private readonly feedProbe: RssHubFeedProbe = createDefaultFeedProbe()
  ) {}

  async probe(inputUrl: string, instanceBaseUrl?: string): Promise<RssHubProbeResult[]> {
    const settings = this.settingsRepository.current()
    const instances = instanceBaseUrl
      ? [instanceBaseUrl]
      : this.settingsRepository.candidateInstances()
    const discoveryBaseUrl = instances[0] ?? RssHubResolver.DEFAULT_INSTANCE
    const expected = this.routeMatcher.match(inputUrl, discoveryBaseUrl, MAX_ROUTE_CANDIDATES)
    if (expected.length === 0) return []

    // 路由发现是本地能力，实例可用性只是网络验证。不能因为总开关关闭、实例列表为空或网络失败，
    // 就把已经命中的 RSSHub 路由从添加来源 UI 中抹掉。
    if (!settings.enabled) {
      return localDiagnostics(expected, 'unsupported', 'RSSHub is disabled in settings')
    }
    if (instances.length === 0) {
      return localDiagnostics(expected, 'unsupported', 'No RSSHub instance is enabled')
    }

    const expectedResolvedKeys = new Set(expected.filter((match) => match.resolved).map(routeKey))
    const availableByRoute = new Map<string, RssHubProbeResult>()
    const diagnostics = new Map<string, RssHubProbeResult>()
    for (const match of expected.filter((item) => !item.resolved)) {
      diagnostics.set(routeKey(match), toProbeResult(match, 'needs_input', null,
        `RSSHub route requires parameters: ${match.missingParameters.join(', ')}`))
    }
    if (expectedResolvedKeys.size === 0) return [...diagnostics.values()]
    let successRecorded = false
    let budgetExpired = false

    await withTimeout(async () => {
      // 与 Android 保持一致：实例按优先级串行 fallback；单实例内部才并发有限路由。
      // 这样不会因为“实例数 × 路由数”同时打满网络，也能稳定复用最近成功实例。
      for (const instance of instances) {
        if (budgetExpired) break
        let results: RssHubProbeResult[] = []
        try {
          results = await this.probeInstance(inputUrl, instance)
        } catch {
          // 本地 expected 已经保留；单实例异常不能把本地发现结果清空。
        }

        if (results.length > 0 && !results.some((result) => result.available)
          && results.every((result) => result.state === 'timeout' || result.state === 'network_unavailable')) {
          this.settingsRepository.recordFailure(instance)
        }
        if (!successRecorded && results.some((result) => result.available)) {
          this.settingsRepository.recordSuccess(instance)
          successRecorded = true
        }
        for (const result of results) {
          const key = routeKey(result.match)
          if (result.available) {
            if (!availableByRoute.has(key)) availableByRoute.set(key, result)
            diagnostics.delete(key)
          } else if (!availableByRoute.has(key) && !diagnostics.has(key)) {
            diagnostics.set(key, result)
          }
        }

        if ([...expectedResolvedKeys].every((key) => availableByRoute.has(key))) break
      }
    }, TOTAL_PROBE_TIMEOUT_MILLIS, () => { budgetExpired = true })

    // 总预算可能先于某个实例完成。此时本地匹配仍然是事实，必须保留为 timeout 诊断。
    for (const match of expected.filter((item) => item.resolved)) {
      const key = routeKey(match)
      if (!availableByRoute.has(key) && !diagnostics.has(key)) {
        diagnostics.set(key, toProbeResult(
          match,
          'timeout',
          null,
          'RSSHub route matched, but no instance completed within the probe budget'
        ))
      }
    }
    return combinedProbeResults(availableByRoute, diagnostics)
  }

  localRouteDiagnostics(inputUrl: string): RssHubProbeResult[] {
    const matches = this.routeMatcher.match(inputUrl, RssHubResolver.DEFAULT_INSTANCE, MAX_ROUTE_CANDIDATES)
    return localDiagnostics(matches, 'network_unavailable', 'RSSHub instance probing failed')
  }

  async testConnection(instanceBaseUrl: string): Promise<void> {
    const normalized = normalizeRssHubInstanceUrl(instanceBaseUrl)
    if (!normalized) throw new TypeError(`无效的 RSSHub 实例地址：${instanceBaseUrl}`)
    const response = await fetch(`${normalized}/healthz`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MILLIS)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }

  private async probeInstance(inputUrl: string, instanceBaseUrl: string): Promise<RssHubProbeResult[]> {
    const matches = this.routeMatcher.match(inputUrl, instanceBaseUrl, MAX_ROUTE_CANDIDATES)
    return Promise.all(matches.map((match) => {
      if (!match.resolved) {
        return Promise.resolve(toProbeResult(match, 'needs_input', null,
          `RSSHub route requires parameters: ${match.missingParameters.join(', ')}`))
      }
      return this.probeOne(match, inputUrl)
    }))
  }

  private async probeOne(match: RssHubRouteMatch, inputUrl: string): Promise<RssHubProbeResult> {
    try {
      const feed = await this.feedProbe(match.feedUrl!, inputUrl)
      return toProbeResult(match, 'available', feed, null)
    } catch (error) {
      if (isTimeoutError(error)) {
        return toProbeResult(match, 'timeout', null, 'RSSHub connection timed out and was skipped')
      }
      if (isNetworkError(error)) {
        return toProbeResult(match, 'network_unavailable', null, 'RSSHub is unavailable on the current network and was skipped')
      }
      return toProbeResult(match, 'invalid_content', null, error instanceof Error ? error.message : 'RSSHub returned invalid content')
    }
  }
}

function createDefaultFeedProbe(): RssHubFeedProbe {
  const discovery = new RssDiscoveryService(fetchRssHubPayload)
  return (feedUrl, sourceUrl) => discovery.parseDirect(feedUrl, sourceUrl)
}

async function fetchRssHubPayload(url: string): Promise<RssFetchPayload> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MILLIS),
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8'
      }
    })
  } catch (error) {
    throw error
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return {
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}

function toProbeResult(
  match: RssHubRouteMatch,
  state: RssHubProbeResult['state'],
  feed: DiscoveredRssFeed | null,
  message: string | null
): RssHubProbeResult {
  return { match, state, feed, message, available: state === 'available' && feed !== null }
}

function localDiagnostics(
  matches: RssHubRouteMatch[],
  resolvedState: RssHubProbeResult['state'],
  message: string
): RssHubProbeResult[] {
  return matches.map((match) => match.resolved
    ? toProbeResult(match, resolvedState, null, message)
    : toProbeResult(match, 'needs_input', null, `RSSHub route requires parameters: ${match.missingParameters.join(', ')}`))
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError' || /timed?\s*out/i.test(error.message)
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|network|socket|connect/i.test(error.message))
}

function distinctProbeResults(results: RssHubProbeResult[]): RssHubProbeResult[] {
  const distinct = new Map<string, RssHubProbeResult>()
  for (const result of results) {
    const key = `${result.match.route.id}:${result.state}:${result.match.missingParameters.join(',')}`
    if (!distinct.has(key)) distinct.set(key, result)
  }
  return [...distinct.values()]
}

function routeKey(match: RssHubRouteMatch): string {
  const parameters = Object.entries(match.parameters).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join('&')
  return `${match.route.id}|${parameters}`
}

function combinedProbeResults(
  availableByRoute: Map<string, RssHubProbeResult>,
  diagnostics: Map<string, RssHubProbeResult>
): RssHubProbeResult[] {
  return [
    ...availableByRoute.values(),
    ...[...diagnostics.entries()].filter(([key]) => !availableByRoute.has(key)).map(([, result]) => result)
  ]
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMillis: number, fallback: T | (() => T)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(typeof fallback === 'function' ? (fallback as () => T)() : fallback), timeoutMillis)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
