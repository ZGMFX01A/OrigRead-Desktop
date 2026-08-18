import { randomUUID } from 'node:crypto'
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { JsonSourceProbeResult } from '../../shared/json-source'
import type { RssHubProbeResult } from '../../shared/rsshub'
import type {
  RssHubRouteStatusSummary,
  SourceCandidateSummary,
  SourceDiscoveryStage,
  SourceDiscoveryStageState,
  SourceDiscoveryResult,
  SourceSubscriptionResult
} from '../../shared/source-discovery'
import type { WebsiteInspectionResult } from '../../shared/website'
import type { AccountRecord } from '../../shared/account'
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
type ProgressReporter = (stage: SourceDiscoveryStage, state: SourceDiscoveryStageState) => void

interface AccountSourceCoordinator {
  current(): AccountRecord
  subscribeRss(discovered: DiscoveredRssFeed, groupId?: string): Promise<string>
}

interface StageOutcome<T> {
  value: T | null
  error: string | null
}

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
    private readonly websiteSubscription: WebsiteSubscriptionService,
    private readonly accountCoordinator?: AccountSourceCoordinator
  ) {}

  async discover(rawUrl: string, reportProgress: ProgressReporter = () => undefined): Promise<SourceDiscoveryResult> {
    const sourceUrl = normalizeSourceUrl(rawUrl)
    this.pruneSessions()
    if (isExplicitJsonEndpoint(sourceUrl)) {
      const outcome = await runStage('json', reportProgress, () => this.jsonSource.probe(sourceUrl))
      reportProgress('ranking', 'running')
      const result = outcome.value
        ? this.createSession(sourceUrl, [jsonCandidate(outcome.value)], [{ type: 'json', probe: outcome.value }])
        : this.createSession(sourceUrl, [], [], outcome.error ?? '未能从该地址识别出有效的 JSON 文章列表')
      reportProgress('ranking', 'completed')
      return result
    }

    // 直接 Feed 先独立解析一次，避免 ATP / Rocket 这类大 RSS 在并行阶段被重复下载。
    // 但 Direct RSS 成功绝不能终止多渠道发现：Android 仍会继续检查 RSSHub / JSON / Website。
    // Desktop 这里复用 Feed 内的站点首页作为后续探测入口，不再次下载已经成功解析的 RSS XML。
    reportProgress('rss', 'running')
    const directRssOutcome = await captureOutcome(() => this.rssDiscovery.parseDirect(sourceUrl))
    if (directRssOutcome.value) {
      reportProgress('rss', 'completed')
      const candidates: UnscoredSourceCandidate[] = [rssCandidate(directRssOutcome.value)]
      const payloads: CandidatePayload[] = [{ type: 'rss', discovered: directRssOutcome.value }]
      const discoveryUrl = directRssOutcome.value.siteUrl ?? sourceUrl

      const [rssHubOutcome, jsonOutcome, websiteOutcome] = await Promise.all([
        runStage('rsshub', reportProgress, async () => {
          let local: RssHubProbeResult[] = []
          let probed: RssHubProbeResult[] = []
          let error: string | null = null
          try { local = this.rssHubResolver.localRouteDiagnostics(discoveryUrl) } catch (cause) { error = errorMessage(cause) }
          try { probed = await this.rssHubResolver.probe(discoveryUrl) } catch (cause) { error = errorMessage(cause) }
          return { results: mergeRssHubProbeResults(local, probed), error }
        }),
        runStage('json', reportProgress, () => this.jsonSource.probe(discoveryUrl)),
        runStage('website', reportProgress, () => withTimeout(this.websiteSource.inspect(discoveryUrl), 15_000, '网站静态探测超时'))
      ])

      const rssHubResults = rssHubOutcome.value?.results ?? []
      for (const result of rssHubResults.filter((item) => item.available && item.feed && item.match.feedUrl)) {
        candidates.push(rssHubCandidate(result))
        payloads.push({ type: 'rsshub', sourceUrl: discoveryUrl, result })
      }
      if (jsonOutcome.value) {
        candidates.push(jsonCandidate(jsonOutcome.value))
        payloads.push({ type: 'json', probe: jsonOutcome.value })
      }
      if (websiteOutcome.value) {
        candidates.push(websiteCandidate(
          websiteOutcome.value,
          false,
          !this.websiteSource.hasRule(discoveryUrl),
          rssHubFailureNotice(rssHubResults)
        ))
        payloads.push({ type: 'website', inspection: websiteOutcome.value, dynamic: false })
      }

      reportProgress('ranking', 'running')
      const result = this.createSession(
        sourceUrl,
        candidates,
        payloads,
        jsonOutcome.error ?? rssHubOutcome.value?.error ?? rssHubOutcome.error ?? websiteOutcome.error,
        rssHubResults.map(toRssHubRouteStatusSummary)
      )
      reportProgress('ranking', 'completed')
      return result
    }

    const candidates: UnscoredSourceCandidate[] = []
    const payloads: CandidatePayload[] = []

    // 输入 URL 本身不是 Feed 后，页面 RSS 发现 / RSSHub / JSON / 静态网页互不依赖，
    // 此处仍并行执行以避免普通网站把多段网络等待串起来。
    const [rssOutcome, rssHubOutcome, jsonOutcome, websiteOutcome] = await Promise.all([
      captureOutcome(() => withTimeout(this.rssDiscovery.discover(sourceUrl), 20_000, 'RSS 探测超时')),
      runStage('rsshub', reportProgress, async () => {
        let local: RssHubProbeResult[] = []
        let probed: RssHubProbeResult[] = []
        let error: string | null = null
        try { local = this.rssHubResolver.localRouteDiagnostics(sourceUrl) } catch (cause) { error = errorMessage(cause) }
        try { probed = await this.rssHubResolver.probe(sourceUrl) } catch (cause) { error = errorMessage(cause) }
        return { results: mergeRssHubProbeResults(local, probed), error }
      }),
      runStage('json', reportProgress, () => this.jsonSource.probe(sourceUrl)),
      runStage('website', reportProgress, () => withTimeout(this.websiteSource.inspect(sourceUrl), 15_000, '网站静态探测超时'))
    ])
    reportProgress('rss', 'completed')

    if (rssOutcome.value) {
      candidates.push(rssCandidate(rssOutcome.value))
      payloads.push({ type: 'rss', discovered: rssOutcome.value })
    }

    const rssHubResults = rssHubOutcome.value?.results ?? []
    for (const result of rssHubResults.filter((item) => item.available && item.feed && item.match.feedUrl)) {
      candidates.push(rssHubCandidate(result))
      payloads.push({ type: 'rsshub', sourceUrl, result })
    }

    if (jsonOutcome.value) {
      candidates.push(jsonCandidate(jsonOutcome.value))
      payloads.push({ type: 'json', probe: jsonOutcome.value })
    }

    if (websiteOutcome.value) {
      candidates.push(websiteCandidate(websiteOutcome.value, false, !this.websiteSource.hasRule(sourceUrl), rssHubFailureNotice(rssHubResults)))
      payloads.push({ type: 'website', inspection: websiteOutcome.value, dynamic: false })
    }

    let lastError = isLikelyDirectFeedUrl(sourceUrl)
      ? rssOutcome.error ?? directRssOutcome.error ?? websiteOutcome.error ?? jsonOutcome.error
      : websiteOutcome.error ?? jsonOutcome.error ?? rssHubOutcome.value?.error ?? rssHubOutcome.error ?? rssOutcome.error

    // Android：只有所有静态候选统一评分后一个都没通过，才启动动态 WebView/Chromium。
    if (rankSourceCandidates(candidates).length === 0) {
      const dynamicOutcome = await runStage('dynamic_website', reportProgress, () =>
        withTimeout(this.websiteSource.inspectDynamic(sourceUrl), 20_000, '动态网站探测超时'))
      if (dynamicOutcome.value) {
        candidates.push(websiteCandidate(dynamicOutcome.value, true, !this.websiteSource.hasRule(sourceUrl), '该来源需要动态网页渲染'))
        payloads.push({ type: 'website', inspection: dynamicOutcome.value, dynamic: true })
      } else if (dynamicOutcome.error) {
        lastError = dynamicOutcome.error
      }
    }

    reportProgress('ranking', 'running')
    const result = this.createSession(
      sourceUrl,
      candidates,
      payloads,
      lastError ?? rssHubFailureNotice(rssHubResults),
      rssHubResults.map(toRssHubRouteStatusSummary)
    )
    reportProgress('ranking', 'completed')
    return result
  }

  async subscribe(discoveryId: string, candidateId: string): Promise<SourceSubscriptionResult> {
    return (await this.subscribeMany(discoveryId, [candidateId]))[0]!
  }

  async subscribeMany(discoveryId: string, candidateIds: string[]): Promise<SourceSubscriptionResult[]> {
    const session = this.sessions.get(discoveryId)
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) throw new Error('来源发现结果已过期，请重新检测')
    const ids = [...new Set(candidateIds)]
    if (ids.length === 0 || ids.length > 8) throw new Error('请选择 1 到 8 个来源候选')
    const selections = ids.map((candidateId) => ({
      selected: session.result.candidates.find((candidate) => candidate.id === candidateId),
      payload: session.payloads.get(candidateId)
    }))
    if (selections.some(({ selected, payload }) => !selected || !payload)) throw new Error('未找到所选来源候选')
    if (selections.length > 1 && selections.some(({ selected }) => selected!.kind !== 'RSSHUB')) {
      throw new Error('只有 RSSHub 频道支持多选订阅')
    }

    const results: SourceSubscriptionResult[] = []
    for (const { selected, payload } of selections) {
      let feedId: string
      switch (payload!.type) {
        case 'rss':
          if (this.accountCoordinator && this.accountCoordinator.current().type !== 'local') {
            feedId = await this.accountCoordinator.subscribeRss(payload!.discovered)
          } else {
            feedId = this.rssSubscription.addDiscovered(payload!.discovered).feedId
          }
          break
        case 'rsshub':
          this.requireLocalAccount('RSSHub')
          feedId = this.rssHubSubscription.subscribe(payload!.sourceUrl, payload!.result).feedId
          break
        case 'json':
          this.requireLocalAccount('JSON/API')
          feedId = (await this.jsonSubscription.add(payload!.probe)).feedId
          break
        case 'website':
          this.requireLocalAccount('网站')
          feedId = (await this.websiteSubscription.add(payload!.inspection, payload!.dynamic)).feedId
          break
      }
      results.push({ feedId, selectedCandidate: selected! })
    }
    this.sessions.delete(discoveryId)
    return results
  }

  private requireLocalAccount(sourceKind:string):void {
    const account=this.accountCoordinator?.current()
    if(account && account.type!=='local')throw new Error(`${sourceKind} 来源仅支持 Local 账户`)
  }

  private createSession(
    sourceUrl: string,
    unscored: UnscoredSourceCandidate[],
    rawPayloads: CandidatePayload[],
    error: string | null = null,
    rssHubRoutes: RssHubRouteStatusSummary[] = []
  ): SourceDiscoveryResult {
    const candidates = rankSourceCandidates(unscored)
    const selectableIds = new Set(candidates.map((candidate) => candidate.id))
    const normalizedRssHubRoutes = rssHubRoutes.map((route) => {
      if (!route.candidateId || selectableIds.has(route.candidateId)) return route
      // 实例返回 Feed 只说明网络层可取；统一来源评分仍可能判定内容不可订阅。
      // UI 必须像 Android 一样显示“已匹配但内容未通过质量检查”，不能展示成可订阅按钮。
      return {
        ...route,
        candidateId: null,
        available: false,
        state: 'invalid_content' as const,
        message: 'Feed content failed unified source quality checks'
      }
    })
    const discoveryId = randomUUID()
    const result: SourceDiscoveryResult = {
      discoveryId,
      sourceUrl,
      candidates,
      rssHubRoutes: normalizedRssHubRoutes,
      // 低可信动态兜底必须由用户主动点选，不能像健康来源一样默认推荐/选中。
      selectedCandidateId: candidates.find((candidate) => candidate.diagnostics.accepted)?.id ?? null,
      error: candidates.length === 0 ? error : null
    }
    const payloads = new Map<string, CandidatePayload>()
    for (const selected of result.candidates) {
      const index = unscored.findIndex((candidate) =>
        candidate.kind === selected.kind
        && `${candidate.sourceType.toUpperCase()}:${candidate.feedLink.trim()}` === selected.id)
      if (index >= 0 && rawPayloads[index]) payloads.set(selected.id, rawPayloads[index]!)
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

/** 仅用于失败时选择更有意义的错误信息；所有普通 HTTP(S) 输入仍都会先尝试一次直接 RSS。 */
function isLikelyDirectFeedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const path = url.pathname.toLowerCase().replace(/\/+$/, '')
    const leaf = path.split('/').filter(Boolean).at(-1) ?? ''
    return ['rss', 'feed', 'feeds', 'atom'].includes(leaf)
      || /\.(?:rss|xml|atom|rdf)$/.test(path)
      || /(?:^|[?&])format=xml(?:&|$)/i.test(url.search)
      || /^feeds?\./i.test(url.hostname)
      || /feedburner\.com$/i.test(url.hostname)
  } catch {
    return false
  }
}

function rssHubFailureNotice(results: RssHubProbeResult[]): string | null {
  const result = results.find((item) => ['timeout', 'network_unavailable', 'needs_input', 'unsupported'].includes(item.state))
  if (!result) return null
  if (result.state === 'timeout') return 'RSSHub 探测超时'
  if (result.state === 'network_unavailable') return 'RSSHub 实例暂时不可用'
  if (result.state === 'unsupported') return 'RSSHub 已关闭或没有启用的实例'
  return `RSSHub 路由缺少参数：${result.match.missingParameters.join(', ')}`
}

function mergeRssHubProbeResults(local: RssHubProbeResult[], probed: RssHubProbeResult[]): RssHubProbeResult[] {
  const merged = new Map<string, RssHubProbeResult>()
  for (const result of local) merged.set(rssHubRouteKey(result), result)
  // 网络验证结果优先覆盖同一路由的本地占位状态；未返回的本地路由继续保留。
  for (const result of probed) merged.set(rssHubRouteKey(result), result)
  return [...merged.values()]
}

function rssHubRouteKey(result: RssHubProbeResult): string {
  const parameters = Object.entries(result.match.parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  return `${result.match.route.id}|${parameters}`
}

function toRssHubRouteStatusSummary(result: RssHubProbeResult): RssHubRouteStatusSummary {
  return {
    routeId: result.match.route.id,
    name: result.match.route.name,
    feedUrl: result.match.feedUrl,
    candidateId: result.available && result.match.feedUrl ? `RSS:${result.match.feedUrl.trim()}` : null,
    state: result.state,
    available: result.available,
    articleCount: result.feed?.items.length ?? 0,
    message: result.message
  }
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

async function runStage<T>(
  stage: SourceDiscoveryStage,
  report: ProgressReporter,
  work: () => Promise<T>
): Promise<StageOutcome<T>> {
  report(stage, 'running')
  try {
    return { value: await work(), error: null }
  } catch (error) {
    return { value: null, error: errorMessage(error) }
  } finally {
    report(stage, 'completed')
  }
}

async function captureOutcome<T>(work: () => Promise<T>): Promise<StageOutcome<T>> {
  try {
    return { value: await work(), error: null }
  } catch (error) {
    return { value: null, error: errorMessage(error) }
  }
}

