import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { isValid, parse as parseWithFormat } from 'date-fns'
import type { WebsiteParsedArticle, WebsiteRule } from '../../../shared/website'
import { normalizeArticleUrlPattern } from './article-url-pattern-normalizer'
import { AutomaticArticleDateExtractor } from './automatic-article-date-extractor'
import { compileAndroidRegex, resolveElementAttribute, selectFirstWithin } from './website-dom'

export class ConfigurableWebsiteParser {
  constructor(private readonly rule: WebsiteRule) {}

  parse($: cheerio.CheerioAPI, baseUrl: string, sourceUrl: string, fetchedAt: number): WebsiteParsedArticle[] {
    let items: Element[] | null = null
    for (const selector of this.rule.articleSelectors) {
      const matched = $(selector).toArray().filter((node): node is Element => 'name' in node)
      if (matched.length > 0) {
        items = matched
        break
      }
    }
    if (!items) throw new Error(`规则 ${this.rule.name} 未匹配到文章节点`)

    const includeUrl = this.rule.includeUrlRegex ? compileAndroidRegex(this.rule.includeUrlRegex) : null
    const excludeTitles = this.rule.excludeTitleRegexes.map(compileAndroidRegex)
    const automaticDateExtractor = this.rule.automaticDateExtraction
      ? AutomaticArticleDateExtractor.create($, baseUrl, fetchedAt)
      : null
    let sourceHost = ''
    try { sourceHost = new URL(sourceUrl).hostname } catch { /* invalid source handled by filters */ }
    const seenLinks = new Set<string>()
    const articles: WebsiteParsedArticle[] = []

    for (const item of items) {
      const article = this.buildArticle($, item, baseUrl, fetchedAt, automaticDateExtractor)
      if (!article) continue
      if (includeUrl && !fullRegexMatch(includeUrl, article.link)) continue
      if (this.rule.automaticUrlPattern && normalizeArticleUrlPattern(article.link, sourceHost)?.key !== this.rule.automaticUrlPattern) continue
      if (excludeTitles.some((regex) => fullRegexMatch(regex, article.title))) continue
      if (seenLinks.has(article.link)) continue
      seenLinks.add(article.link)
      articles.push(article)
      if (articles.length >= this.rule.maxItems) break
    }
    if (articles.length === 0) throw new Error(`规则 ${this.rule.name} 未解析出有效文章`)
    return articles
  }

  findObsoleteArticleIds(
    existing: Array<{ id: string; url: string | null; isStarred: boolean }>,
    fetched: WebsiteParsedArticle[]
  ): string[] {
    if (this.rule.cleanupMode !== 'URL_ID_RANGE' || !this.rule.urlIdRegex) return []
    const regex = compileAndroidRegex(this.rule.urlIdRegex)
    const fetchedIds = fetched.map((article) => firstCaptureNumber(regex, article.link)).filter((value): value is number => value !== null)
    if (fetchedIds.length === 0) return []
    const oldestFetchedId = Math.min(...fetchedIds)
    const fetchedLinks = new Set(fetched.map((article) => article.link))
    return existing.filter((article) => {
      if (article.isStarred || !article.url) return false
      const id = firstCaptureNumber(regex, article.url)
      return id !== null && id >= oldestFetchedId && !fetchedLinks.has(article.url)
    }).map((article) => article.id)
  }

  private buildArticle(
    $: cheerio.CheerioAPI,
    item: Element,
    baseUrl: string,
    fetchedAt: number,
    automaticDateExtractor: AutomaticArticleDateExtractor | null
  ): WebsiteParsedArticle | null {
    const titleElement = selectFirstWithin($, item, this.rule.titleSelector)
    const linkElement = selectFirstWithin($, item, this.rule.linkSelector)
    if (!titleElement || !linkElement) return null
    const title = $(titleElement).text().trim()
    if (!title) return null
    const link = resolveElementAttribute($, linkElement, this.rule.linkAttribute, baseUrl)
    if (!link) return null
    let imageUrl: string | null = null
    if (this.rule.imageSelector) {
      const imageElement = selectFirstWithin($, item, this.rule.imageSelector)
      if (imageElement) {
        for (const attribute of this.rule.imageAttributes) {
          imageUrl = resolveElementAttribute($, imageElement, attribute, baseUrl)
          if (imageUrl) break
        }
      }
    }
    return {
      stableId: link,
      title,
      link,
      author: null,
      publishedAt: automaticDateExtractor?.extract(item, link) ?? this.parseDate($, item, fetchedAt),
      descriptionHtml: '',
      imageUrl
    }
  }

  private parseDate($: cheerio.CheerioAPI, item: Element, fetchedAt: number): number {
    for (const dateRule of this.rule.dateRules) {
      const element = selectFirstWithin($, item, dateRule.selector)
      const text = element ? $(element).text().trim() : ''
      if (!text) continue
      try {
        const parsed = parseWithFormat(text, dateRule.pattern, new Date(fetchedAt))
        if (!isValid(parsed)) continue
        const source = parsed
        const target = new Date(fetchedAt)
        if (dateRule.pattern === 'HH:mm') {
          target.setHours(source.getHours(), source.getMinutes(), 0, 0)
          return target.getTime()
        }
        if (dateRule.pattern === 'MM-dd') {
          target.setMonth(source.getMonth(), source.getDate())
          target.setHours(0, 0, 0, 0)
          return target.getTime()
        }
        source.setSeconds(0, 0)
        return source.getTime()
      } catch { /* try next rule */ }
    }
    return fetchedAt
  }
}

function fullRegexMatch(regex: RegExp, value: string): boolean {
  const match = regex.exec(value)
  regex.lastIndex = 0
  return match !== null && match.index === 0 && match[0].length === value.length
}

function firstCaptureNumber(regex: RegExp, value: string): number | null {
  const match = regex.exec(value)
  regex.lastIndex = 0
  if (!match?.[1]) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
}

