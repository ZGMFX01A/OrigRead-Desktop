import type { WebsiteParsedArticle, WebsiteParseDiagnostics } from '../../../shared/website'

const MIN_ACCEPTED_RATE = 0.6
const MIN_UNIQUE_RATE = 0.5
const NORMAL_ITEM_MIN = 10
const NORMAL_ITEM_MAX = 100
const NAVIGATION_TITLES = new Set(['首页', '登录', '注册', '更多', '下载', '关于我们', '联系我们', 'home', 'login', 'more'])

export function scoreWebsiteCandidate(articles: WebsiteParsedArticle[], fetchedAt: number): WebsiteParseDiagnostics {
  if (articles.length === 0) return rejectedWebsiteCandidate('未解析出文章')
  const count = articles.length
  const validTitleRate = rate(articles.filter(hasValidTitle).length, count)
  const validLinkRate = rate(articles.filter(hasValidLink).length, count)
  const uniqueLinkRate = rate(new Set(articles.map((article) => article.link)).size, count)
  const parsedDateRate = rate(articles.filter((article) => article.publishedAt !== fetchedAt).length, count)
  const chronologicalRate = calculateChronologicalRate(articles)
  const reasons: string[] = []
  if (validTitleRate < MIN_ACCEPTED_RATE) reasons.push('有效标题比例过低')
  if (validLinkRate < MIN_ACCEPTED_RATE) reasons.push('有效链接比例过低')
  if (uniqueLinkRate < MIN_UNIQUE_RATE) reasons.push('重复链接比例过高')
  const accepted = reasons.length === 0
  const countScore = count >= NORMAL_ITEM_MIN && count <= NORMAL_ITEM_MAX ? 20 : 10
  const score = accepted
    ? Math.max(0, Math.min(100, Math.trunc(
      countScore + validTitleRate * 25 + validLinkRate * 20 + uniqueLinkRate * 20 + parsedDateRate * 5 + chronologicalRate * 10
    )))
    : 0
  return {
    score,
    linkQualityScore: 0,
    regionScore: 0,
    historyScore: 0,
    state: accepted ? 'AVAILABLE' : 'INVALID_CONTENT',
    articleCount: count,
    validTitleRate,
    validLinkRate,
    uniqueLinkRate,
    parsedDateRate,
    chronologicalRate,
    reasons
  }
}

export function rejectedWebsiteCandidate(reason: string, state: WebsiteParseDiagnostics['state'] = 'INVALID_CONTENT'): WebsiteParseDiagnostics {
  return {
    score: 0,
    linkQualityScore: 0,
    regionScore: 0,
    historyScore: 0,
    state,
    articleCount: 0,
    validTitleRate: 0,
    validLinkRate: 0,
    uniqueLinkRate: 0,
    parsedDateRate: 0,
    chronologicalRate: 0,
    reasons: [reason]
  }
}

export function rankingScore(diagnostics: WebsiteParseDiagnostics): number {
  return diagnostics.score + diagnostics.linkQualityScore + diagnostics.regionScore + diagnostics.historyScore
}

export function isSafeDynamicFallback(diagnostics: WebsiteParseDiagnostics): boolean {
  return diagnostics.articleCount > 0
    && diagnostics.validLinkRate > 0
    && diagnostics.uniqueLinkRate > 0
}

function hasValidTitle(article: WebsiteParsedArticle): boolean {
  const title = article.title.trim()
  return title.length >= 4 && title.length <= 200 && !NAVIGATION_TITLES.has(title.toLowerCase())
}

function hasValidLink(article: WebsiteParsedArticle): boolean {
  try {
    const url = new URL(article.link)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

function calculateChronologicalRate(articles: WebsiteParsedArticle[]): number {
  if (articles.length < 2) return 1
  let orderedPairs = 0
  for (let index = 0; index < articles.length - 1; index += 1) {
    if (articles[index]!.publishedAt >= articles[index + 1]!.publishedAt) orderedPairs += 1
  }
  return rate(orderedPairs, articles.length - 1)
}

function rate(value: number, total: number): number {
  return total <= 0 ? 0 : value / total
}

