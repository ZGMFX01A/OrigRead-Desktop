import * as cheerio from 'cheerio'

export interface ContentQualityMetrics {
  score: number
  textLength: number
  paragraphCount: number
  imageCount: number
  linkDensity: number
  textDensity: number
  duplicateParagraphRatio: number
  adKeywordHits: number
  titleMatched: boolean
}

const MIN_TEXT_LENGTH = 80
const MIN_PARAGRAPH_LENGTH = 20
const AD_KEYWORDS = [
  '广告', '推广', '赞助', '相关推荐', '相关阅读',
  'advertisement', 'sponsored', 'affiliate'
]

export function scoreContentCandidate(
  html: string,
  expectedTitle: string | null = null,
  extractedTitle: string | null = null
): number {
  return evaluateContentCandidate(html, expectedTitle, extractedTitle).score
}

export function evaluateContentCandidate(
  html: string,
  expectedTitle: string | null = null,
  extractedTitle: string | null = null
): ContentQualityMetrics {
  const $ = cheerio.load(`<body>${html}</body>`)
  const body = $('body')
  const text = normalizeWhitespace(body.text())
  const textLength = text.length
  if (textLength < MIN_TEXT_LENGTH) return emptyMetrics(textLength)

  const paragraphTexts = body.find('p').toArray()
    .map((element) => normalizeWhitespace($(element).text()))
    .filter((value) => value.length >= MIN_PARAGRAPH_LENGTH)
  const paragraphs = paragraphTexts.length
  const headings = body.find('h1, h2, h3').toArray().filter((element) => normalizeWhitespace($(element).text()).length > 0).length
  const images = body.find('img[src]').length
  const linkTextLength = body.find('a').toArray().reduce((sum, element) => sum + normalizeWhitespace($(element).text()).length, 0)
  const linkDensity = linkTextLength / Math.max(textLength, 1)
  const rawHtmlLength = Math.max(body.html()?.length ?? 0, 1)
  const textDensity = textLength / rawHtmlLength
  const duplicateParagraphRatio = calculateDuplicateRatio(paragraphTexts)
  const lowerText = text.toLocaleLowerCase()
  const adKeywordHits = AD_KEYWORDS.reduce((count, keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return count + (lowerText.match(new RegExp(escaped, 'giu'))?.length ?? 0)
  }, 0)
  const titleMatched = titleMatches(expectedTitle, extractedTitle)

  let score = 0
  score += Math.min(Math.floor(textLength / 120), 30)
  score += textDensity >= 0.5 ? 20 : textDensity >= 0.35 ? 16 : textDensity >= 0.2 ? 10 : 4
  score += Math.min(paragraphs * 4, 20)
  score += Math.min(headings * 2, 5)
  score += Math.min(images * 2, 8)
  if (titleMatched) score += 15
  if (linkDensity < 0.12) score += 8
  if (linkDensity > 0.35) score -= 15
  if (linkDensity > 0.55) score -= 20
  if (duplicateParagraphRatio >= 0.25) score -= Math.min(Math.trunc(duplicateParagraphRatio * 30), 15)
  score -= Math.min(adKeywordHits * 3, 12)
  if (paragraphs === 0 && textLength < 500) score -= 20

  return {
    score: clamp(score, 0, 100),
    textLength,
    paragraphCount: paragraphs,
    imageCount: images,
    linkDensity,
    textDensity,
    duplicateParagraphRatio,
    adKeywordHits,
    titleMatched
  }
}

function emptyMetrics(textLength: number): ContentQualityMetrics {
  return {
    score: 0,
    textLength,
    paragraphCount: 0,
    imageCount: 0,
    linkDensity: 0,
    textDensity: 0,
    duplicateParagraphRatio: 0,
    adKeywordHits: 0,
    titleMatched: false
  }
}

function calculateDuplicateRatio(paragraphs: string[]): number {
  if (paragraphs.length < 2) return 0
  const normalized = paragraphs.map((value) => value.replace(/\s+/g, '').toLocaleLowerCase())
  return (normalized.length - new Set(normalized).size) / normalized.length
}

function titleMatches(expectedTitle: string | null, extractedTitle: string | null): boolean {
  const expected = normalizeTitle(expectedTitle)
  const extracted = normalizeTitle(extractedTitle)
  if (!expected || !extracted) return false
  return expected === extracted || expected.includes(extracted) || extracted.includes(expected)
}

function normalizeTitle(value: string | null): string {
  return (value ?? '').toLocaleLowerCase().replace(/[\s\p{P}｜|_-]+/gu, '').trim()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
