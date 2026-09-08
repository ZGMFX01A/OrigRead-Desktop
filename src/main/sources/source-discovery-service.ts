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
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import { JsonSourceService } from './json/json-source-service'
import { JsonSubscriptionService } from './json/json-subscription-service'
import { RssDiscoveryService } from './rss/rss-discovery-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { RssHubResolver } from './rsshub/rsshub-resolver'
import { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import { WebsiteSourceService } from './website/website-source-service'
import { WebsiteSubscriptionService } from './website/website-subscription-service'
import { rankSourceCandidates, type UnscoredSourceCandidate } from './source-candidate-scorer'
import { isKnownRssHubEndpoint, sourceInputHint } from './source-input-classifier'
import type { FeedDiscoveryCatalog } from '../discovery/feed-discovery-catalog'
import { emptyFeedCatalogUrlMatch, preferredCatalogProbeUrl, type FeedCatalogUrlMatch } from '../../shared/feed-catalog-index'

type CandidatePayload =
  | { type: 'rss'; discovered: DiscoveredRssFeed }
  | { type: 'rsshub'; sourceUrl: string; result: RssHubProbeResult }
  | { type: 'rsshub_direct'; sourceUrl: string; discovered: DiscoveredRssFeed }
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
    private readonly accountCoordinator?: AccountSourceCoordinator,
    private readonly feedDiscoveryCatalog?: FeedDiscoveryCatalog
  ) {}

  async discover(
    rawUrl: string,
    reportProgress: ProgressReporter = () => undefined,
    signal?: AbortSignal
  ): Promise<SourceDiscoveryResult> {
    signal?.throwIfAborted()
    const sourceUrl = normalizeSourceUrl(rawUrl)
    this.pruneSessions()

    const account = this.accountCoordinator?.current()
    const isLocalAccount = !account || account.type === 'local'
    const knownInstances = this.rssHubResolver.knownInstanceUrls()
    const knownRssHubEndpoint = isKnownRssHubEndpoint(sourceUrl, knownInstances)
    const inputHint = sourceInputHint(sourceUrl)
    const catalogMatch = knownRssHubEndpoint ? emptyFeedCatalogUrlMatch() : this.safeCatalogMatch(sourceUrl)

    const finish = (
      candidates: UnscoredSourceCandidate[],
      payloads: CandidatePayload[],
      error: string | null,
      rssHubResults: RssHubProbeResult[] = []
    ): SourceDiscoveryResult => {
      signal?.throwIfAborted()
      reportProgress('ranking', 'running')
      const result = this.createSession(
        sourceUrl,
        candidates,
        payloads,
        error,
        rssHubResults.map(toRssHubRouteStatusSummary),
        catalogMatch
      )
      reportProgress('ranking', 'completed')
      return result
    }

    // Android performs this guard before the first network stage. Persistence still keeps its own
    // duplicate protection; this only avoids redundant discovery work and duplicate UI choices.
    if (this.rssSubscription.hasExistingSource(sourceUrl)) {
      return finish([], [], '来源已存在')
    }

    // 与 Android 一致：只有“官方/已配置 RSSHub 实例下的 route URL”是网络前硬分支。
    // Local 保留 RSSHub provenance；远端账户把它当标准 RSS URL 订阅。
    if (knownRssHubEndpoint) {
      const outcome = await runStage('rsshub', reportProgress, () =>
        withAbortTimeout(
          (stageSignal) => this.rssDiscovery.parseDirect(sourceUrl, sourceUrl, stageSignal),
          20_000,
          'RSSHub 地址探测超时',
          signal
        ), signal)
      if (!outcome.value) {
        return finish([], [], outcome.error ?? '未能连接或解析该 RSSHub 实例地址')
      }
      const candidate = isLocalAccount ? rssHubDirectCandidate(outcome.value) : rssCandidate(outcome.value)
      const payload: CandidatePayload = isLocalAccount
        ? { type: 'rsshub_direct', sourceUrl, discovered: outcome.value }
        : { type: 'rss', discovered: outcome.value }
      const directRssHubResult = isLocalAccount ? [directRssHubProbeResult(sourceUrl, outcome.value)] : []
      return finish([candidate], [payload], null, directRssHubResult)
    }

    const candidates: UnscoredSourceCandidate[] = []
    const payloads: CandidatePayload[] = []
    let lastError: string | null = null

    const probeRss = async (): Promise<boolean> => {
      // 与 Android 一致：目录 Feed 只是“不增加等待时间”的旁路知识。它和用户输入的 RSS
      // 探测同时开始；只有主探测失败时它已经完成，才把结果作为 RSS 兜底，否则直接放弃。
      const catalogProbeUrl = preferredCatalogProbeUrl(catalogMatch, sourceUrl)
      const catalogController = catalogProbeUrl ? new AbortController() : null
      const catalogProbe = catalogProbeUrl
        ? trackOutcome(() => withAbortTimeout(
            (stageSignal) => this.rssDiscovery.discover(catalogProbeUrl, AbortSignal.any([stageSignal, catalogController!.signal])),
            20_000,
            '目录 Feed 探测超时',
            signal
          ))
        : null

      const outcome = await runStage('rss', reportProgress, () =>
        withAbortTimeout(
          (stageSignal) => this.rssDiscovery.discover(sourceUrl, stageSignal),
          20_000,
          'RSS 探测超时',
          signal
        ), signal)
      if (outcome.value) {
        catalogController?.abort()
        candidates.push(rssCandidate(outcome.value))
        payloads.push({ type: 'rss', discovered: outcome.value })
        return true
      }
      if (outcome.error) lastError = outcome.error

      if (!catalogProbe?.settled || !catalogProbe.value) {
        catalogController?.abort()
        return false
      }
      candidates.push(rssCandidate(catalogProbe.value))
      payloads.push({ type: 'rss', discovered: catalogProbe.value })
      return true
    }

    const probeJson = async (): Promise<boolean> => {
      if (!isLocalAccount) return false
      const outcome = await runStage('json', reportProgress, () => this.jsonSource.probe(sourceUrl, signal), signal)
      if (!outcome.value) {
        if (outcome.error) lastError = outcome.error
        return false
      }
      candidates.push(jsonCandidate(outcome.value))
      payloads.push({ type: 'json', probe: outcome.value })
      return true
    }

    // URL 形状只决定 RSS / JSON 的尝试顺序。任何一方真实解析成功都立即结束结构化探测。
    const structuredSourceFound = inputHint === 'JSON_LIKELY' && isLocalAccount
      ? await probeJson() || await probeRss()
      : await probeRss() || await probeJson()
    if (structuredSourceFound) return finish(candidates, payloads, null)

    // FreshRSS / Google Reader 等远端账户只支持它们自身可订阅的 RSS。
    if (!isLocalAccount) return finish(candidates, payloads, lastError ?? '未能识别出可订阅的 RSS / Atom 来源')

    const rssHubOutcome = await runStage('rsshub', reportProgress, async () => {
      signal?.throwIfAborted()
      let local: RssHubProbeResult[] = []
      let probed: RssHubProbeResult[] = []
      let error: string | null = null
      try { local = this.rssHubResolver.localRouteDiagnostics(sourceUrl) } catch (cause) { error = errorMessage(cause) }
      try {
        probed = await this.rssHubResolver.probe(sourceUrl, undefined, signal)
      } catch (cause) {
        if (signal?.aborted) throw cause
        error = errorMessage(cause)
      }
      return { results: mergeRssHubProbeResults(local, probed), error }
    }, signal)
    const rssHubResults = rssHubOutcome.value?.results ?? []
    if (rssHubOutcome.value?.error) lastError = rssHubOutcome.value.error
    else if (rssHubOutcome.error) lastError = rssHubOutcome.error
    for (const result of rssHubResults.filter((item) => item.available && item.feed && item.match.feedUrl)) {
      candidates.push(rssHubCandidate(result))
      payloads.push({ type: 'rsshub', sourceUrl, result })
    }
    // Android 在 RSSHub route 已真实可用后就结束 fallback 链。
    if (candidates.some((candidate) => candidate.kind === 'RSSHUB')) {
      return finish(candidates, payloads, null, rssHubResults)
    }

    const websiteOutcome = await runStage('website', reportProgress, () =>
      withAbortTimeout(
        (stageSignal) => this.websiteSource.inspect(sourceUrl, Date.now(), stageSignal),
        15_000,
        '网站静态探测超时',
        signal
      ), signal)
    if (websiteOutcome.value) {
      candidates.push(websiteCandidate(
        websiteOutcome.value,
        false,
        !this.websiteSource.hasRule(sourceUrl),
        rssHubFailureNotice(rssHubResults)
      ))
      payloads.push({ type: 'website', inspection: websiteOutcome.value, dynamic: false })
    } else if (websiteOutcome.error) {
      lastError = websiteOutcome.error
    }
    if (rankSourceCandidates(candidates).length > 0) {
      return finish(candidates, payloads, null, rssHubResults)
    }

    const dynamicOutcome = await runStage('dynamic_website', reportProgress, () =>
      withAbortTimeout(
        (stageSignal) => this.websiteSource.inspectDynamic(sourceUrl, Date.now(), stageSignal),
        20_000,
        '动态网站探测超时',
        signal
      ), signal)
    if (dynamicOutcome.value) {
      candidates.push(websiteCandidate(
        dynamicOutcome.value,
        true,
        !this.websiteSource.hasRule(sourceUrl),
        '该来源需要动态网页渲染'
      ))
      payloads.push({ type: 'website', inspection: dynamicOutcome.value, dynamic: true })
    } else if (dynamicOutcome.error) {
      lastError = dynamicOutcome.error
    }

    return finish(
      candidates,
      payloads,
      lastError ?? rssHubFailureNotice(rssHubResults),
      rssHubResults
    )
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
        case 'rsshub_direct':
          this.requireLocalAccount('RSSHub')
          feedId = this.rssHubSubscription.subscribeDirect(payload!.sourceUrl, payload!.discovered).feedId
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
    rssHubRoutes: RssHubRouteStatusSummary[] = [],
    catalogMatch: FeedCatalogUrlMatch = emptyFeedCatalogUrlMatch()
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
      catalogMatches: catalogMatch.suggestions,
      catalogMatchCount: catalogMatch.totalSuggestions,
      // 低可信动态兜底必须由用户主动点选，不能像健康来源一样默认推荐/选中。
      selectedCandidateId: candidates.find((candidate) => candidate.diagnostics.accepted)?.id ?? null,
      error: candidates.length === 0 ? error : null
    }
    const payloads = new Map<string, CandidatePayload>()
    for (const selected of result.candidates) {
      const index = unscored.findIndex((candidate) =>
        candidate.kind === selected.kind
        && `${candidate.sourceType.toUpperCase()}:${sourceUrlComparisonKey(candidate.feedLink)}` === selected.id)
      if (index >= 0 && rawPayloads[index]) payloads.set(selected.id, rawPayloads[index]!)
    }
    this.sessions.set(discoveryId, { createdAt: Date.now(), result, payloads })
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    return result
  }

  private safeCatalogMatch(sourceUrl: string): FeedCatalogUrlMatch {
    try {
      return this.feedDiscoveryCatalog?.matchUrl(sourceUrl) ?? emptyFeedCatalogUrlMatch()
    } catch {
      // Catalog 是增量能力，目录读取/匹配失败不得破坏既有来源发现链。
      return emptyFeedCatalogUrlMatch()
    }
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(id)
  }
}

function trackOutcome<T>(factory: () => Promise<T>): { settled: boolean; value: T | null } {
  const tracker = { settled: false, value: null as T | null }
  void factory()
    .then((value) => { tracker.value = value })
    .catch(() => undefined)
    .finally(() => { tracker.settled = true })
  return tracker
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

function directRssHubProbeResult(sourceUrl: string, feed: DiscoveredRssFeed): RssHubProbeResult {
  const parsed = new URL(sourceUrl)
  return {
    state: 'available',
    available: true,
    message: null,
    match: {
      route: {
        id: 'direct-endpoint',
        name: 'RSSHub',
        host: parsed.hostname,
        pathPrefix: '/',
        target: parsed.pathname
      },
      feedUrl: feed.feedUrl,
      parameters: {},
      missingParameters: [],
      resolved: true
    },
    feed
  }
}

function rssHubDirectCandidate(feed: DiscoveredRssFeed): UnscoredSourceCandidate {
  return {
    title: feed.title,
    feedLink: feed.feedUrl,
    sourceType: 'rss',
    kind: 'RSSHUB',
    sourceNotice: 'RSSHub',
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

function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim()
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(normalized)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 HTTP(S) 来源地址')
  return url.toString()
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
    candidateId: result.available && result.match.feedUrl ? `RSS:${sourceUrlComparisonKey(result.match.feedUrl)}` : null,
    state: result.state,
    available: result.available,
    articleCount: result.feed?.items.length ?? 0,
    message: result.message
  }
}

async function withAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs)
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal
  try {
    externalSignal?.throwIfAborted()
    return await work(signal)
  } catch (error) {
    if (externalSignal?.aborted) throw abortReason(externalSignal, error)
    if (controller.signal.aborted) throw new Error(message)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function runStage<T>(
  stage: SourceDiscoveryStage,
  report: ProgressReporter,
  work: () => Promise<T>,
  signal?: AbortSignal
): Promise<StageOutcome<T>> {
  report(stage, 'running')
  try {
    signal?.throwIfAborted()
    return { value: await work(), error: null }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal, error)
    return { value: null, error: errorMessage(error) }
  } finally {
    report(stage, 'completed')
  }
}

function abortReason(signal: AbortSignal, fallback?: unknown): unknown {
  return signal.reason ?? fallback ?? new DOMException('Aborted', 'AbortError')
}
