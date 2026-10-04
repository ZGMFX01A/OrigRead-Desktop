import * as cheerio from 'cheerio'
import { isValid, parse as parseDateWithFormat } from 'date-fns'
import JSON5 from 'json5'
import type { JsonParsedArticle, JsonRule } from '../../../shared/json-source'
import { firstJsonPath, queryJsonPath, type JsonValue } from './simple-json-path'

// Unix 秒时间戳转毫秒；十位数以内沿用既有秒单位识别方式。
const MILLISECONDS_PER_SECOND = 1000
const UNIX_SECONDS_BOUNDARY = 10_000_000_000

export class JsonArticleParser {
  /** 根据确认的 JSONPath 解析文章，按链接去重并保留规则的既有条数限制。 */
  parse(
    content: string,
    rule: JsonRule,
    options: { baseUrl: string; fetchedAt?: number }
  ): JsonParsedArticle[] {
    const { baseUrl, fetchedAt = Date.now() } = options
    const root = JSON5.parse(content) as JsonValue
    const seenLinks = new Set<string>()
    const articles: JsonParsedArticle[] = []

    for (const item of queryJsonPath(root, rule.itemsPath)) {
      const article = this.buildArticle(item, rule, { baseUrl, fetchedAt })
      if (!article || seenLinks.has(article.link)) continue
      seenLinks.add(article.link)
      articles.push(article)
      if (articles.length >= rule.maxItems) break
    }

    if (articles.length === 0) throw new Error(`规则 ${rule.name} 未解析出有效文章`)
    return articles
  }

  /** 无效标题或链接不生成文章，其余字段按同一条已确认规则读取。 */
  private buildArticle(
    item: JsonValue,
    rule: JsonRule,
    options: { baseUrl: string; fetchedAt: number }
  ): JsonParsedArticle | null {
    const { baseUrl, fetchedAt } = options
    const identity = articleIdentity(item, rule, baseUrl)
    if (!identity) return null
    return {
      ...identity,
      ...articleBody(item, rule, baseUrl),
      author: nullIfBlank(toPlainText(stringValue(item, rule.authorPath) ?? '')),
      publishedAt: parseArticleDate(firstJsonPath(item, rule.datePath), rule, fetchedAt)
    }
  }
}

/** 标题和 HTTP 链接是有效文章的必要字段，规则 ID 优先作为稳定身份。 */
function articleIdentity(item: JsonValue, rule: JsonRule, baseUrl: string): Pick<JsonParsedArticle, 'title' | 'link' | 'stableId'> | null {
  const title = toPlainText(stringValue(item, rule.titlePath) ?? '').trim()
  if (!title) return null
  const linkValue = stringValue(item, rule.linkPath)?.trim()
  if (!linkValue) return null
  const link = resolveHttpUrl(baseUrl, linkValue)
  if (!link) return null
  return { title, link, stableId: stringValue(item, rule.idPath)?.trim() || link }
}

/** 正文和摘要分别保存，图片相对地址以真实接口地址解析。 */
function articleBody(item: JsonValue, rule: JsonRule, baseUrl: string): Pick<JsonParsedArticle, 'descriptionHtml' | 'contentHtml' | 'imageUrl'> {
  const descriptionHtml = stringValue(item, rule.descriptionPath) ?? ''
  const contentHtml = stringValue(item, rule.contentPath ?? null) ?? ''
  const imageValue = stringValue(item, rule.imagePath)
  return {
    descriptionHtml: descriptionHtml || contentHtml,
    contentHtml: contentHtml || null,
    imageUrl: imageValue ? resolveHttpUrl(baseUrl, imageValue) : null
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

/** 规则提供 UTC 语义时附加真实时区标记，不能用运行机器的本地时区解释 date_gmt。 */
function parseArticleDate(value: JsonValue | null, rule: JsonRule, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < UNIX_SECONDS_BOUNDARY ? value * MILLISECONDS_PER_SECOND : value
  }
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text) return fallback

  const formats = [
    ...(rule.dateFormat ? [rule.dateFormat] : []),
    "yyyy-MM-dd'T'HH:mm:ssXXX",
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd'
  ]
  for (const candidate of formats) {
    const timestamp = formattedDate(text, { format: candidate, timezone: rule.dateTimeZone, reference: fallback })
    if (timestamp !== null) return timestamp
  }
  return fallback
}

/** UTC 规则只给无时区格式补标记，带偏移的格式按原始数据解析。 */
function formattedDate(text: string, options: { format: string; timezone: JsonRule['dateTimeZone']; reference: number }): number | null {
  try {
    const utc = options.timezone === 'UTC' && !/[xXOz]/.test(options.format)
    const parsed = parseDateWithFormat(utc ? `${text}Z` : text, utc ? `${options.format}XXX` : options.format, new Date(options.reference))
    return isValid(parsed) ? parsed.getTime() : null
  } catch {
    // 保留既有逐格式匹配策略，某个日期格式无效时继续尝试其余声明格式。
    return null
  }
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
