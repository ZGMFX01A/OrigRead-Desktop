import * as cheerio from 'cheerio'
import { isValid, parse as parseDateWithFormat } from 'date-fns'
import JSON5 from 'json5'
import type { JsonParsedArticle, JsonRule } from '../../../shared/json-source'
import { firstJsonPath, queryJsonPath, type JsonValue } from './simple-json-path'

export class JsonArticleParser {
  parse(
    content: string,
    rule: JsonRule,
    baseUrl: string,
    fetchedAt = Date.now()
  ): JsonParsedArticle[] {
    const root = JSON5.parse(content) as JsonValue
    const seenLinks = new Set<string>()
    const articles: JsonParsedArticle[] = []

    for (const item of queryJsonPath(root, rule.itemsPath)) {
      const article = this.buildArticle(item, rule, baseUrl, fetchedAt)
      if (!article || seenLinks.has(article.link)) continue
      seenLinks.add(article.link)
      articles.push(article)
      if (articles.length >= rule.maxItems) break
    }

    if (articles.length === 0) throw new Error(`规则 ${rule.name} 未解析出有效文章`)
    return articles
  }

  private buildArticle(
    item: JsonValue,
    rule: JsonRule,
    baseUrl: string,
    fetchedAt: number
  ): JsonParsedArticle | null {
    const title = toPlainText(stringValue(item, rule.titlePath) ?? '').trim()
    if (!title) return null
    const linkValue = stringValue(item, rule.linkPath)?.trim()
    if (!linkValue) return null
    const link = resolveHttpUrl(baseUrl, linkValue)
    if (!link) return null
    const descriptionHtml = stringValue(item, rule.descriptionPath) ?? ''
    const contentHtml = stringValue(item, rule.contentPath ?? null) ?? ''
    const imageValue = stringValue(item, rule.imagePath)
    const imageUrl = imageValue ? resolveHttpUrl(baseUrl, imageValue) : null
    const stableId = stringValue(item, rule.idPath)?.trim() || link

    return {
      stableId,
      title,
      link,
      author: nullIfBlank(toPlainText(stringValue(item, rule.authorPath) ?? '')),
      publishedAt: parseArticleDate(firstJsonPath(item, rule.datePath), rule.dateFormat, fetchedAt),
      descriptionHtml: descriptionHtml || contentHtml,
      contentHtml: contentHtml || null,
      imageUrl
    }
  }
}

function stringValue(root: JsonValue, path: string | null): string | null {
  const value = firstJsonPath(root, path)
  if (value === null || typeof value === 'object') return null
  return String(value)
}

function toPlainText(value: string): string {
  if (!value) return ''
  return cheerio.load(`<body>${value}</body>`)('body').text().trim()
}

function parseArticleDate(value: JsonValue | null, format: string | null, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text) return fallback

  const formats = [
    ...(format ? [format] : []),
    "yyyy-MM-dd'T'HH:mm:ssXXX",
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd'
  ]
  for (const candidate of formats) {
    try {
      const parsed = parseDateWithFormat(text, candidate, new Date(fallback))
      if (isValid(parsed)) return parsed.getTime()
    } catch {
      // 与 Android SimpleDateFormat 的逐格式 runCatching 相同，失败后继续下一个格式。
    }
  }
  return fallback
}

function resolveHttpUrl(baseUrl: string, value: string): string | null {
  try {
    const resolved = new URL(value.trim(), baseUrl)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null
  } catch {
    return null
  }
}

function nullIfBlank(value: string): string | null {
  const normalized = value.trim()
  return normalized || null
}
