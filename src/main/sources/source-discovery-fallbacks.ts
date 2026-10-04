import type { RssHubProbeResult } from '../../shared/rsshub'
import type { CandidatePayload, DiscoveryContext, DiscoveryOutcome } from './source-discovery-types'
import { parseExplicitRssHubInput } from './rsshub/rsshub-input'
import { rssCandidate, rssHubCandidate, websiteCandidate, mergeRssHubProbeResults } from './source-discovery-candidates'
import { errorMessage, runStage, withAbortTimeout } from './source-discovery-stages'
import { explicitRssHubFailureNotice, rssHubFailureSummary } from './source-discovery-errors'
import { rankSourceCandidates } from './source-candidate-scorer'

// 沿用当前静态和动态探测时限；取消由同一信号传播到网络与 Chromium。
const STATIC_WEBSITE_TIMEOUT_MS = 15_000
const DYNAMIC_WEBSITE_TIMEOUT_MS = 20_000

/** 显式 RSSHub 地址先按逻辑路由解析，本地保留描述符，远端提交真实 XML URL。 */
export async function discoverExplicitRssHub(context: DiscoveryContext,
  input: NonNullable<ReturnType<typeof parseExplicitRssHubInput>>): Promise<DiscoveryOutcome> {
  const { dependencies, sourceUrl, isLocalAccount, signal, reportProgress } = context
  const resolver = dependencies.rssHubResolver
  const outcome = await runStage(async () => {
    if (!isLocalAccount && input.preferredInstance !== null && !resolver.isEnabled()) {
      return [await resolver.probeExplicitRoute(input.routePath, input.preferredInstance, signal)]
    }
    return resolver.probeRoute(input.routePath, input.preferredInstance, signal)
  }, { stage: 'rsshub', report: reportProgress, signal })
  const results = outcome.value ?? []
  const available = results.find((result) => result.available && result.feed && result.match.feedUrl)
  if (!available?.feed || !available.match.feedUrl) return {
    candidates: [], payloads: [], error: outcome.error ?? explicitRssHubFailureNotice(results), rssHubResults: results
  }
  const resolved = { ...available.feed, feedUrl: available.match.feedUrl, sourcePageUrl: isLocalAccount ? sourceUrl : available.match.feedUrl }
  const payload: CandidatePayload = isLocalAccount
    ? { type: 'rsshub', sourceUrl, result: { ...available, feed: resolved }, preferredInstance: input.preferredInstance }
    : { type: 'rss', discovered: resolved }
  return {
    candidates: [isLocalAccount ? rssHubCandidate({ ...available, feed: resolved }) : rssCandidate(resolved)],
    payloads: [payload], error: null, rssHubResults: isLocalAccount ? results : []
  }
}

/** 结构化探测均失败后才进入 RSSHub、静态网站、动态网站既有链路。 */
export async function discoverFallbacks(context: DiscoveryContext, lastError: string | null): Promise<DiscoveryOutcome> {
  if (!context.isLocalAccount) return { candidates: [], payloads: [], error: lastError ?? '未能识别出可订阅的 RSS / Atom 来源' }
  const hub = await probeRssHub(context)
  if (hub.candidates.length > 0) return hub
  const staticWebsite = await probeWebsite(context, false, hub.rssHubResults ?? [])
  if (rankSourceCandidates(staticWebsite.candidates).length > 0) return staticWebsite
  const dynamicWebsite = await probeWebsite(context, true, hub.rssHubResults ?? [])
  return { ...dynamicWebsite, error: dynamicWebsite.error ?? staticWebsite.error ?? hub.error ?? lastError }
}

/** 保留本地路由诊断及每个实例的真实失败，成功候选才进入统一评分。 */
async function probeRssHub(context: DiscoveryContext): Promise<DiscoveryOutcome> {
  const { dependencies, sourceUrl, reportProgress, signal } = context
  const outcome = await runStage(async () => {
    let local: RssHubProbeResult[] = []
    let probed: RssHubProbeResult[] = []
    let error: string | null = null
    try { local = dependencies.rssHubResolver.localRouteDiagnostics(sourceUrl) }
    catch (cause) { error = errorMessage(cause) }
    try { probed = await dependencies.rssHubResolver.probe(sourceUrl, undefined, signal) }
    catch (cause) {
      // 用户取消终止发现；普通实例失败进入诊断汇总，不伪装成可用来源。
      signal?.throwIfAborted()
      error = errorMessage(cause)
    }
    return { results: mergeRssHubProbeResults(local, probed), error }
  }, { stage: 'rsshub', report: reportProgress, signal })
  const results = outcome.value?.results ?? []
  const available = results.filter((result) => result.available && result.feed && result.match.feedUrl)
  return {
    candidates: available.map(rssHubCandidate),
    payloads: available.map((result) => ({ type: 'rsshub', sourceUrl, result, preferredInstance: null })),
    error: outcome.value?.error ?? outcome.error, rssHubResults: results
  }
}

/** 网站保留真实解析诊断；动态低可信来源仍由现有评分决定是否默认选择。 */
async function probeWebsite(context: DiscoveryContext, dynamic: boolean, results: RssHubProbeResult[]): Promise<DiscoveryOutcome> {
  const { dependencies, sourceUrl, reportProgress, signal } = context
  const outcome = await runStage(() => withAbortTimeout((stageSignal) => dynamic
    ? dependencies.websiteSource.inspectDynamic(sourceUrl, Date.now(), stageSignal)
    : dependencies.websiteSource.inspect(sourceUrl, Date.now(), stageSignal), {
    timeoutMs: dynamic ? DYNAMIC_WEBSITE_TIMEOUT_MS : STATIC_WEBSITE_TIMEOUT_MS,
    message: dynamic ? '动态网站探测超时' : '网站静态探测超时', externalSignal: signal
  }), { stage: dynamic ? 'dynamic_website' : 'website', report: reportProgress, signal })
  return outcome.value ? {
    candidates: [websiteCandidate(outcome.value, {
      dynamic, browser: !dependencies.websiteSource.hasRule(sourceUrl),
      notice: dynamic ? '该来源需要动态网页渲染' : rssHubFailureSummary(results)
    })],
    payloads: [{ type: 'website', inspection: outcome.value, dynamic }], error: null, rssHubResults: results
  } : { candidates: [], payloads: [], error: outcome.error ?? rssHubFailureSummary(results), rssHubResults: results }
}
