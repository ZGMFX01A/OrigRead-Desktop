import * as cheerio from 'cheerio'

const MIN_VISIBLE_TEXT_LENGTH = 600
const MIN_COMPACT_VISIBLE_TEXT_LENGTH = 250
const MIN_CONTENT_BLOCKS = 4

/** 对齐 Android EmbeddedRssContentPolicy：只对 /s 微信文章判断 RSS 内嵌正文是否已经足够完整。 */
export function shouldUseEmbeddedRssAsFullContent(link: string, html: string): boolean {
  if (!isWeChatArticle(link) || !html.trim()) return false
  const $ = cheerio.load(`<body>${html}</body>`)
  const body = $('body')
  const visibleTextLength = body.text().trim().length
  if (visibleTextLength >= MIN_VISIBLE_TEXT_LENGTH) return true

  const contentBlocks = body.find('p, blockquote, li, h1, h2, h3').toArray()
    .filter((element) => $(element).text().trim().length >= 12)
    .length
  return visibleTextLength >= MIN_COMPACT_VISIBLE_TEXT_LENGTH && contentBlocks >= MIN_CONTENT_BLOCKS
}

function isWeChatArticle(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLocaleLowerCase()
    return (host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com')) && url.pathname === '/s'
  } catch {
    return false
  }
}
