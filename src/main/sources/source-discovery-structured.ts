import type { DiscoveryContext, DiscoveryOutcome } from './source-discovery-types'
import { preferredCatalogProbeUrl } from '../../shared/feed-catalog-index'
import { sourceInputHint } from './source-input-classifier'
import { jsonCandidate, rssCandidate } from './source-discovery-candidates'
import { runStage, trackOutcome, withAbortTimeout } from './source-discovery-stages'

// 沿用既有发现阶段时限，目录查询不延长直接 RSS 的等待时间。
const RSS_PROBE_TIMEOUT_MS = 20_000

/** URL 形状仅决定尝试顺序；任何结构化来源真正解析成功后立即停止后续探测。 */
export async function discoverStructured(context: DiscoveryContext): Promise<DiscoveryOutcome> {
  const preferJson = context.isLocalAccount && sourceInputHint(context.sourceUrl) === 'JSON_LIKELY'
  const first = preferJson ? await probeJson(context) : await probeRss(context)
  if (first.candidates.length > 0) return first
  const second = preferJson ? await probeRss(context) : await probeJson(context)
  return { ...second, error: second.error ?? first.error }
}

/** 主 RSS 与已有目录候选并行，目录只有在主探测失败且它已经完成时才参与结果。 */
async function probeRss(context: DiscoveryContext): Promise<DiscoveryOutcome> {
  const { dependencies, sourceUrl, catalogMatch, reportProgress, signal } = context
  const catalogUrl = preferredCatalogProbeUrl(catalogMatch, sourceUrl)
  const catalogController = catalogUrl ? new AbortController() : null
  const catalog = catalogUrl ? trackOutcome(() => withAbortTimeout((stageSignal) =>
    dependencies.rssDiscovery.discover(catalogUrl, AbortSignal.any([stageSignal, catalogController!.signal])),
    { timeoutMs: RSS_PROBE_TIMEOUT_MS, message: '目录 Feed 探测超时', externalSignal: signal })) : null
  try {
    const outcome = await runStage(() => withAbortTimeout((stageSignal) =>
      dependencies.rssDiscovery.discover(sourceUrl, stageSignal),
      { timeoutMs: RSS_PROBE_TIMEOUT_MS, message: 'RSS 探测超时', externalSignal: signal }),
      { stage: 'rss', report: reportProgress, signal })
    const feed = outcome.value ?? (catalog?.settled ? catalog.value : null)
    return feed ? {
      candidates: [rssCandidate(feed)], payloads: [{ type: 'rss', discovered: feed }], error: null
    } : { candidates: [], payloads: [], error: outcome.error }
  } finally {
    catalogController?.abort()
  }
}

/** 远端账户仅支持服务端可接收的 RSS；本地 JSON 传递同一取消信号。 */
async function probeJson(context: DiscoveryContext): Promise<DiscoveryOutcome> {
  if (!context.isLocalAccount) return { candidates: [], payloads: [], error: null }
  const { dependencies, sourceUrl, reportProgress, signal } = context
  const outcome = await runStage(() => dependencies.jsonSource.probe(sourceUrl, signal),
    { stage: 'json', report: reportProgress, signal })
  return outcome.value ? {
    candidates: [jsonCandidate(outcome.value)], payloads: [{ type: 'json', probe: outcome.value }], error: null
  } : { candidates: [], payloads: [], error: outcome.error }
}
