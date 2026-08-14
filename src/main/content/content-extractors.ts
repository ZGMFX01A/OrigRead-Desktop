import { Readability } from '@mozilla/readability'
import * as cheerio from 'cheerio'
import JSON5 from 'json5'
import { parseHTML } from 'linkedom'
import type { WebsiteRule } from '../../shared/website'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import { scoreContentCandidate } from './content-candidate-scorer'
import type { ContentExtractionCandidate } from './content-extraction-types'

export interface ContentExtractor {
  extract(html: string, sourceUrl: string): ContentExtractionCandidate[]
}

export class WeChatArticleContentExtractor implements ContentExtractor {
  extract(html: string, sourceUrl: string): ContentExtractionCandidate[] {
    if (!isWeChatArticleUrl(sourceUrl)) return []
    const $ = cheerio.load(html)
    const content = $('#js_content').first()
    if (!normalizeText(content.text())) return []
    const body = $.html(content)
    return [{
      source: 'PLATFORM_SPECIFIC',
      html: body,
      title: firstNonBlank($('#activity-name').first().text(), $('meta[property="og:title"]').attr('content')),
      author: firstNonBlank($('#js_name').first().text(), $('meta[name="author"]').attr('content')),
      publishedTime: null,
      score: scoreContentCandidate(body) + 10
    }]
  }
}

export class WebsiteRuleContentExtractor implements ContentExtractor {
  constructor(private readonly ruleProvider: (url: string) => WebsiteRule[]) {}

  static fromRepository(repository: WebsiteRuleRepository): WebsiteRuleContentExtractor {
    return new WebsiteRuleContentExtractor((url) => repository.findRules(url))
  }

  extract(html: string, sourceUrl: string): ContentExtractionCandidate[] {
    const $ = cheerio.load(html)
    return this.ruleProvider(sourceUrl)
      .filter((rule) => rule.contentSelectors.length > 0)
      .flatMap((rule) => {
        const selector = rule.contentSelectors.find((value) => normalizeText($(value).first().text()).length > 0)
        if (!selector) return []
        const element = $(selector).first()
        const body = $.html(element)
        return [{
          source: 'WEBSITE_RULE' as const,
          html: body,
          title: null,
          author: null,
          publishedTime: null,
          score: scoreContentCandidate(body)
        }]
      })
  }
}

export class StructuredMetadataContentExtractor implements ContentExtractor {
  extract(html: string): ContentExtractionCandidate[] {
    const $ = cheerio.load(html)
    const candidates: ContentExtractionCandidate[] = []
    $('script[type="application/ld+json"]').each((_, element) => {
      const raw = ($(element).text() || $(element).html() || '').trim()
      if (!raw) return
      let root: unknown
      try { root = JSON5.parse(raw) } catch { return }
      for (const node of findObjects(root)) {
        const articleBody = stringValue(node.articleBody)?.trim() ?? ''
        if (articleBody.length < 80) continue
        const body = textToParagraphs(articleBody)
        candidates.push({
          source: 'STRUCTURED_DATA',
          html: body,
          title: stringValue(node.headline) ?? stringValue(node.name),
          author: extractAuthor(node.author),
          publishedTime: stringValue(node.datePublished),
          score: scoreContentCandidate(body) + 20
        })
      }
    })

    const description = firstNonBlank(
      $('meta[property="og:description"]').attr('content'),
      $('meta[name="description"]').attr('content')
    )
    if ((description?.length ?? 0) >= 80) {
      const body = textToParagraphs(description!)
      candidates.push({
        source: 'META_DESCRIPTION',
        html: body,
        title: firstNonBlank($('meta[property="og:title"]').attr('content')),
        author: null,
        publishedTime: null,
        score: scoreContentCandidate(body)
      })
    }
    return candidates
  }
}

export class ReadabilityContentExtractor implements ContentExtractor {
  extract(html: string): ContentExtractionCandidate[] {
    try {
      const { document } = parseHTML(html)
      const result = new Readability(document).parse()
      const body = result?.content?.trim() ?? ''
      if (!body) return []
      return [{
        source: 'READABILITY',
        html: body,
        title: null,
        author: null,
        publishedTime: null,
        score: scoreContentCandidate(body)
      }]
    } catch {
      return []
    }
  }
}

function isWeChatArticleUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase()
    return host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com')
  } catch {
    return false
  }
}

function* findObjects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const child of value) yield* findObjects(child)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  yield record
  for (const child of Object.values(record)) yield* findObjects(child)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null
}

function extractAuthor(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const names = value.map(extractAuthor).filter((item): item is string => Boolean(item))
    return names.length > 0 ? names.join(', ') : null
  }
  if (value && typeof value === 'object') return stringValue((value as Record<string, unknown>).name)
  return null
}

function textToParagraphs(value: string): string {
  return value.split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? null
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
