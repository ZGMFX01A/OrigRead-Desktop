import { randomUUID } from 'node:crypto'
import type { SourceDiscoveryResult, SourceSubscriptionResult, SourceCandidateSummary } from '../../shared/source-discovery'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import { emptyFeedCatalogUrlMatch, type FeedCatalogUrlMatch } from '../../shared/feed-catalog-index'
import { parseExplicitRssHubInput } from './rsshub/rsshub-input'
import { rankSourceCandidates } from './source-candidate-scorer'
import { toRssHubRouteStatusSummary } from './source-discovery-candidates'
import { normalizeSourceUrl } from './source-discovery-stages'
import { discoverStructured } from './source-discovery-structured'
import { discoverExplicitRssHub, discoverFallbacks } from './source-discovery-fallbacks'
import type { CandidatePayload, DiscoveryOutcome, ProgressReporter, SourceDiscoveryDependencies } from './source-discovery-types'
export { rssHubFailureText, rssHubFailureSummary, explicitRssHubFailureNotice } from './source-discovery-errors'

interface DiscoverySession {
  createdAt: number
  accountId: number
  result: SourceDiscoveryResult
  payloads: ReadonlyMap<string, CandidatePayload>
}
interface Selection { selected: SourceCandidateSummary; payload: CandidatePayload }

// 沿用既有会话有效期与数量，仅管理 UI 发现结果的生命周期。
const SESSION_TTL_MS = 10 * 60_000
const MAX_SESSIONS = 20
// 多选仅支持既有 RSSHub 频道选择上限。
const MAX_CHANNEL_SELECTIONS = 8

export class SourceDiscoveryService {
  private readonly sessions = new Map<string, DiscoverySession>()
  constructor(private readonly dependencies: SourceDiscoveryDependencies) {}

  /** 发现开始时固定账户，已成功解析 RSS / Atom 的输入直接结束后续探测。 */
  async discover(rawUrl: string, reportProgress: ProgressReporter = () => undefined, signal?: AbortSignal): Promise<SourceDiscoveryResult> {
    signal?.throwIfAborted()
    const accountId = this.currentAccountId()
    const account = this.dependencies.accountCoordinator?.current()
    const isLocalAccount = !account || account.type === 'local'
    const { explicit, sourceUrl } = this.parseInput(rawUrl)
    this.pruneSessions()
    const catalogMatch = explicit ? emptyFeedCatalogUrlMatch() : this.safeCatalogMatch(sourceUrl)
    const context = { dependencies: this.dependencies, sourceUrl, isLocalAccount, catalogMatch, reportProgress, signal }
    const existing = this.hasExistingSource(sourceUrl, { explicit, isLocalAccount })
    let outcome: DiscoveryOutcome = { candidates: [], payloads: [], error: '来源已存在' }
    if (!existing) {
      outcome = explicit ? await discoverExplicitRssHub(context, explicit) : await discoverStructured(context)
      if (!explicit && outcome.candidates.length === 0) outcome = await discoverFallbacks(context, outcome.error)
    }
    signal?.throwIfAborted()
    reportProgress('ranking', 'running')
    const result = this.createSession({ sourceUrl, accountId, catalogMatch, outcome })
    reportProgress('ranking', 'completed')
    return result
  }

  /** 显式 RSSHub 输入必须先验证路由；普通输入按 HTTP 地址验证。 */
  private parseInput(rawUrl: string) {
    const explicit = parseExplicitRssHubInput(rawUrl, this.dependencies.rssHubResolver.knownInstanceUrls())
    if (/^rsshub:/i.test(rawUrl.trim()) && !explicit) throw new Error('无效的 RSSHub 路由地址')
    return { explicit, sourceUrl: explicit?.originalInput ?? normalizeSourceUrl(rawUrl) }
  }

  /** Local 按持久化路由查重，其余普通订阅按当前账户的地址查重。 */
  private hasExistingSource(sourceUrl: string, context: {
    explicit: ReturnType<typeof parseExplicitRssHubInput>; isLocalAccount: boolean
  }): boolean {
    if (context.isLocalAccount && context.explicit?.routePath) {
      return this.dependencies.rssHubSubscription.hasExistingRoute(context.explicit.routePath)
    }
    return !context.explicit && this.dependencies.rssSubscription.hasExistingSource(sourceUrl)
  }

  async subscribe(discoveryId: string, candidateId: string): Promise<SourceSubscriptionResult> {
    return (await this.subscribeMany(discoveryId, [candidateId]))[0]!
  }

  /** 会话不能跨账户提交；多频道由同一事务保存，失败保留会话供重试。 */
  async subscribeMany(discoveryId: string, candidateIds: string[]): Promise<SourceSubscriptionResult[]> {
    const session = this.sessions.get(discoveryId)
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) throw new Error('来源发现结果已过期，请重新检测')
    if (session.accountId !== this.currentAccountId()) throw new Error('当前账户已切换，请在目标账户重新检测来源')
    const selections = this.selectCandidates(session, candidateIds)
    let results: SourceSubscriptionResult[]
    if (selections.length > 1) {
      this.requireLocalAccount('RSSHub')
      const payloads = selections.map(({ payload }) => {
        if (payload.type !== 'rsshub') throw new Error('只有 RSSHub 频道支持多选订阅')
        return payload
      })
      const subscriptions = this.dependencies.rssHubSubscription.subscribeMany(payloads)
      results = subscriptions.map((subscription, i) => ({ feedId: subscription.feedId, selectedCandidate: selections[i]!.selected }))
    } else {
      results = [{ feedId: await this.persistSelection(selections[0]!.payload, session.accountId), selectedCandidate: selections[0]!.selected }]
    }
    this.sessions.delete(discoveryId)
    return results
  }

  private selectCandidates(session: DiscoverySession, candidateIds: string[]): Selection[] {
    const ids = [...new Set(candidateIds)]
    if (ids.length === 0 || ids.length > MAX_CHANNEL_SELECTIONS) throw new Error('请选择 1 到 8 个来源候选')
    const selections = ids.map((id) => {
      const selected = session.result.candidates.find((candidate) => candidate.id === id)
      const payload = session.payloads.get(id)
      if (!selected || !payload) throw new Error('未找到所选来源候选')
      return { selected, payload }
    })
    if (selections.length > 1 && selections.some(({ selected }) => selected.kind !== 'RSSHUB')) throw new Error('只有 RSSHub 频道支持多选订阅')
    return selections
  }

  /** 本地复用已解析文章，远端提交真实 RSS URL；账户检查必须先于任何写入或网络调用。 */
  private async persistSelection(payload: CandidatePayload, accountId: number): Promise<string> {
    const services = this.dependencies
    switch (payload.type) {
      case 'rss':
        return services.accountCoordinator && services.accountCoordinator.current().type !== 'local'
          ? services.accountCoordinator.subscribeRss(payload.discovered)
          : services.rssSubscription.addDiscovered(payload.discovered, accountId).feedId
      case 'rsshub':
        this.requireLocalAccount('RSSHub')
        return services.rssHubSubscription.subscribe(payload.sourceUrl, payload.result, payload.preferredInstance).feedId
      case 'json':
        this.requireLocalAccount('JSON/API')
        return (await services.jsonSubscription.add(payload.probe)).feedId
      case 'website':
        this.requireLocalAccount('网站')
        return (await services.websiteSubscription.add(payload.inspection, payload.dynamic)).feedId
    }
  }

  private currentAccountId(): number {
    return this.dependencies.accountCoordinator?.current().id ?? this.dependencies.rssSubscription.getCurrentAccountId()
  }

  private requireLocalAccount(sourceKind: string): void {
    const account = this.dependencies.accountCoordinator?.current()
    if (account && account.type !== 'local') throw new Error(sourceKind + ' 来源仅支持 Local 账户')
  }

  /** 评分后只保存仍可选择的 payload，来源和账户身份随会话固定。 */
  private createSession(options: { sourceUrl: string; accountId: number; catalogMatch: FeedCatalogUrlMatch; outcome: DiscoveryOutcome }): SourceDiscoveryResult {
    const { sourceUrl, accountId, catalogMatch, outcome } = options
    const candidates = rankSourceCandidates(outcome.candidates)
    const result: SourceDiscoveryResult = {
      discoveryId: randomUUID(), sourceUrl, candidates,
      rssHubRoutes: this.routeStatuses(outcome, candidates), catalogMatches: catalogMatch.suggestions,
      catalogMatchCount: catalogMatch.totalSuggestions,
      selectedCandidateId: candidates.find((candidate) => candidate.diagnostics.accepted)?.id ?? null,
      error: candidates.length === 0 ? outcome.error : null
    }
    const payloads = new Map<string, CandidatePayload>()
    for (const selected of candidates) {
      const index = outcome.candidates.findIndex((candidate) => candidate.kind === selected.kind
        && candidate.sourceType.toUpperCase() + ':' + sourceUrlComparisonKey(candidate.feedLink) === selected.id)
      if (index >= 0 && outcome.payloads[index]) payloads.set(selected.id, outcome.payloads[index]!)
    }
    this.sessions.set(result.discoveryId, { createdAt: Date.now(), accountId, result, payloads })
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
    return result
  }

  /** 实例返回 XML 后仍需统一评分通过，未通过的路由保持明确不可选诊断。 */
  private routeStatuses(outcome: DiscoveryOutcome, candidates: SourceCandidateSummary[]) {
    const selectable = new Set(candidates.map((candidate) => candidate.id))
    return (outcome.rssHubResults ?? []).map(toRssHubRouteStatusSummary).map((route) =>
      !route.candidateId || selectable.has(route.candidateId) ? route : {
        ...route, candidateId: null, available: false, state: 'invalid_content' as const,
        message: 'Feed content failed unified source quality checks'
      })
  }

  private safeCatalogMatch(sourceUrl: string): FeedCatalogUrlMatch {
    try { return this.dependencies.feedDiscoveryCatalog?.matchUrl(sourceUrl) ?? emptyFeedCatalogUrlMatch() }
    catch {
      // 既有目录读取是增量能力，直接 XML 探测仍是决定是否可订阅的依据。
      return emptyFeedCatalogUrlMatch()
    }
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(id)
  }
}
