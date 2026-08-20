import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import JSON5 from 'json5'
import { isValid, parse as parseWithFormat } from 'date-fns'
import { resolveHttpUrl, selectWithin } from './website-dom'

const MAX_FUTURE_TIME_MS = 2 * 24 * 60 * 60 * 1000

export class AutomaticArticleDateExtractor {
  private constructor(
    private readonly $: cheerio.CheerioAPI,
    private readonly baseUrl: string,
    private readonly fetchedAt: number,
    private readonly jsonLdDatesByUrl: Map<string, number>
  ) {}

  static create($: cheerio.CheerioAPI, baseUrl: string, fetchedAt: number): AutomaticArticleDateExtractor {
    const temporary = new AutomaticArticleDateExtractor($, baseUrl, fetchedAt, new Map())
    return new AutomaticArticleDateExtractor($, baseUrl, fetchedAt, temporary.collectJsonLdDates())
  }

  extract(item: Element, articleUrl: string): number {
    return this.extractMetaDate(item)
      ?? this.jsonLdDatesByUrl.get(normalizeUrl(articleUrl))
      ?? this.extractDateAttributes(item)
      ?? this.extractNearbyTextDate(item)
      ?? this.extractUrlDate(articleUrl)
      ?? this.fetchedAt
  }

  private extractMetaDate(item: Element): number | null {
    const selector = 'meta[property="article:published_time"], meta[itemprop="datePublished"], meta[name="publishdate"], meta[name="date"]'
    for (const element of selectWithin(this.$, item, selector)) {
      const parsed = this.parseDateValue(this.$(element).attr('content')?.trim() ?? '')
      if (parsed !== null) return parsed
    }
    return null
  }

  private extractDateAttributes(item: Element): number | null {
    const selector = 'time, [datetime], [data-time], [data-date], [data-publish-time], [data-published], [data-timestamp]'
    for (const element of selectWithin(this.$, item, selector)) {
      const values = [
        this.$(element).attr('datetime'), this.$(element).attr('content'), this.$(element).attr('data-time'),
        this.$(element).attr('data-date'), this.$(element).attr('data-publish-time'), this.$(element).attr('data-published'),
        this.$(element).attr('data-timestamp'), this.$(element).text()
      ]
      for (const value of values) {
        const parsed = value ? this.parseDateValue(value.trim()) : null
        if (parsed !== null) return parsed
      }
    }
    return null
  }

  private extractNearbyTextDate(item: Element): number | null {
    const selector = '.age, .time, .date, .datetime, .publish-time, .published-time, .post-date, .article-date, [class*=time], [class*=date], [class*=publish], [id*=time], [id*=date], [id*=publish]'
    for (const element of selectWithin(this.$, item, selector).slice(0, 20)) {
      const parsed = this.parseDateFromText(this.$(element).text())
      if (parsed !== null) return parsed
    }
    const ownText = this.$(item).clone().children().remove().end().text()
    return this.parseDateFromText(ownText)
  }

  private parseDateFromText(raw: string): number | null {
    const text = raw.trim()
    if (!text) return null
    const relative = this.parseRelativeDate(text)
    if (relative !== null) return relative
    for (const regex of [ABSOLUTE_DATE_RE, CHINESE_DATE_RE, MONTH_DAY_RE, TIME_ONLY_RE]) {
      const matched = text.match(regex)?.[0]
      if (matched) {
        const parsed = this.parseDateValue(matched)
        if (parsed !== null) return parsed
      }
    }
    return null
  }

  private parseRelativeDate(text: string): number | null {
    const normalized = text.toLowerCase().replace(/\s+/g, '')
    if (normalized.includes('刚刚') || normalized.includes('刚才') || normalized === 'justnow') return this.fetchedAt
    const chinese = normalized.match(/(\d+)(秒|分钟|小时|天)前/)
    if (chinese) {
      const amount = Number(chinese[1])
      const multiplier = chinese[2] === '秒' ? 1000 : chinese[2] === '分钟' ? 60_000 : chinese[2] === '小时' ? 3_600_000 : 86_400_000
      return this.fetchedAt - amount * multiplier
    }
    const english = text.toLowerCase().match(/(\d+)\s*(second|seconds|sec|minute|minutes|min|hour|hours|day|days)\s+ago/)
    if (english) {
      const amount = Number(english[1])
      const unit = english[2]!
      const multiplier = unit.startsWith('sec') ? 1000 : unit.startsWith('min') ? 60_000 : unit.startsWith('hour') ? 3_600_000 : 86_400_000
      return this.fetchedAt - amount * multiplier
    }
    const offset = normalized.startsWith('今天') || normalized.startsWith('today') ? 0 : normalized.startsWith('昨天') || normalized.startsWith('yesterday') ? 1 : null
    if (offset === null) return null
    const reference = new Date(this.fetchedAt)
    const time = text.match(TIME_ONLY_RE)?.[0]
    const [hour, minute] = time ? time.split(':').map(Number) : [0, 0]
    const result = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - offset, hour ?? 0, minute ?? 0, 0, 0)
    return result.getTime()
  }

  private parseDateValue(raw: string): number | null {
    const value = raw.trim()
    if (!value) return null
    if (/^\d{10,13}$/.test(value)) {
      const numeric = Number(value)
      return this.validDate(value.length === 10 ? numeric * 1000 : numeric)
    }
    const iso = Date.parse(value)
    if (Number.isFinite(iso)) {
      const valid = this.validDate(iso)
      if (valid !== null) return valid
    }
    const formats = [
      'yyyy-M-d H:mm:ss', 'yyyy-M-d H:mm', 'yyyy/M/d H:mm:ss', 'yyyy/M/d H:mm',
      'yyyy年M月d日 H:mm:ss', 'yyyy年M月d日 H:mm', 'yyyy-M-d', 'yyyy/M/d', 'yyyy年M月d日'
    ]
    for (const format of formats) {
      try {
        const parsed = parseWithFormat(value, format, new Date(this.fetchedAt))
        if (isValid(parsed)) {
          const valid = this.validDate(parsed.getTime())
          if (valid !== null) return valid
        }
      } catch { /* try next format */ }
    }
    const monthDay = value.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
    if (monthDay) {
      const reference = new Date(this.fetchedAt)
      let candidate = new Date(reference.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]), Number(monthDay[3] ?? 0), Number(monthDay[4] ?? 0), 0, 0)
      if (candidate.getTime() > this.fetchedAt + 7 * 86_400_000) candidate = new Date(candidate.getFullYear() - 1, candidate.getMonth(), candidate.getDate(), candidate.getHours(), candidate.getMinutes())
      return this.validDate(candidate.getTime())
    }
    if (/^\d{1,2}:\d{2}$/.test(value)) {
      const [hour, minute] = value.split(':').map(Number)
      const reference = new Date(this.fetchedAt)
      let candidate = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate(), hour!, minute!, 0, 0)
      if (candidate.getTime() > this.fetchedAt + 5 * 60_000) candidate = new Date(candidate.getTime() - 86_400_000)
      return this.validDate(candidate.getTime())
    }
    return null
  }

  private extractUrlDate(articleUrl: string): number | null {
    let path = ''
    try { path = new URL(articleUrl).pathname } catch { return null }
    const match = path.match(/(?:^|\/)((?:19|20)\d{2})[/_-](\d{1,2})[/_-](\d{1,2})(?:\/|[-_.]|$)/)
      ?? path.match(/(?:^|\/)((?:19|20)\d{2})(\d{2})(\d{2})(?:\/|[-_.]|$)/)
    if (!match) return null
    const result = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime()
    return this.validDate(result)
  }

  private validDate(value: number): number | null {
    return Number.isFinite(value) && value <= this.fetchedAt + MAX_FUTURE_TIME_MS ? value : null
  }

  private collectJsonLdDates(): Map<string, number> {
    const dates = new Map<string, number>()
    this.$('script[type="application/ld+json"]').each((_, script) => {
      const raw = this.$(script).html()?.trim()
      if (!raw) return
      let root: unknown
      try { root = JSON5.parse(raw) } catch { return }
      for (const node of findObjects(root)) {
        const rawDate = stringProperty(node, 'datePublished') ?? stringProperty(node, 'dateCreated') ?? stringProperty(node, 'uploadDate')
        if (!rawDate) continue
        const date = this.parseDateValue(rawDate)
        if (date === null) continue
        for (const rawUrl of extractJsonLdUrls(node)) {
          const resolved = resolveHttpUrl(this.baseUrl, rawUrl)
          if (resolved) dates.set(normalizeUrl(resolved), date)
        }
      }
    })
    return dates
  }
}

const ABSOLUTE_DATE_RE = /(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/
const CHINESE_DATE_RE = /(?:19|20)\d{2}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?/
const MONTH_DAY_RE = /(?<!\d)\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?(?!\d)/
const TIME_ONLY_RE = /(?<!\d)\d{1,2}:\d{2}(?!\d)/

function* findObjects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* findObjects(item)
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    yield object
    for (const child of Object.values(object)) yield* findObjects(child)
  }
}

function stringProperty(object: Record<string, unknown>, key: string): string | null {
  const value = object[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function* extractJsonLdUrls(node: Record<string, unknown>): Generator<string> {
  const directUrl = stringProperty(node, 'url')
  const directId = stringProperty(node, '@id')
  if (directUrl) yield directUrl
  if (directId) yield directId
  const mainEntity = node.mainEntityOfPage
  if (typeof mainEntity === 'string') yield mainEntity
  else if (mainEntity && typeof mainEntity === 'object') {
    const object = mainEntity as Record<string, unknown>
    const id = stringProperty(object, '@id')
    const url = stringProperty(object, 'url')
    if (id) yield id
    if (url) yield url
  }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
    let path = url.pathname.replace(/\/+$/, '')
    if (!path) path = '/'
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${path}${url.search}`
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

