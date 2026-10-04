
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { JsonSourceProbeResult } from '../../shared/json-source'
import type { RssHubProbeResult } from '../../shared/rsshub'
import type { RssHubRouteStatusSummary } from '../../shared/source-discovery'
import type { WebsiteInspectionResult } from '../../shared/website'

import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'

import { type UnscoredSourceCandidate } from './source-candidate-scorer'

export function rssCandidate(feed: DiscoveredRssFeed): UnscoredSourceCandidate {
  return {
    title: feed.title,
    feedLink: feed.feedUrl,
    sourceType: 'rss',
    kind: feed.discoveredFromPage ? 'RSS_DISCOVERED' : 'RSS_DIRECT',
    entries: feed.items.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

export function rssHubCandidate(result: RssHubProbeResult): UnscoredSourceCandidate {
  const feed = result.feed!
  return {
    title: feed.title,
    feedLink: result.match.feedUrl!,
    sourceType: 'rss',
    kind: 'RSSHUB',
    sourceNotice: `RSSHub · ${result.match.route.name}`,
    entries: feed.items.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

export function jsonCandidate(probe: JsonSourceProbeResult): UnscoredSourceCandidate {
  return {
    title: probe.title,
    feedLink: probe.endpointUrl,
    sourceType: 'json',
    kind: 'JSON',
    entries: probe.articles.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

export function websiteCandidate(inspection: WebsiteInspectionResult, options: { dynamic: boolean; browser: boolean; notice: string | null }): UnscoredSourceCandidate {
  const { dynamic, browser, notice } = options
  return {
    title: inspection.title,
    feedLink: inspection.sourceUrl,
    sourceType: 'website',
    kind: dynamic ? 'WEBSITE_DYNAMIC' : 'WEBSITE',
    sourceNotice: notice,
    browser,
    dynamicRendering: dynamic,
    entries: inspection.candidate.articles.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

export function mergeRssHubProbeResults(local: RssHubProbeResult[], probed: RssHubProbeResult[]): RssHubProbeResult[] {
  const merged = new Map<string, RssHubProbeResult>()
  for (const result of local) merged.set(rssHubRouteKey(result), result)
  // 只替换本地占位诊断。同一路由可以有多个真实诊断，例如 HTTP 503 加验证未完成。
  for (const result of probed) merged.delete(rssHubRouteKey(result))
  return [...merged.values(), ...probed]
}

export function rssHubRouteKey(result: RssHubProbeResult): string {
  const parameters = Object.entries(result.match.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  return `${result.match.route.id}|${parameters}`
}

export function toRssHubRouteStatusSummary(result: RssHubProbeResult): RssHubRouteStatusSummary {
  return {
    routeId: result.match.route.id,
    name: result.match.route.name,
    feedUrl: result.match.feedUrl,
    candidateId: result.available && result.match.feedUrl ? `RSS:${sourceUrlComparisonKey(result.match.feedUrl)}` : null,
    state: result.state,
    available: result.available,
    articleCount: result.feed?.items.length ?? 0,
    message: result.message,
    instanceBaseUrl: result.instanceBaseUrl ?? null,
    failureReason: result.failureReason ?? null,
    statusCode: result.statusCode ?? null
  }
}
