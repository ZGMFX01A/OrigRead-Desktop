import * as cheerio from 'cheerio'
import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'

export interface IconFetchPayload {
  finalUrl: string
  contentType: string | null
  bytes: Uint8Array
}

export type IconFetcher = (url: string) => Promise<IconFetchPayload>

type IconFormat = 'apple-touch-icon' | 'svg' | 'png' | 'ico' | 'gif' | 'jpg'

interface IconCandidate {
  url: string
  format: IconFormat
  size: number
}

interface IconLink {
  url: string
  forcedFormat?: IconFormat
}

const FORMAT_PRIORITY: Record<IconFormat, number> = {
  'apple-touch-icon': 0,
  svg: 1,
  png: 2,
  ico: 3,
  gif: 4,
  jpg: 5
}

export interface RssIconFinder {
  findBestIcon(siteUrl: string): Promise<string | null>
}

/**
 * 对齐 Android BestIconFinder：
 * apple-touch-icon > SVG > PNG > ICO > GIF > JPG；同格式优先字节更大的候选。
 */
export class BestIconFinder implements RssIconFinder {
  constructor(private readonly fetcher: IconFetcher = fetchIconPayload) {}

  async findBestIcon(siteUrl: string): Promise<string | null> {
    const normalized = normalizeSiteUrl(siteUrl)
    let iconLinks: IconLink[]
    try {
      const page = await this.fetcher(normalized)
      iconLinks = findIconLinks(decodePayload(page), page.finalUrl || normalized)
      const fallback = new URL('/favicon.ico', normalized).toString()
      if (!iconLinks.some((item) => item.url === fallback)) iconLinks.push({ url: fallback })
    } catch {
      const origin = new URL(normalized).origin
      iconLinks = [
        { url: `${origin}/apple-touch-icon.png`, forcedFormat: 'apple-touch-icon' },
        { url: `${origin}/apple-touch-icon-precomposed.png`, forcedFormat: 'apple-touch-icon' },
        { url: `${origin}/favicon.ico` }
      ]
    }

    const candidates: IconCandidate[] = []
    for (const link of distinctLinks(iconLinks)) {
      try {
        const response = await this.fetcher(link.url)
        const format = link.forcedFormat ?? detectFormat(link.url, response.contentType)
        if (!format) continue
        candidates.push({ url: link.url, format, size: response.bytes.byteLength })
      } catch {
        // Android 会忽略单个图标候选失败，继续比较剩余项。
      }
    }

    return candidates
      .sort((left, right) => FORMAT_PRIORITY[left.format] - FORMAT_PRIORITY[right.format] || right.size - left.size)[0]
      ?.url ?? null
  }
}

export function extractIconDomain(value: string): string {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`).hostname || value
  } catch {
    const match = /(?:https?:\/\/)?([\w\d.-]+(?:\.[\w\d.-]+)+)/i.exec(value)
    return match?.[1] ?? value
  }
}

function findIconLinks(html: string, baseUrl: string): IconLink[] {
  const $ = cheerio.load(html)
  const links: IconLink[] = []
  $('link[rel~="apple-touch-icon"][href]').each((_index, element) => {
    const resolved = absoluteUrl($(element).attr('href'), baseUrl)
    if (resolved) links.push({ url: resolved, forcedFormat: 'apple-touch-icon' })
  })
  $('link[rel~="icon"][href]').each((_index, element) => {
    const resolved = absoluteUrl($(element).attr('href'), baseUrl)
    if (resolved) links.push({ url: resolved })
  })
  const ogImage = $('meta[property="og:image"]').first().attr('content')?.trim()
  if (ogImage) links.push({ url: ogImage })
  return distinctLinks(links)
}

function detectFormat(url: string, contentType: string | null): IconFormat | null {
  if (url.toLowerCase().includes('apple-touch-icon')) return 'apple-touch-icon'
  const type = contentType?.toLowerCase() ?? ''
  if (type.includes('svg')) return 'svg'
  if (type.includes('png')) return 'png'
  if (type.includes('icon') || type.includes('ico')) return 'ico'
  if (type.includes('gif')) return 'gif'
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg'
  return null
}

function normalizeSiteUrl(value: string): string {
  const raw = value.trim()
  if (!raw) throw new TypeError('Site URL must not be empty')
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Only http and https URLs are supported')
  return url.toString()
}

function absoluteUrl(value: string | undefined, baseUrl: string): string | null {
  if (!value?.trim()) return null
  try { return new URL(value.trim(), baseUrl).toString() } catch { return null }
}

function decodePayload(payload: IconFetchPayload): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(payload.contentType ?? '')?.[1] ?? 'utf-8'
  try { return new TextDecoder(charset).decode(payload.bytes) } catch { return new TextDecoder('utf-8').decode(payload.bytes) }
}

function distinctLinks(values: IconLink[]): IconLink[] {
  const seen = new Set<string>()
  return values.filter((item) => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

async function fetchIconPayload(url: string): Promise<IconFetchPayload> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: {
      'user-agent': DESKTOP_BROWSER_USER_AGENT,
      Accept: 'text/html,image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.8'
    }
  })
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`)
  return {
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type'),
    bytes: new Uint8Array(await response.arrayBuffer())
  }
}
