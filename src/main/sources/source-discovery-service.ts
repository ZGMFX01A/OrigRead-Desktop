import { randomUUID } from 'node:crypto'
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { JsonSourceProbeResult } from '../../shared/json-source'
import type { RssHubProbeResult } from '../../shared/rsshub'
import type {
  SourceCandidateSummary,
  SourceDiscoveryResult,
  SourceSubscriptionResult
} from '../../shared/source-discovery'
import type { WebsiteInspectionResult } from '../../shared/website'
import { JsonSourceService } from './json/json-source-service'
import { JsonSubscriptionService } from './json/json-subscription-service'
import { RssDiscoveryService } from './rss/rss-discovery-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { RssHubResolver } from './rsshub/rsshub-resolver'
import { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import { WebsiteSourceService } from './website/website-source-service'
import { WebsiteSubscriptionService } from './website/website-subscription-service'
import { rankSourceCandidates, type UnscoredSourceCandidate } from './source-candidate-scorer'

type CandidatePayload =
  | { type: 'rss'; discovered: DiscoveredRssFeed }
  | { type: 'rsshub'; sourceUrl: string; result: RssHubProbeResult }
  | { type: 'json'; probe: JsonSourceProbeResult }
  | { type: 'website'; inspection: WebsiteInspectionResult; dynamic: boolean }

interface DiscoverySession {
  createdAt: number
  result: SourceDiscoveryResult
  payloads: Map<string, CandidatePayload>
}

const SESSION_TTL_MS = 10 * 60_000
const MAX_SESSIONS = 20

export class SourceDiscoveryService {
  private readonly sessions = new Map<string, DiscoverySession>()

  constructor(
    private readonly rssDiscovery: RssDiscoveryService,
    private readonly rssSubscription: RssSubscriptionService,
    private readonly rssHubResolver: RssHubResolver,
    private readonly rssHubSubscription: RssHubSubscriptionService,
    private readonly jsonSource: JsonSourceService,
    private readonly jsonSubscription: JsonSubscriptionService,
    private readonly websiteSource: WebsiteSourceService,
    private readonly websiteSubscription: WebsiteSubscriptionService
  ) {}

  async discover(rawUrl: string): Promise<SourceDiscoveryResult> {
    const sourceUrl = normalizeSourceUrl(rawUrl)
    this.pruneSessions()
    if (isExplicitJsonEndpoint(sourceUrl)) {
      let error: string | null = null
      try {
        const probe = await this.jsonSource.probe(sourceUrl)
        if (probe) return this.createSession(sourceUrl, [jsonCandidate(probe)], [{ type: 'json', probe }])
      } catch (cause) {
        error = errorMessage(cause)
      }
      return this.createSession(sourceUrl, [], [], error ?? '未能从该地址识别出有效的 JSON 文章列表')
    }

    const candidates: UnscoredSourceCandidate[] = []
    const payloads: CandidatePayload[] = []
    let lastError: string | null = null

    try {
      const discovered = await withTimeout(this.rssDiscovery.discover(sourceUrl), 20_000, 'RSS 探测超时')
      candidates.push(rssCandidate(discovered))
      payloads.push({ type: 'rss', discovered })
    } catch (error) { lastError = errorMessage(error) }

    let rssHubResults: RssHubProbeResult[] = []
    try { rssHubResults = await this.rssHubResolver.probe(sourceUrl) } catch (error) { lastError = errorMessage(error) }
    for (const result of rssHubResults.filter((item) => item.available && item.feed && item.match.feedUrl)) {
      candidates.push(rssHubCandidate(result))
      payloads.push({ type: 'rsshub', sourceUrl, result })
    }

    try {
      const probe = await this.jsonSource.probe(sourceUrl)
      if (probe) {
        candidates.push(jsonCandidate(probe))
        payloads.push({ type: 'json', probe })
      }
    } catch (error) { lastError = errorMessage(error) }

    try {
      const inspection = await withTimeout(this.websiteSource.inspect(sourceUrl), 15_000, '网站静态探测超时')
      candidates.push(websiteCandidate(inspection, false, !this.websiteSource.hasRule(sourceUrl), rssHubFailureNotice(rssHubResults)))
      payloads.push({ type: 'website', inspection, dynamic: false })
    } catch (error) { lastError = errorMessage(error) }

    // Android：只有所有静态候选统一评分后一个都没通过，才启动动态 WebView/Chromium。
    if (rankSourceCandidates(candidates).length === 0) {
      try {
        const inspection = await withTimeout(this.websiteSource.inspectDynamic(sourceUrl), 20_000, '动态网站探测超时')
        candidates.push(websiteCandidate(inspection, true, !this.websiteSource.hasRule(sourceUrl), '该来源需要动态网页渲染'))
        payloads.push({ type: 'website', inspection, dynamic: true })
      } catch (error) { lastError = errorMessage(error) }
    }

    return this.createSession(sourceUrl, candidates, payloads, lastError ?? rssHubFailureNotice(rssHubResults))
  }

  async subscribe(discoveryId: string, candidateId: string): Promise<SourceSubscriptionResult> {
    const session = this.sessions.get(discoveryId)
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) throw new Error('来源发现结果已过期，请重新检测')
    const selected = session.result.candidates.find((candidate) => candidate.id === candidateId)
    const payload = session.payloads.get(candidateId)
    if (!selected || !payload) throw new Error('未找到所选来源候选')
    let feedId: string
    switch (payload.type) {
      case 'rss':
        feedId = this.rssSubscription.addDiscovered(payload.discovered).feedId
        break
      case 'rsshub':
        feedId = this.rssHubSubscription.subscribe(payload.sourceUrl, payload.result).feedId
        break
      case 'json':
        feedId = (await this.jsonSubscription.add(payload.probe)).feedId
        break
      case 'website':
        feedId = (await this.websiteSubscription.add(payload.inspection, payload.dynamic)).feedId
        break
    }
    this.sessions.delete(discoveryId)
    return { feedId, selectedCandidate: selected }
  }

  private createSession(
    sourceUrl: string,
    unscored: UnscoredSourceCandidate[],
    rawPayloads: CandidatePayload[],
    error: string | null = null
  ): SourceDiscoveryResult {
    const candidates = rankSourceCandidates(unscored)
    const discoveryId = randomUUID()
    const result: SourceDiscoveryResult = {
      discoveryId,
      sourceUrl,
      candidates,
      selectedCandidateId: candidates[0]?.id ?? null,
      error: candidates.length === 0 ? error : null
    }
    const payloads = new Map<string, CandidatePayload>()
    for (let index = 0; index < unscored.length; index += 1) {
      const candidate = unscored[index]!
      const id = `${candidate.sourceType.toUpperCase()}:${candidate.feedLink.trim()}`
      if (result.candidates.some((item) => item.id === id) && !payloads.has(id)) payloads.set(id, rawPayloads[index]!)
    }
    this.sessions.set(discoveryId, { createdAt: Date.now(), result, payloads })
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    return result
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(id)
  }
}

function rssCandidate(feed: DiscoveredRssFeed): UnscoredSourceCandidate {
  return {
    title: feed.title,
    feedLink: feed.feedUrl,
    sourceType: 'rss',
    kind: feed.discoveredFromPage ? 'RSS_DISCOVERED' : 'RSS_DIRECT',
    entries: feed.items.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

function rssHubCandidate(result: RssHubProbeResult): UnscoredSourceCandidate {
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

function jsonCandidate(probe: JsonSourceProbeResult): UnscoredSourceCandidate {
  return {
    title: probe.title,
    feedLink: probe.endpointUrl,
    sourceType: 'json',
    kind: 'JSON',
    entries: probe.articles.map((item) => ({ title: item.title, link: item.link, publishedAt: item.publishedAt }))
  }
}

function websiteCandidate(inspection: WebsiteInspectionResult, dynamic: boolean, browser: boolean, notice: string | null): UnscoredSourceCandidate {
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

function isExplicitJsonEndpoint(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase()
    return path.includes('/wp-json/') || path.endsWith('.json') || path.startsWith('/api/') || path.includes('/api/')
  } catch { return false }
}

function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 HTTP(S) 来源地址')
  return url.toString()
}

function rssHubFailureNotice(results: RssHubProbeResult[]): string | null {
  const result = results.find((item) => ['timeout', 'network_unavailable', 'needs_input'].includes(item.state))
  if (!result) return null
  if (result.state === 'timeout') return 'RSSHub 探测超时'
  if (result.state === 'network_unavailable') return 'RSSHub 实例暂时不可用'
  return `RSSHub 路由缺少参数：${result.match.missingParameters.join(', ')}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

