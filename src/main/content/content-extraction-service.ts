import * as cheerio from 'cheerio'
import { sanitizeContentHtml } from './content-html-sanitizer'
import { scoreContentCandidate } from './content-candidate-scorer'
import { CONTENT_SOURCE_PRIORITY, type ContentExtractionCandidate, type ExtractedContent } from './content-extraction-types'
import type { ContentExtractor } from './content-extractors'

const MIN_ACCEPTED_SCORE = 20
const MAX_SOURCE_BONUS = 15

/** 对齐 Android ContentExtractionService：所有 extractor 只生产候选，统一清洗、重评分、排序。 */
export class ContentExtractionService {
  constructor(private readonly extractors: ContentExtractor[]) {}

  extract(html: string, sourceUrl: string, expectedTitle: string | null = null): ExtractedContent | null {
    const metadata = extractPageMetadata(html)
    const candidates = this.extractors.flatMap((extractor) => {
      try { return extractor.extract(html, sourceUrl) } catch { return [] }
    })
    const normalized = candidates
      .map((candidate) => normalizeCandidate(candidate, sourceUrl, expectedTitle, metadata))
      .filter((candidate): candidate is ExtractedContent => candidate !== null && candidate.score >= MIN_ACCEPTED_SCORE)

    normalized.sort((left, right) => {
      const leftRule = left.source === 'WEBSITE_RULE' ? 1 : 0
      const rightRule = right.source === 'WEBSITE_RULE' ? 1 : 0
      return rightRule - leftRule || right.score - left.score || CONTENT_SOURCE_PRIORITY[right.source] - CONTENT_SOURCE_PRIORITY[left.source]
    })
    return normalized[0] ?? null
  }
}

interface PageMetadata {
  title: string | null
  author: string | null
  publishedTime: string | null
}

function normalizeCandidate(
  candidate: ContentExtractionCandidate,
  sourceUrl: string,
  expectedTitle: string | null,
  pageMetadata: PageMetadata
): ExtractedContent | null {
  const sanitized = sanitizeContentHtml(candidate.html, sourceUrl)
  if (!sanitized.trim()) return null
  const $ = cheerio.load(`<body>${sanitized}</body>`)
  if (expectedTitle?.trim()) {
    const heading = $('body').find('h1').first()
    if (normalizeText(heading.text()).toLocaleLowerCase() === expectedTitle.trim().toLocaleLowerCase()) heading.remove()
  }
  const normalizedHtml = $('body').html()?.trim() ?? ''
  if (!normalizedHtml) return null
  const originalContentScore = scoreContentCandidate(candidate.html)
  const sourceBonus = clamp(candidate.score - originalContentScore, 0, MAX_SOURCE_BONUS)
  const title = candidate.title ?? pageMetadata.title
  const score = Math.min(scoreContentCandidate(normalizedHtml, expectedTitle, title) + sourceBonus, 100)
  return {
    source: candidate.source,
    html: normalizedHtml,
    title,
    author: candidate.author ?? pageMetadata.author,
    publishedTime: candidate.publishedTime ?? pageMetadata.publishedTime,
    score
  }
}

function extractPageMetadata(html: string): PageMetadata {
  const $ = cheerio.load(html)
  return {
    title: firstNonBlank(
      $('meta[property="og:title"]').attr('content'),
      $('meta[name="twitter:title"]').attr('content'),
      $('title').first().text()
    ),
    author: firstNonBlank(
      $('meta[name="author"]').attr('content'),
      $('meta[property="article:author"]').attr('content'),
      $('[rel="author"]').first().text()
    ),
    publishedTime: firstNonBlank(
      $('meta[property="article:published_time"]').attr('content'),
      $('meta[name="date"]').attr('content'),
      $('time[datetime]').first().attr('datetime')
    )
  }
}

function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? null
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
