import * as cheerio from 'cheerio'
import Parser from 'rss-parser'
import { createHash } from 'node:crypto'
import type { RssFeedItem } from '../../../shared/rss'

export interface CustomRssItem {
  contentEncoded?: string
  /** rss-parser 将 Atom <id> 写入 id，而不是 RSS guid。 */
  id?: string
  /** RDF 条目自身的资源身份，同样独立于浏览器链接。 */
  'rdf:about'?: string
}

// 缺少有效发布日期时使用固定身份分量，不能让抓取时钟参与文章身份。
const UNKNOWN_PUBLICATION_TIME = 0

/** 来源身份优先使用 GUID；无链接条目的内容指纹与 XML 排序无关。 */
export function toRssFeedItem(item: CustomRssItem & Parser.Item): RssFeedItem {
  const descriptionHtml = item.content ?? item.summary ?? ''
  const contentHtml = feedContentHtml(item)
  const link = item.link?.trim() ?? ''
  const publishedAt = parseFeedDate(item.isoDate ?? item.pubDate)
  const title = feedTitle(item, link)
  const sourceId = feedSourceId(item, { title, link, descriptionHtml, contentHtml })
  const bodyForImage = contentHtml ?? descriptionHtml
  const enclosureImage = rssEnclosureImage(item.enclosure)

  return {
    sourceId,
    title,
    link,
    author: item.creator?.trim() || null,
    publishedAt,
    descriptionHtml,
    contentHtml,
    imageUrl: enclosureImage || findFirstImage(bodyForImage)
  }
}

/** 缺少可读标题时使用原始链接或既有空标题文本。 */
function feedTitle(item: Parser.Item, link: string): string {
  return decodeHtmlText(item.title ?? '') || link || 'Untitled'
}

/** 完整正文优先使用 content:encoded，其次使用普通 content。 */
function feedContentHtml(item: CustomRssItem & Parser.Item): string | null {
  return item.contentEncoded?.trim() || item.content?.trim() || null
}

/** 原生 GUID / Atom ID 优先；缺少身份时以完整内容生成指纹，不使用 XML 条目顺序。 */
function feedSourceId(item: CustomRssItem & Parser.Item, fields: Pick<RssFeedItem, 'title' | 'link' | 'descriptionHtml' | 'contentHtml'>): string {
  const identified = item.guid?.trim() || item.id?.trim() || item['rdf:about']?.trim() || fields.link
  if (identified) return identified
  // 阅读列表可以裁剪未来时间，但身份必须使用来源时间，不能随当前时钟改变。
  const sourceDate = Date.parse(item.isoDate ?? item.pubDate ?? '')
  const publicationTime = Number.isFinite(sourceDate) ? sourceDate : UNKNOWN_PUBLICATION_TIME
  return 'fingerprint:' + createHash('sha256').update(fields.title).update('\u0000')
    .update(String(publicationTime)).update('\u0000').update(fields.descriptionHtml)
    .update('\u0000').update(fields.contentHtml ?? '').digest('hex')
}

/** 只把图片 enclosure 作为封面，避免把播客音频误识别为图片。 */
function rssEnclosureImage(enclosure: Parser.Item['enclosure']): string | null {
  const url = enclosure?.url?.trim()
  if (!url) return null
  const type = enclosure?.type?.trim().toLowerCase() ?? ''
  if (type.startsWith('image/')) return url
  if (type) return null
  // 少数老 Feed 不写 MIME；只在 URL 明确是常见图片扩展名时兜底，绝不能把 Podcast mp3 当图片。
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return /\.(?:avif|bmp|gif|jpe?g|png|webp|svg)$/.test(pathname) ? url : null
  } catch {
    return null
  }
}

/** 阅读列表保留既有时间处理：无效日期为空，未来日期按抓取时刻展示。 */
function parseFeedDate(value: string | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const now = Date.now()
  return timestamp > now ? now : timestamp
}

/** 解码标题中的实体和 HTML 标记，保存阅读界面显示的纯文本。 */
function decodeHtmlText(value: string): string {
  if (!value) return ''
  return cheerio.load(`<body>${value}</body>`)('body').text().trim()
}

/** 正文首图只接受真实地址，内嵌 data 图片不作为远程封面。 */
function findFirstImage(html: string): string | null {
  if (!html) return null
  const $ = cheerio.load(html)
  const src = $('img[src]').first().attr('src')?.trim()
  if (!src || src.startsWith('data:')) return null
  return src
}

export function safeHostName(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    // 元数据展示保留无法解析的原始文本，不参与 HTTP 请求地址校验。
    return url
  }
}

/** 沿用图标的可选等待策略，图标缺失不改变已经成功的 XML 解析结果。 */
export async function optionalWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
