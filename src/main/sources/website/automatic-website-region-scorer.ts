import type * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { ancestorElements, classNames, previousElementSibling, tagName } from './website-dom'

export interface WebsiteRegionScore {
  adjustment: number
  signals: string[]
}

const POSITIVE_KEYWORDS = new Set(['main', 'primary', 'latest', 'recent', 'newest', 'updates', 'news', 'feed', 'stream', 'article-list', 'articles', 'post-list', 'posts', 'content-list', 'main-content', '最新', '最近', '新闻', '资讯', '动态', '文章列表'])
const NEGATIVE_KEYWORDS = new Set(['aside', 'sidebar', 'side-bar', 'secondary', 'widget', 'popular', 'hot', 'trending', 'recommend', 'recommended', 'recommendation', 'related', 'ranking', 'rank', 'top-list', 'toplist', 'most-read', 'most-viewed', 'suggested', '侧栏', '热门', '热榜', '排行', '榜单', '推荐', '相关', '猜你喜欢', '阅读排行', '点击排行'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4'])

export function scoreAutomaticWebsiteRegion($: cheerio.CheerioAPI, container: Element): WebsiteRegionScore {
  const context = [container, ...ancestorElements($, container, 4)]
  const signals: string[] = []
  let adjustment = 0
  if (context.some((element) => tagName(element) === 'main' || ($(element).attr('role') ?? '').toLowerCase() === 'main')) {
    adjustment += 22
    signals.push('main')
  }
  if (context.some((element) => tagName(element) === 'article')) {
    adjustment += 6
    signals.push('article')
  }
  if (context.some((element) => tagName(element) === 'aside' || ($(element).attr('role') ?? '').toLowerCase() === 'complementary')) {
    adjustment -= 35
    signals.push('aside')
  }

  const structuralValues = context.flatMap((element) => [
    $(element).attr('id') ?? '',
    ...classNames($, element),
    $(element).attr('role') ?? '',
    $(element).attr('aria-label') ?? '',
    $(element).attr('data-section') ?? '',
    $(element).attr('data-block') ?? '',
    $(element).attr('data-widget') ?? ''
  ].filter(Boolean))
  const headingValues = context.map((element) => findShortSectionHeading($, element)).filter((value): value is string => Boolean(value))
  const positiveStructuralHits = countKeywordHits(structuralValues, POSITIVE_KEYWORDS)
  if (positiveStructuralHits > 0) {
    adjustment += Math.min(21, positiveStructuralHits * 7)
    signals.push(`positive-structure:${positiveStructuralHits}`)
  }
  const negativeStructuralHits = countKeywordHits(structuralValues, NEGATIVE_KEYWORDS)
  if (negativeStructuralHits > 0) {
    adjustment -= Math.min(42, negativeStructuralHits * 12)
    signals.push(`negative-structure:${negativeStructuralHits}`)
  }
  const positiveHeadingHits = countKeywordHits(headingValues, POSITIVE_KEYWORDS)
  if (positiveHeadingHits > 0) {
    adjustment += Math.min(16, positiveHeadingHits * 8)
    signals.push(`positive-heading:${positiveHeadingHits}`)
  }
  const negativeHeadingHits = countKeywordHits(headingValues, NEGATIVE_KEYWORDS)
  if (negativeHeadingHits > 0) {
    adjustment -= Math.min(32, negativeHeadingHits * 16)
    signals.push(`negative-heading:${negativeHeadingHits}`)
  }
  return { adjustment: Math.max(-60, Math.min(40, adjustment)), signals }
}

function findShortSectionHeading($: cheerio.CheerioAPI, element: Element): string | null {
  const direct = $(element).children().toArray().find((node) => 'name' in node && HEADING_TAGS.has((node as Element).name.toLowerCase())) as Element | undefined
  let previous = previousElementSibling($, element)
  while (previous && !HEADING_TAGS.has(tagName(previous))) previous = previousElementSibling($, previous)
  for (const candidate of [direct, previous]) {
    if (!candidate) continue
    const text = $(candidate).text().trim()
    if (text.length >= 2 && text.length <= 40) return text
  }
  return null
}

function countKeywordHits(values: string[], keywords: Set<string>): number {
  let count = 0
  for (const keyword of keywords) if (values.some((value) => matchesKeyword(value, keyword))) count += 1
  return count
}

function matchesKeyword(value: string, keyword: string): boolean {
  if ([...keyword].some((character) => character.codePointAt(0)! > 127)) return value.toLowerCase().includes(keyword.toLowerCase())
  const normalize = (input: string) => input.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return ` ${normalize(value)} `.includes(` ${normalize(keyword)} `)
}

