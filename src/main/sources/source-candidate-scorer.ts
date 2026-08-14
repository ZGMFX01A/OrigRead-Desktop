import type {
  SourceCandidateDiagnostics,
  SourceCandidateKind,
  SourceCandidateSummary
} from '../../shared/source-discovery'

export interface SourceCandidateEntry {
  title: string
  link: string
  publishedAt: number | null
}

export interface UnscoredSourceCandidate {
  title: string
  feedLink: string
  sourceType: SourceCandidateSummary['sourceType']
  kind: SourceCandidateKind
  entries: SourceCandidateEntry[]
  sourceNotice?: string | null
  browser?: boolean
  dynamicRendering?: boolean
}

const NAVIGATION_TITLES = new Set(['首页', '登录', '注册', '更多', '下载', '关于我们', 'home', 'login', 'more'])

/** Android SourceCandidateScorer 的确定性移植。 */
export function scoreSourceCandidate(entries: SourceCandidateEntry[], kind: SourceCandidateKind): SourceCandidateDiagnostics {
  if (entries.length === 0) return rejected('未获取到文章')
  const count = entries.length
  const validTitleRate = rate(entries.filter((entry) => {
    const title = entry.title.trim()
    return title.length >= 2 && !NAVIGATION_TITLES.has(title.toLowerCase())
  }).length, count)
  const validLinkRate = rate(entries.filter((entry) => /^https?:\/\//.test(entry.link.trim())).length, count)
  const uniqueLinkRate = rate(new Set(entries.map((entry) => entry.link.trim()).filter(Boolean)).size, count)
  const parsedDateRate = rate(entries.filter((entry) => entry.publishedAt !== null).length, count)
  const reasons: string[] = []
  if (validTitleRate < 0.6) reasons.push('有效标题比例过低')
  if (validLinkRate < 0.6) reasons.push('有效链接比例过低')
  if (uniqueLinkRate < 0.5) reasons.push('重复链接比例过高')
  if (reasons.length > 0) {
    return { score: 0, accepted: false, articleCount: count, validTitleRate, validLinkRate, uniqueLinkRate, parsedDateRate, reasons }
  }
  const countScore = count >= 10 && count <= 100 ? 20 : count >= 3 && count <= 200 ? 14 : 8
  const contentScore = Math.max(0, Math.min(80, Math.trunc(
    countScore + validTitleRate * 20 + validLinkRate * 18 + uniqueLinkRate * 17 + parsedDateRate * 5
  )))
  return {
    score: Math.max(0, Math.min(100, contentScore + sourceBonus(kind))),
    accepted: true,
    articleCount: count,
    validTitleRate,
    validLinkRate,
    uniqueLinkRate,
    parsedDateRate,
    reasons: []
  }
}

/** Android SubscribeCandidateSelector：先评分排序，再按 sourceType+feedLink 去重。 */
export function rankSourceCandidates(candidates: UnscoredSourceCandidate[]): SourceCandidateSummary[] {
  const scored = candidates
    .map((candidate) => ({ candidate, diagnostics: scoreSourceCandidate(candidate.entries, candidate.kind) }))
    .filter(({ diagnostics }) => diagnostics.accepted)
    .map(({ candidate, diagnostics }): SourceCandidateSummary => ({
      id: `${candidate.sourceType.toUpperCase()}:${candidate.feedLink.trim()}`,
      title: candidate.title,
      feedLink: candidate.feedLink,
      sourceType: candidate.sourceType,
      kind: candidate.kind,
      diagnostics,
      sourceNotice: candidate.sourceNotice ?? null,
      browser: candidate.browser ?? false,
      dynamicRendering: candidate.dynamicRendering ?? false
    }))
    .sort((left, right) => right.diagnostics.score - left.diagnostics.score || right.diagnostics.articleCount - left.diagnostics.articleCount)
  const distinct = new Map<string, SourceCandidateSummary>()
  for (const candidate of scored) if (!distinct.has(candidate.id)) distinct.set(candidate.id, candidate)
  return [...distinct.values()]
}

function sourceBonus(kind: SourceCandidateKind): number {
  switch (kind) {
    case 'RSS_DIRECT': return 20
    case 'RSS_DISCOVERED': return 17
    case 'JSON': return 14
    case 'RSSHUB': return 10
    case 'WEBSITE': return 6
    case 'WEBSITE_DYNAMIC': return 4
  }
}

function rejected(reason: string): SourceCandidateDiagnostics {
  return { score: 0, accepted: false, articleCount: 0, validTitleRate: 0, validLinkRate: 0, uniqueLinkRate: 0, parsedDateRate: 0, reasons: [reason] }
}

function rate(value: number, total: number): number { return total <= 0 ? 0 : value / total }

