import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubCandidateState, RssHubFailureReason, RssHubProbeResult, RssHubRouteMatch } from '../../../shared/rsshub'
import { RssDiscoveryService, type RssFetchPayload, type RssRequestValidators } from '../rss/rss-discovery-service'
import { RssHubRouteMatcher } from './rsshub-route-matcher'
import { normalizeRssHubInstanceUrl } from './rsshub-route-matcher'
import { RssHubSettingsRepository, orderRssHubInstances } from './rsshub-settings-repository'
import {
  buildRssHubFeedUrl,
  normalizeRssHubRoutePath,
  parseExplicitRssHubInput,
  requiresBoundInstance,
  rssHubRouteFamily
} from './rsshub-input'

const MAX_ROUTE_CANDIDATES = 5
const HEALTH_TIMEOUT_MILLIS = 5_000
const CALL_TIMEOUT_MILLIS = 11_000
const TOTAL_PROBE_TIMEOUT_MILLIS = 12_000
const DISCOVERY_INSTANCE_CONCURRENCY = 4
const DIRECT_ROUTE_INSTANCE_CONCURRENCY = 8

export type RssHubFeedProbe = (feedUrl: string, sourceUrl: string, signal?: AbortSignal) => Promise<DiscoveredRssFeed>

export class FeedFetchError extends Error {
  constructor(
    readonly failureReason: RssHubFailureReason,
    readonly statusCode: number | null,
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'FeedFetchError'
  }
}

export class RssHubResolver {
  static readonly DEFAULT_INSTANCE = 'https://rsshub.app'

  constructor(
    private readonly routeMatcher: RssHubRouteMatcher,
    private readonly settingsRepository: RssHubSettingsRepository,
    private readonly feedProbe: RssHubFeedProbe = createDefaultFeedProbe()
  ) {}

  isEnabled(): boolean {
    return this.settingsRepository.current().enabled
  }

  knownInstanceUrls(): string[] {
    return this.settingsRepository.current().instances.map((instance) => instance.url)
  }

  async probe(inputUrl: string, instanceBaseUrl?: string, signal?: AbortSignal): Promise<RssHubProbeResult[]> {
    signal?.throwIfAborted()
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
      return localDiagnostics(expected, 'unsupported', 'RSSHub is disabled in settings', 'disabled')
    }
    if (instances.length === 0) {
      return localDiagnostics(expected, 'unsupported', 'No RSSHub instance is enabled', 'no_instances')
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
    const totalController = new AbortController()
    const completionController = new AbortController()
    const totalTimer = setTimeout(() => {
      budgetExpired = true
      totalController.abort(new DOMException('RSSHub probe budget expired', 'TimeoutError'))
    }, TOTAL_PROBE_TIMEOUT_MILLIS)
    const probeSignal = signal
      ? AbortSignal.any([signal, totalController.signal, completionController.signal])
      : AbortSignal.any([totalController.signal, completionController.signal])
    try {
      const allResolved = await consumeInstancesInCompletionOrder(
        instances,
        DISCOVERY_INSTANCE_CONCURRENCY,
        (instance) => this.probeInstance(inputUrl, instance, probeSignal),
        (instance, results) => {
          const attemptedRoutes = results.filter((result) => result.match.resolved)
          if (attemptedRoutes.length > 0 && attemptedRoutes.every(shouldCoolInstanceGlobally)) {
            this.settingsRepository.recordFailure(instance)
          }
          if (!successRecorded && results.some((result) => result.available)) {
            this.settingsRepository.recordSuccess(instance)
            successRecorded = true
          }
          for (const result of results) {
            if (result.routePath) {
              const routeFamily = rssHubRouteFamily(result.routePath)
              if (result.available) {
                this.settingsRepository.recordRouteSuccess(instance, routeFamily)
              } else if (result.state !== 'needs_input') {
                this.settingsRepository.recordRouteFailure(instance, routeFamily)
              }
            }
            const key = routeKey(result.match)
            if (result.available) {
              if (!availableByRoute.has(key)) availableByRoute.set(key, result)
              diagnostics.delete(key)
            } else if (!availableByRoute.has(key) && !diagnostics.has(key)) {
              diagnostics.set(key, result)
            }
          }
          return [...expectedResolvedKeys].every((key) => availableByRoute.has(key))
        },
        probeSignal
      )
      if (allResolved) completionController.abort(new DOMException('RSSHub routes resolved', 'AbortError'))
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (!totalController.signal.aborted) throw error
    } finally {
      if (!completionController.signal.aborted) completionController.abort(new DOMException('RSSHub probe finished', 'AbortError'))
      clearTimeout(totalTimer)
    }

    signal?.throwIfAborted()

    // 总预算可能先于某个实例完成。此时本地匹配仍然是事实，必须保留为 timeout 诊断。
    for (const match of expected.filter((item) => item.resolved)) {
      const key = routeKey(match)
      if (!availableByRoute.has(key) && !diagnostics.has(key)) {
        diagnostics.set(key, toProbeResult(
          match,
          budgetExpired ? 'timeout' : 'network_unavailable',
          null,
          budgetExpired
            ? 'RSSHub route matched, but no instance completed within the probe budget'
            : 'RSSHub route matched, but no instance returned a usable result',
          null,
          null,
          null,
          budgetExpired ? 'probe_budget_exhausted' : 'network_unavailable'
        ))
      }
    }
    return combinedProbeResults(availableByRoute, diagnostics)
  }

  /**
   * 自动恢复尊重当前启用列表；带访问凭证的路由只能请求绑定的原实例。
   */
  async probeRouteForRecovery(
    routePath: string,
    boundInstance?: string | null,
    signal?: AbortSignal
  ): Promise<RssHubProbeResult[]> {
    const normalizedRoute = normalizeRssHubRoutePath(routePath)
    if (!normalizedRoute) return []
    if (!requiresBoundInstance(normalizedRoute)) {
      return this.probeRoute(normalizedRoute, undefined, signal)
    }
    const enabled = this.settingsRepository.current().instances
      .filter((item) => item.enabled)
      .map((item) => normalizeRssHubInstanceUrl(item.url))
      .filter((item): item is string => Boolean(item))
    const bound = boundInstance ? normalizeRssHubInstanceUrl(boundInstance) : null
    if (!bound || !enabled.includes(bound)) {
      const fallbackMatch = directRouteMatch(normalizedRoute, bound ?? RssHubResolver.DEFAULT_INSTANCE)
      return [toProbeResult(
        fallbackMatch,
        'unsupported',
        null,
        bound ? 'The bound RSSHub instance is disabled or removed' : 'This route requires an instance with credentials',
        normalizedRoute,
        bound,
        null,
        bound ? 'bound_instance_disabled' : 'authentication_requires_instance'
      )]
    }
    return this.probeRoute(normalizedRoute, bound, signal)
  }

  /** 显式 HTTP 地址作为普通 RSS 使用时直接探测，不启动实例回退。 */
  async probeExplicitRoute(
    routePath: string,
    instanceBaseUrl: string,
    signal?: AbortSignal
  ): Promise<RssHubProbeResult> {
    const normalized = normalizeRssHubRoutePath(routePath)
    if (!normalized) throw new Error(`Invalid RSSHub route path: ${routePath}`)
    return this.probeDirectRoute(normalized, instanceBaseUrl, signal)
  }

  /** Probe a stable RSSHub logical route and race enabled public instances with bounded concurrency. */
  async probeRoute(routePath: string, preferredInstance?: string | null, signal?: AbortSignal): Promise<RssHubProbeResult[]> {
    signal?.throwIfAborted()
    const route = normalizeRssHubRoutePath(routePath)
    if (!route) return []
    const settings = this.settingsRepository.current()
    const routeFamily = rssHubRouteFamily(route)
    const isBound = requiresBoundInstance(route)
    const candidates = isBound
      ? (preferredInstance ? orderRssHubInstances(preferredInstance) : [])
      : orderRssHubInstances(
          preferredInstance,
          ...this.settingsRepository.candidateInstancesForRoute(routeFamily)
        )
    const fallbackInstance = candidates[0] ?? preferredInstance ?? RssHubResolver.DEFAULT_INSTANCE
    const fallbackMatch = directRouteMatch(route, fallbackInstance)
    if (!settings.enabled) {
      return [toProbeResult(fallbackMatch, 'unsupported', null, 'RSSHub is disabled in settings', route, preferredInstance ?? null, null, 'disabled')]
    }
    if (candidates.length === 0) {
      return [toProbeResult(
        fallbackMatch,
        'unsupported',
        null,
        isBound ? 'This route contains credentials and requires a specific instance' : 'No RSSHub instance is enabled',
        route,
        null,
        null,
        isBound ? 'authentication_requires_instance' : 'no_instances'
      )]
    }

    const diagnostics = new Map<number, RssHubProbeResult>()
    const order = new Map(candidates.map((instance, index) => [instance, index]))
    const completedInstances = new Set<string>()
    let success: RssHubProbeResult | null = null
    let budgetExpired = false
    const totalController = new AbortController()
    const completionController = new AbortController()
    const timer = setTimeout(() => {
      budgetExpired = true
      totalController.abort(new DOMException('RSSHub total probe budget expired', 'TimeoutError'))
    }, TOTAL_PROBE_TIMEOUT_MILLIS)
    const probeSignal = signal
      ? AbortSignal.any([signal, totalController.signal, completionController.signal])
      : AbortSignal.any([totalController.signal, completionController.signal])
    try {
      const resolved = await consumeInstancesInCompletionOrder(
        candidates,
        DIRECT_ROUTE_INSTANCE_CONCURRENCY,
        (instance) => this.probeDirectRoute(route, instance, probeSignal),
        (instance, result) => {
          completedInstances.add(instance)
          if (result.available) {
            success = result
            this.settingsRepository.recordRouteSuccess(instance, routeFamily)
            this.settingsRepository.recordSuccess(instance)
            return true
          }
          diagnostics.set(order.get(instance) ?? Number.MAX_SAFE_INTEGER, result)
          this.settingsRepository.recordRouteFailure(instance, routeFamily)
          if (shouldCoolInstanceGlobally(result)) this.settingsRepository.recordFailure(instance)
          return false
        },
        probeSignal
      )
      if (resolved) completionController.abort(new DOMException('RSSHub route resolved', 'AbortError'))
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (!totalController.signal.aborted) throw error
    } finally {
      if (!completionController.signal.aborted) completionController.abort(new DOMException('RSSHub probe finished', 'AbortError'))
      clearTimeout(timer)
    }
    if (success) return [success, ...[...diagnostics.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)]
    if (budgetExpired) {
      const unfinished = candidates.filter((item) => !completedInstances.has(item))
      const firstUnfinished = unfinished[0] ?? fallbackInstance
      diagnostics.set(order.get(firstUnfinished) ?? Number.MAX_SAFE_INTEGER, toProbeResult(
        directRouteMatch(route, firstUnfinished),
        'timeout',
        null,
        'RSSHub probe budget exhausted before this instance completed',
        route,
        firstUnfinished,
        null,
        'probe_budget_exhausted'
      ))
    }
    const orderedDiagnostics = [...diagnostics.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
    return orderedDiagnostics.length > 0 ? orderedDiagnostics : [toProbeResult(
      fallbackMatch, 'network_unavailable', null, 'No RSSHub instance returned a usable result', route, null, null, 'network_unavailable'
    )]
  }

  localRouteDiagnostics(inputUrl: string): RssHubProbeResult[] {
    const matches = this.routeMatcher.match(inputUrl, RssHubResolver.DEFAULT_INSTANCE, MAX_ROUTE_CANDIDATES)
    return localDiagnostics(matches, 'network_unavailable', 'RSSHub instance probing failed', 'network_unavailable')
  }

  async testConnection(instanceBaseUrl: string): Promise<void> {
    const normalized = normalizeRssHubInstanceUrl(instanceBaseUrl)
    if (!normalized) throw new TypeError(`无效的 RSSHub 实例地址：${instanceBaseUrl}`)
    const response = await fetch(`${normalized}/healthz`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MILLIS)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }

  private async probeInstance(inputUrl: string, instanceBaseUrl: string, signal?: AbortSignal): Promise<RssHubProbeResult[]> {
    const matches = this.routeMatcher.match(inputUrl, instanceBaseUrl, MAX_ROUTE_CANDIDATES)
    return Promise.all(matches.map((match) => {
      if (!match.resolved) {
        return Promise.resolve(toProbeResult(match, 'needs_input', null,
          `RSSHub route requires parameters: ${match.missingParameters.join(', ')}`))
      }
      const routePath = match.feedUrl
        ? parseExplicitRssHubInput(match.feedUrl, [instanceBaseUrl])?.routePath ?? null
        : null
      return this.probeOne(match, inputUrl, signal, routePath, instanceBaseUrl)
    }))
  }

  private probeDirectRoute(routePath: string, instanceBaseUrl: string, signal?: AbortSignal): Promise<RssHubProbeResult> {
    return this.probeOne(directRouteMatch(routePath, instanceBaseUrl), routePath, signal, routePath, instanceBaseUrl)
  }

  private async probeOne(
    match: RssHubRouteMatch,
    inputUrl: string,
    signal?: AbortSignal,
    routePath: string | null = null,
    instanceBaseUrl: string | null = null
  ): Promise<RssHubProbeResult> {
    try {
      const feed = await this.feedProbe(match.feedUrl!, inputUrl, signal)
      return toProbeResult(match, 'available', feed, null, routePath, instanceBaseUrl)
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof FeedFetchError) {
        const state = (error.failureReason === 'blocked' || error.failureReason === 'http_error')
          ? 'network_unavailable'
          : 'invalid_content'
        return toProbeResult(
          match,
          state,
          null,
          error.message,
          routePath,
          instanceBaseUrl,
          error.statusCode,
          error.failureReason
        )
      }
      const classified = classifyNetworkError(error)
      if (classified) {
        return toProbeResult(
          match,
          classified.state,
          null,
          classified.message,
          routePath,
          instanceBaseUrl,
          httpStatusCode(error),
          classified.failureReason
        )
      }
      return toProbeResult(
        match,
        'invalid_content',
        null,
        error instanceof Error ? error.message : 'RSSHub returned invalid content',
        routePath,
        instanceBaseUrl,
        httpStatusCode(error),
        'invalid_content'
      )
    }
  }
}

function createDefaultFeedProbe(): RssHubFeedProbe {
  // A logical route is not a website URL. Icon discovery is decorative and must not
  // consume the probe budget or leave requests running after peers are cancelled.
  const discovery = new RssDiscoveryService(fetchRssHubPayload)
  return (feedUrl, _sourceUrl, signal) => discovery.parseDirect(feedUrl, { sourcePageUrl: feedUrl, signal, skipIconDiscovery: true })
}

async function fetchRssHubPayload(
  url: string,
  _validators: RssRequestValidators = {},
  signal?: AbortSignal
): Promise<RssFetchPayload> {
  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MILLIS)]) : AbortSignal.timeout(CALL_TIMEOUT_MILLIS),
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8'
      }
    })
  } catch (error) {
    throw error
  }
  const cfMitigated = response.headers.get('cf-mitigated')
  if (cfMitigated && cfMitigated.toLowerCase() === 'challenge') {
    throw new FeedFetchError('blocked', response.status, 'Feed request blocked by an anti-bot challenge')
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const preview = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 65536))
  const feedRoot = /(?:<\?.*?\?>|<!--.*?-->|\s)*<(?:rss|(?:[\w-]+:)?feed|(?:[\w-]+:)?RDF)\b/i.test(preview)
  const contentType = response.headers.get('content-type') || ''
  const isHtml = !feedRoot && (
    contentType.toLowerCase().includes('text/html') ||
    /<!doctype\s+html|<html\b|<head\b|<body\b/i.test(preview)
  )
  const pageTitle = /<title\b[^>]*>\s*([\s\S]*?)\s*<\/title>/i.exec(preview)?.[1]?.trim() ?? ''
  const isChallenge = isHtml && (
    preview.toLowerCase().includes('/cdn-cgi/challenge-platform/') ||
    preview.toLowerCase().includes('cf-chl-') ||
    /^Just a moment(?:\.{3}|…)?$/i.test(pageTitle) ||
    pageTitle.toLowerCase() === 'attention required! | cloudflare' ||
    (preview.toLowerCase().includes('challenges.cloudflare.com') &&
      /(?:verify you are human|security verification|checking your browser)/i.test(pageTitle))
  )

  if (isChallenge && !response.ok) {
    throw new FeedFetchError('blocked', response.status, 'Feed request blocked by an anti-bot challenge')
  }
  if (!response.ok) {
    throw new FeedFetchError('http_error', response.status, `HTTP ${response.status}`)
  }
  const isJson = !feedRoot && (
    contentType.toLowerCase().includes('json') ||
    preview.trimStart().startsWith('{') ||
    preview.trimStart().startsWith('[')
  )
  if (isJson) {
    throw new FeedFetchError('unsupported_format', response.status, 'Use RSS or Atom output instead of JSON')
  }
  if (isHtml) {
    throw new FeedFetchError('html_response', response.status, 'Server returned a web page instead of a feed')
  }

  return {
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    bytes
  }
}

function toProbeResult(
  match: RssHubRouteMatch,
  state: RssHubCandidateState,
  feed: DiscoveredRssFeed | null,
  message: string | null,
  routePath: string | null = null,
  instanceBaseUrl: string | null = null,
  statusCode: number | null = null,
  failureReason: RssHubFailureReason | null = null
): RssHubProbeResult {
  return {
    match,
    state,
    feed,
    message,
    available: state === 'available' && feed !== null,
    routePath,
    instanceBaseUrl,
    statusCode,
    failureReason
  }
}

const TRANSPORT_FAILURES = new Set<RssHubFailureReason>([
  'timeout',
  'network_unavailable',
  'connection_closed',
  'dns_failure',
  'tls_error'
])

function shouldCoolInstanceGlobally(result: RssHubProbeResult): boolean {
  return (result.failureReason != null && TRANSPORT_FAILURES.has(result.failureReason)) || result.statusCode === 429
}

function httpStatusCode(error: unknown): number | null {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number' && Number.isInteger(value)) return value
  }
  const message = error instanceof Error ? error.message : ''
  const match = /^HTTP\s+(\d{3})\b/i.exec(message)
  return match ? Number(match[1]) : null
}

function directRouteMatch(routePath: string, instanceBaseUrl: string): RssHubRouteMatch {
  const instance = normalizeRssHubInstanceUrl(instanceBaseUrl) ?? RssHubResolver.DEFAULT_INSTANCE
  const feedUrl = buildRssHubFeedUrl(instance, routePath)
  const routeId = routePath.split('?')[0]!
  return {
    route: { id: `direct:${routeId}`, name: 'RSSHub', host: 'rsshub', pathPrefix: routeId, target: routePath },
    feedUrl,
    parameters: {},
    missingParameters: [],
    resolved: true
  }
}

async function consumeInstancesInCompletionOrder<T>(
  instances: readonly string[],
  maxConcurrency: number,
  work: (instance: string) => Promise<T>,
  onResult: (instance: string, value: T) => boolean,
  signal?: AbortSignal
): Promise<boolean> {
  let nextIndex = 0
  const active = new Map<number, Promise<{ index: number; instance: string; value?: T; error?: unknown }>>()
  const launch = (): void => {
    while (nextIndex < instances.length && active.size < maxConcurrency) {
      const index = nextIndex++
      const instance = instances[index]!
      active.set(index, work(instance)
        .then((value) => ({ index, instance, value }))
        .catch((error) => ({ index, instance, error })))
    }
  }
  launch()
  while (active.size > 0) {
    signal?.throwIfAborted()
    const completed = await Promise.race(active.values())
    signal?.throwIfAborted()
    active.delete(completed.index)
    if (completed.error !== undefined) {
      signal?.throwIfAborted()
    } else if (onResult(completed.instance, completed.value as T)) {
      return true
    }
    launch()
  }
  return false
}

function localDiagnostics(
  matches: RssHubRouteMatch[],
  resolvedState: RssHubProbeResult['state'],
  message: string,
  failureReason: RssHubFailureReason | null = null
): RssHubProbeResult[] {
  return matches.map((match) => match.resolved
    ? toProbeResult(match, resolvedState, null, message, null, null, null, failureReason)
    : toProbeResult(match, 'needs_input', null, `RSSHub route requires parameters: ${match.missingParameters.join(', ')}`))
}

function classifyNetworkError(error: unknown): { failureReason: RssHubFailureReason; state: RssHubCandidateState; message: string } | null {
  // Native fetch wraps DNS/TLS/socket errors in TypeError('fetch failed').
  const seen = new Set<unknown>()
  let cause = error instanceof Error ? error.cause : undefined
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause)
    const classified = classifyDirectNetworkError(cause)
    if (classified) return classified
    cause = cause.cause
  }
  return classifyDirectNetworkError(error)
}

function classifyDirectNetworkError(error: unknown): { failureReason: RssHubFailureReason; state: RssHubCandidateState; message: string } | null {
  if (isTimeoutError(error)) {
    return { failureReason: 'timeout', state: 'timeout', message: 'RSSHub connection timed out and was skipped' }
  }
  const msg = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ''}` : String(error)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return { failureReason: 'dns_failure', state: 'network_unavailable', message: 'Cannot resolve RSSHub host' }
  }
  if (/ERR_TLS|CERT_|self-signed|unable to verify/i.test(msg)) {
    return { failureReason: 'tls_error', state: 'network_unavailable', message: 'TLS error connecting to RSSHub' }
  }
  if (/ECONNRESET|EPIPE|premature close|end of stream|connection closed/i.test(msg)) {
    return { failureReason: 'connection_closed', state: 'network_unavailable', message: 'Connection closed prematurely' }
  }
  if (isNetworkError(error)) {
    return { failureReason: 'network_unavailable', state: 'network_unavailable', message: 'RSSHub is unavailable on the current network and was skipped' }
  }
  return null
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
