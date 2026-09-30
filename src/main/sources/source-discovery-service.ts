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
import { parseExplicitRssHubInput } from './rsshub/rsshub-input'
import { WebsiteSourceService } from './website/website-source-service'
import { WebsiteSubscriptionService } from './website/website-subscription-service'
import { rankSourceCandidates, type UnscoredSourceCandidate } from './source-candidate-scorer'
import { sourceInputHint } from './source-input-classifier'
import type { FeedDiscoveryCatalog } from '../discovery/feed-discovery-catalog'
import { emptyFeedCatalogUrlMatch, preferredCatalogProbeUrl, type FeedCatalogUrlMatch } from '../../shared/feed-catalog-index'

type CandidatePayload =
  | { type: 'rss'; discovered: DiscoveredRssFeed }
  | { type: 'rsshub'; sourceUrl: string; result: RssHubProbeResult; preferredInstance: string | null }
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
    const account = this.accountCoordinator?.current()
    const isLocalAccount = !account || account.type === 'local'
    const knownInstances = this.rssHubResolver.knownInstanceUrls()
    const explicitRssHubInput = parseExplicitRssHubInput(rawUrl, knownInstances)
    if (/^rsshub:/i.test(rawUrl.trim()) && !explicitRssHubInput) throw new Error('无效的 RSSHub 路由地址')
    const sourceUrl = explicitRssHubInput?.originalInput ?? normalizeSourceUrl(rawUrl)
    this.pruneSessions()
    const inputHint = sourceInputHint(sourceUrl)
    const catalogMatch = explicitRssHubInput ? emptyFeedCatalogUrlMatch() : this.safeCatalogMatch(sourceUrl)

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
    if (isLocalAccount && explicitRssHubInput?.routePath && this.rssHubSubscription.hasExistingRoute(explicitRssHubInput.routePath)) {
      return finish([], [], '来源已存在')
    }
    if (!explicitRssHubInput && this.rssSubscription.hasExistingSource(sourceUrl)) {
      return finish([], [], '来源已存在')
    }

    // 显式 RSSHub 输入（rsshub:// 或已知实例 URL）必须先抽成 logical route，再做实例 failover。
    if (explicitRssHubInput) {
      const shouldProbeExplicit = !isLocalAccount && explicitRssHubInput.preferredInstance !== null && !this.rssHubResolver.isEnabled()
      const outcome = await runStage('rsshub', reportProgress, async () => {
        if (shouldProbeExplicit) {
          return [await this.rssHubResolver.probeExplicitRoute(
            explicitRssHubInput.routePath,
            explicitRssHubInput.preferredInstance!,
            signal
          )]
        }
        return this.rssHubResolver.probeRoute(
          explicitRssHubInput.routePath,
          explicitRssHubInput.preferredInstance,
          signal
        )
      }, signal)
      const results = outcome.value ?? []
      const available = results.find((result) => result.available && result.feed && result.match.feedUrl)
      if (!available?.feed || !available.match.feedUrl) {
        return finish([], [], outcome.error ?? explicitRssHubFailureNotice(results), results)
      }
      const resolvedFeed: DiscoveredRssFeed = {
        ...available.feed,
        feedUrl: available.match.feedUrl,
        sourcePageUrl: isLocalAccount ? sourceUrl : available.match.feedUrl
      }
      const candidate = isLocalAccount ? rssHubCandidate({ ...available, feed: resolvedFeed }) : rssCandidate(resolvedFeed)
      const payload: CandidatePayload = isLocalAccount
        ? {
            type: 'rsshub',
            sourceUrl,
            result: { ...available, feed: resolvedFeed },
            preferredInstance: explicitRssHubInput.preferredInstance
          }
        : { type: 'rss', discovered: resolvedFeed }
      return finish([candidate], [payload], null, isLocalAccount ? results : [])
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
      payloads.push({ type: 'rsshub', sourceUrl, result, preferredInstance: null })
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
        rssHubFailureSummary(rssHubResults)
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
      lastError ?? rssHubFailureSummary(rssHubResults),
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
          feedId = this.rssHubSubscription.subscribe(
            payload!.sourceUrl,
            payload!.result,
            payload!.preferredInstance
          ).feedId
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


export function rssHubFailureText(result: RssHubProbeResult): string {
  const reason = result.failureReason ?? (
    result.state === 'timeout'
      ? 'timeout'
      : result.state === 'network_unavailable'
        ? 'network_unavailable'
        : result.state === 'invalid_content'
          ? 'invalid_content'
          : null
  )
  switch (reason) {
    case 'blocked':
      return 'RSSHub 服务器或上游网站返回了人机验证或反爬拦截页面。请重试或换用其他实例。'
    case 'http_error':
      switch (result.statusCode) {
        case 401:
          return 'HTTP 401：请求需要身份认证。请检查实例访问权限或路由配置。'
        case 403:
          return 'HTTP 403：服务器拒绝了请求。请尝试其他实例或检查访问规则。'
        case 404:
          return 'HTTP 404：找不到请求的地址或路由。请检查路由和实例基础地址。'
        case 429:
          return 'HTTP 429：服务器限制了请求频率。请稍后重试或换用其他实例。'
        case null:
        case undefined:
          return 'RSSHub 请求在服务器或上游网站执行失败。请查看各服务器的具体原因，或尝试其他实例。'
        default:
          return `RSSHub 服务器返回 HTTP ${result.statusCode}。请检查服务器或上游路由，稍后重试。`
      }
    case 'timeout':
      return 'RSSHub 请求超时。请稍后重试或换用其他实例。'
    case 'network_unavailable':
      return '无法连接这个 RSSHub 服务器。请检查网络和服务器地址。'
    case 'connection_closed':
      return '连接在响应完成前被关闭。请重试，或检查代理和服务器。'
    case 'dns_failure':
      return '无法解析 RSSHub 服务器域名。请检查服务器地址和 DNS 设置。'
    case 'tls_error':
      return '无法与 RSSHub 建立安全连接。请检查服务器证书或代理设置。'
    case 'html_response':
      return '服务器返回了网页，而非 RSS/Atom。请检查实例地址和路由。'
    case 'invalid_content':
      return '服务器返回的内容无法解析为有效的 RSS/Atom。'
    case 'disabled':
      return 'RSSHub 当前已关闭。请在设置中启用后重试。'
    case 'no_instances':
      return '没有启用任何 RSSHub 实例。请在设置中添加或启用实例。'
    case 'probe_budget_exhausted':
      return '本次 RSSHub 探测超时，部分实例尚未完成。请重试或调整实例顺序。'
    case 'unsupported_format':
      return '此 RSSHub 返回了暂不支持的格式（如 JSON）。请使用 RSS 或 Atom 输出，例如将 format 改为 rss。'
    case 'authentication_requires_instance':
      return '此 RSSHub 路由包含访问密钥或访问码。请填写所属实例的完整 HTTP/HTTPS 地址，避免将凭证发送给其他实例。'
    case 'bound_instance_disabled':
      return '此带凭证订阅所属的 RSSHub 实例已被禁用或删除。请启用原实例后再进行自动恢复。'
    default:
      if (result.state === 'needs_input') {
        return `RSSHub 匹配项“${result.match.route.name}”还需要更多信息（${result.match.missingParameters.join(', ')}），请填写更具体的页面地址。`
      }
      if (result.state === 'unsupported') {
        return 'RSSHub 当前已关闭。请在设置中启用后重试。'
      }
      return '本次未获得可用的 RSSHub 订阅。请查看具体原因后重试。'
  }
}

export function rssHubFailureSummary(results: RssHubProbeResult[]): string | null {
  const failures = results.filter((item) => !item.available)
  if (failures.length === 0) return null
  const budget = failures.find((item) => item.failureReason === 'probe_budget_exhausted')
  if (budget) return rssHubFailureText(budget)
  const texts = [...new Set(failures.map(rssHubFailureText))]
  if (texts.length > 1) {
    return '不同 RSSHub 服务器返回了不同错误。请查看下方各服务器的具体原因后重试。'
  }
  return texts[0] ?? null
}

export function explicitRssHubFailureNotice(results: RssHubProbeResult[]): string {
  return rssHubFailureSummary(results) ?? '本次未获得可用的 RSSHub 订阅。请查看具体原因后重试。'
}

function mergeRssHubProbeResults(local: RssHubProbeResult[], probed: RssHubProbeResult[]): RssHubProbeResult[] {
  const merged = new Map<string, RssHubProbeResult>()
  for (const result of local) merged.set(rssHubRouteKey(result), result)
  // 只替换本地占位诊断。同一路由可以有多个真实诊断，例如 HTTP 503 加验证未完成。
  for (const result of probed) merged.delete(rssHubRouteKey(result))
  return [...merged.values(), ...probed]
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
    message: result.message,
    instanceBaseUrl: result.instanceBaseUrl ?? null,
    failureReason: result.failureReason ?? null,
    statusCode: result.statusCode ?? null
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
