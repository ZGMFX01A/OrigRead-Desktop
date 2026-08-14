import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubProbeResult, RssHubRouteMatch } from '../../../shared/rsshub'
import { RssDiscoveryService, type RssFetchPayload } from '../rss/rss-discovery-service'
import { RssHubRouteMatcher } from './rsshub-route-matcher'
import { normalizeRssHubInstanceUrl } from './rsshub-route-matcher'
import { RssHubSettingsRepository } from './rsshub-settings-repository'

const MAX_ROUTE_CANDIDATES = 3
const CALL_TIMEOUT_MILLIS = 5_000
const TOTAL_PROBE_TIMEOUT_MILLIS = 9_000

export type RssHubFeedProbe = (feedUrl: string, sourceUrl: string) => Promise<DiscoveredRssFeed>

export class RssHubResolver {
  static readonly DEFAULT_INSTANCE = 'https://rsshub.app'

  constructor(
    private readonly routeMatcher: RssHubRouteMatcher,
    private readonly settingsRepository: RssHubSettingsRepository,
    private readonly feedProbe: RssHubFeedProbe = createDefaultFeedProbe()
  ) {}

  async probe(inputUrl: string, instanceBaseUrl?: string): Promise<RssHubProbeResult[]> {
    if (!this.settingsRepository.current().enabled) return []
    const instances = instanceBaseUrl
      ? [instanceBaseUrl]
      : this.settingsRepository.candidateInstances()
    if (instances.length === 0) return []

    return withTimeout(async () => {
      const failures: RssHubProbeResult[] = []
      for (const instance of instances) {
        const results = await this.probeInstance(inputUrl, instance)
        const available = results.filter((result) => result.available)
        if (available.length > 0) {
          this.settingsRepository.recordSuccess(instance)
          return available
        }
        if (results.length > 0) {
          failures.push(...results)
          if (results.every((result) => result.state === 'timeout' || result.state === 'network_unavailable')) {
            this.settingsRepository.recordFailure(instance)
          }
        }
      }
      const distinct = new Map<string, RssHubProbeResult>()
      for (const result of failures) {
        const key = `${result.match.route.id}:${result.state}:${result.match.missingParameters.join(',')}`
        if (!distinct.has(key)) distinct.set(key, result)
      }
      return [...distinct.values()]
    }, TOTAL_PROBE_TIMEOUT_MILLIS, [])
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

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError' || /timed?\s*out/i.test(error.message)
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|network|socket|connect/i.test(error.message))
}

async function withTimeout<T>(work: () => Promise<T>, timeoutMillis: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMillis)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
