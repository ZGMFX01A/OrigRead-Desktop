import * as cheerio from 'cheerio'
import Parser from 'rss-parser'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import { toRssFeedItem, safeHostName, optionalWithTimeout, type CustomRssItem } from './rss-feed-items'
import { BestIconFinder, extractIconDomain, type RssIconFinder } from './best-icon-finder'
import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'
import { decodeHttpText } from '../../network/http-text-decoder'

export interface RssFetchPayload {
  finalUrl: string
  contentType: string | null
  bytes: Uint8Array
  notModified?: boolean
  etag?: string | null
  lastModified?: string | null
}

export interface RssRequestValidators {
  etag?: string | null
  lastModified?: string | null
}

export interface RssDirectFetchResult {
  feed: DiscoveredRssFeed | null
  notModified: boolean
  etag: string | null
  lastModified: string | null
}

export type RssFetcher = (url: string, validators?: RssRequestValidators, signal?: AbortSignal) => Promise<RssFetchPayload>

export interface RssParseOptions {
  sourcePageUrl?: string
  validators?: RssRequestValidators
  signal?: AbortSignal
  skipIconDiscovery?: boolean
}

// 保留 RSS 扩展正文，并使用解析库对 RSS / Atom 命名空间进行真实解析。
const parser = new Parser<Record<string, never>, CustomRssItem>({
  customFields: {
    item: [['content:encoded', 'contentEncoded']]
  }
})

// 网页未声明 alternate 时按这些常见入口依次查找。
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
   * 2. 失败后复用输入响应，读取 rel=alternate；

   * 3. 追加同源常见 Feed 路径；
   * 4. 候选按顺序逐个真实请求并解析，第一个成功项胜出；
   * 5. 全部失败时重新抛出首次直接解析错误。
   */
  async discover(inputUrl: string, signal?: AbortSignal): Promise<DiscoveredRssFeed> {
    const normalizedInputUrl = normalizeHttpUrl(inputUrl)
    // 输入地址只请求一次：同一响应先按 Feed 解析；若格式不是 RSS/Atom，直接复用这份
    // HTML 做 rel=alternate 发现，避免“先 parseDirect、失败后 discover 又下载一次”的重复请求。
    const inputPayload = await this.fetcher(normalizedInputUrl, undefined, signal)
    try {
      // Feed 已解析即可进入配置，额外站点图标不占用整轮发现预算。
      return await this.parsePayload(inputPayload, { feedUrl: normalizedInputUrl, sourcePageUrl: normalizedInputUrl, discoveredFromPage: false, signal, skipIconDiscovery: true })

    } catch (directError) {
      signal?.throwIfAborted()
      const pageUrl = inputPayload.finalUrl
      const html = decodePayload(inputPayload)
      const candidates = distinct([
        ...extractAlternateFeedUrls(html, pageUrl),
        ...buildCommonFeedCandidates(pageUrl)
      ])

      for (const candidateUrl of candidates) {
        try {
          return await this.parseFeedUrl(candidateUrl, { sourcePageUrl: pageUrl, discoveredFromPage: true, signal, skipIconDiscovery: true })

        } catch {
          // 解析失败可进入下一个候选；取消必须终止网络链。
          signal?.throwIfAborted()
        }
      }

      throw directError
    }
  }

  /** 直接请求已确认来源，页面地址、取消信号及图标策略由调用方提供。 */
  async parseDirect(feedUrl: string, options: RssParseOptions = {}): Promise<DiscoveredRssFeed> {
    return this.parseFeedUrl(normalizeHttpUrl(feedUrl), { ...options, discoveredFromPage: false })
  }

  /** 304 无正文时不解析 XML，验证器仍由同一来源的事务控制提交。 */
  async parseDirectConditional(feedUrl: string, options: RssParseOptions = {}): Promise<RssDirectFetchResult> {
    const normalizedFeedUrl = normalizeHttpUrl(feedUrl)
    const validators = options.validators ?? {}
    const payload = await this.fetcher(normalizedFeedUrl, validators, options.signal)
    if (payload.notModified) {
      return {
        feed: null,
        notModified: true,
        etag: payload.etag ?? validators.etag ?? null,
        lastModified: payload.lastModified ?? validators.lastModified ?? null
      }
    }
    return {
      feed: await this.parsePayload(payload, { ...options, feedUrl: normalizedFeedUrl, sourcePageUrl: options.sourcePageUrl ?? normalizedFeedUrl, discoveredFromPage: false }),
      notModified: false,
      etag: payload.etag ?? null,
      lastModified: payload.lastModified ?? null
    }
  }

  private async parseFeedUrl(feedUrl: string, options: RssParseOptions & { discoveredFromPage: boolean }): Promise<DiscoveredRssFeed> {
    options.signal?.throwIfAborted()
    const payload = await this.fetcher(feedUrl, undefined, options.signal)
    return this.parsePayload(payload, { ...options, feedUrl, sourcePageUrl: options.sourcePageUrl ?? feedUrl })
  }

  /** 已解析出的 XML 内容独立于图标元数据；刷新可沿用既有图标。 */
  private async parsePayload(payload: RssFetchPayload, context: RssParseOptions & {
    feedUrl: string; sourcePageUrl: string; discoveredFromPage: boolean
  }): Promise<DiscoveredRssFeed> {
    const { feedUrl, sourcePageUrl, discoveredFromPage, signal } = context
    signal?.throwIfAborted()
    const xml = decodePayload(payload)
    const parsed = await parser.parseString(xml)
    const title = parsed.title?.trim() ?? ''

    if (!title && parsed.items.length === 0) {
      throw new Error(`Feed 内容为空或格式无效：${feedUrl}`)
    }

    // 图标是可选元数据，不能让一个已经成功解析的 Feed 因 favicon/站点首页慢而迟迟不能添加。
    const iconUrl = context.skipIconDiscovery ? parsed.image?.url?.trim() || null : await optionalWithTimeout(
      this.iconFinder.findBestIcon(extractIconDomain(sourcePageUrl)),
      3_000
    )
    signal?.throwIfAborted()
    return {
      feedUrl,
      sourcePageUrl,
      discoveredFromPage,
      etag: payload.etag ?? null,
      lastModified: payload.lastModified ?? null,
      title: title || safeHostName(sourcePageUrl),
      siteUrl: parsed.link?.trim() || null,
      // Android 在 RssHelper.parseFeedUrl 中始终使用 BestIconFinder 覆盖 Feed 自带 image。
      iconUrl,
      items: parsed.items.map(toRssFeedItem)
    }
  }
}

export async function fetchRssPayload(
  url: string,
  validators: RssRequestValidators = {},
  signal?: AbortSignal
): Promise<RssFetchPayload> {
  const headers: Record<string, string> = {
    'user-agent': DESKTOP_BROWSER_USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8'
  }
  if (validators.etag) headers['If-None-Match'] = validators.etag
  if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified
  const response = await fetch(url, {
    redirect: 'follow',
    signal: combineAbortSignals(signal, AbortSignal.timeout(20_000)),
    headers
  })
  if (response.status === 304) {
    return {
      finalUrl: response.url || url,
      contentType: response.headers.get('content-type'),
      bytes: new Uint8Array(),
      notModified: true,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified')
    }
  }
  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status}`)
  }
  return {
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer()),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified')
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

function combineAbortSignals(primary: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  return primary ? AbortSignal.any([primary, timeout]) : timeout
}

function decodePayload(payload: RssFetchPayload): string {
  return decodeHttpText(payload.bytes, payload.contentType, 'auto')
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

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}
