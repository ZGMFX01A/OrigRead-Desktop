import * as cheerio from 'cheerio'
import Parser from 'rss-parser'
import type { DiscoveredRssFeed, RssFeedItem } from '../../../shared/rss'
import { BestIconFinder, extractIconDomain, type RssIconFinder } from './best-icon-finder'
import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'

interface CustomRssItem {
  contentEncoded?: string
}

export interface RssFetchPayload {
  finalUrl: string
  contentType: string | null
  bytes: Uint8Array
}

export type RssFetcher = (url: string) => Promise<RssFetchPayload>

const parser = new Parser<Record<string, never>, CustomRssItem>({
  customFields: {
    item: [['content:encoded', 'contentEncoded']]
  }
})

const COMMON_FEED_PATHS = [
  '/feed',
  '/feed/',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/feed.xml',
  '/index.xml'
] as const

export class RssDiscoveryService {
  constructor(
    private readonly fetcher: RssFetcher = fetchRssPayload,
    private readonly iconFinder: RssIconFinder = new BestIconFinder()
  ) {}

  /**
   * 与 Android RssHelper.discoverFeed 保持同一顺序：
   * 1. 输入 URL 直接按 Feed 解析；
   * 2. 失败后重新请求输入页，读取 rel=alternate；
   * 3. 追加同源常见 Feed 路径；
   * 4. 候选按顺序逐个真实请求并解析，第一个成功项胜出；
   * 5. 全部失败时重新抛出首次直接解析错误。
   */
  async discover(inputUrl: string): Promise<DiscoveredRssFeed> {
    const normalizedInputUrl = normalizeHttpUrl(inputUrl)

    try {
      return await this.parseFeedUrl(normalizedInputUrl, normalizedInputUrl, false)
    } catch (directError) {
      const pagePayload = await this.fetcher(normalizedInputUrl)
      const html = decodePayload(pagePayload)
      const candidates = distinct([
        ...extractAlternateFeedUrls(html, normalizedInputUrl),
        ...buildCommonFeedCandidates(normalizedInputUrl)
      ])

      for (const candidateUrl of candidates) {
        try {
          return await this.parseFeedUrl(candidateUrl, normalizedInputUrl, true)
        } catch {
          // Android 同样忽略单个候选异常并继续尝试下一个候选。
        }
      }

      throw directError
    }
  }

  async parseDirect(feedUrl: string, sourcePageUrl = feedUrl): Promise<DiscoveredRssFeed> {
    return this.parseFeedUrl(normalizeHttpUrl(feedUrl), normalizeHttpUrl(sourcePageUrl), false)
  }

  private async parseFeedUrl(
    feedUrl: string,
    sourcePageUrl: string,
    discoveredFromPage: boolean
  ): Promise<DiscoveredRssFeed> {
    const payload = await this.fetcher(feedUrl)
    const xml = decodePayload(payload)
    const parsed = await parser.parseString(xml)
    const title = parsed.title?.trim() ?? ''

    if (!title && parsed.items.length === 0) {
      throw new Error(`Feed 内容为空或格式无效：${feedUrl}`)
    }

    const iconUrl = await this.iconFinder.findBestIcon(extractIconDomain(sourcePageUrl)).catch(() => null)
    return {
      feedUrl,
      sourcePageUrl,
      discoveredFromPage,
      title: title || safeHostName(sourcePageUrl),
      siteUrl: parsed.link?.trim() || null,
      // Android 在 RssHelper.parseFeedUrl 中始终使用 BestIconFinder 覆盖 Feed 自带 image。
      iconUrl,
      items: parsed.items.map((item, index) => toRssFeedItem(item, index))
    }
  }
}

export async function fetchRssPayload(url: string): Promise<RssFetchPayload> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': DESKTOP_BROWSER_USER_AGENT,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8'
    }
  })
  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status}`)
  }
  return {
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}

export function buildCommonFeedCandidates(inputUrl: string): string[] {
  try {
    const url = new URL(inputUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return []
    return COMMON_FEED_PATHS.map((path) => `${url.origin}${path}`)
  } catch {
    return []
  }
}

export function extractAlternateFeedUrls(html: string, inputUrl: string): string[] {
  const $ = cheerio.load(html)
  const result: string[] = []
  $('link[rel~="alternate"][href]').each((_, element) => {
    const type = ($(element).attr('type') ?? '').toLowerCase()
    if (!['rss', 'atom', 'rdf', 'xml'].some((marker) => type.includes(marker))) return
    const href = $(element).attr('href')
    if (!href) return
    try {
      result.push(new URL(href, inputUrl).toString())
    } catch {
      // 与 Jsoup absUrl 相同：无法形成绝对 URL 的候选直接忽略。
    }
  })
  return result
}

function decodePayload(payload: RssFetchPayload): string {
  const charset = extractCharset(payload.contentType) ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(payload.bytes)
  } catch {
    return new TextDecoder('utf-8').decode(payload.bytes)
  }
}

function extractCharset(contentType: string | null): string | null {
  if (!contentType) return null
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)
  return match?.[1]?.trim() || null
}

function toRssFeedItem(item: CustomRssItem & Parser.Item, index: number): RssFeedItem {
  const descriptionHtml = item.content ?? item.summary ?? ''
  const contentHtml = item.contentEncoded?.trim() || item.content?.trim() || null
  const link = item.link?.trim() ?? ''
  const publishedAt = parseFeedDate(item.isoDate ?? item.pubDate)
  const title = decodeHtmlText(item.title ?? '') || link || 'Untitled'
  const sourceId = item.guid?.trim() || link || `${title}|${publishedAt ?? 0}|${index}`
  const bodyForImage = contentHtml ?? descriptionHtml

  return {
    sourceId,
    title,
    link,
    author: item.creator?.trim() || null,
    publishedAt,
    descriptionHtml,
    contentHtml,
    imageUrl: item.enclosure?.url?.trim() || findFirstImage(bodyForImage)
  }
}

function parseFeedDate(value: string | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const now = Date.now()
  return timestamp > now ? now : timestamp
}

function decodeHtmlText(value: string): string {
  if (!value) return ''
  return cheerio.load(`<body>${value}</body>`)('body').text().trim()
}

function findFirstImage(html: string): string | null {
  if (!html) return null
  const $ = cheerio.load(html)
  const src = $('img[src]').first().attr('src')?.trim()
  if (!src || src.startsWith('data:')) return null
  return src
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Only http and https source URLs are supported')
  }
  return url.toString()
}

function safeHostName(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

