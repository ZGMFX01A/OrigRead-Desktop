import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'

const REMOVED_ELEMENTS = 'script, style, noscript, template, iframe, object, embed, form, input, button, nav, footer, aside'
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])

/** 对齐 Android ContentHtmlSanitizer：移除可执行/交互节点并补全安全网络 URL。 */
export function sanitizeContentHtml(html: string, sourceUrl: string): string {
  const $ = cheerio.load(`<body>${html}</body>`, { xml: false })
  const body = $('body')

  body.find(REMOVED_ELEMENTS).remove()
  body.find('*').each((_, element) => {
    const attributes = Object.keys(element.attribs ?? {})
    for (const attribute of attributes) {
      if (attribute.toLowerCase().startsWith('on') || attribute.toLowerCase() === 'srcdoc') {
        $(element).removeAttr(attribute)
      }
    }
  })

  body.find('a[href]').each((_, element) => sanitizeUrlAttribute($, element, 'href', sourceUrl))
  body.find('img[src], source[src], video[src], audio[src]').each((_, element) =>
    sanitizeUrlAttribute($, element, 'src', sourceUrl)
  )
  body.find('img[data-src], img[data-original]').each((_, element) => {
    const target = $(element)
    if (!target.attr('src')?.trim()) {
      const lazySource = target.attr('data-src')?.trim() || target.attr('data-original')?.trim()
      if (lazySource) target.attr('src', lazySource)
    }
    sanitizeUrlAttribute($, element, 'src', sourceUrl)
  })
  body.find('img[srcset], source[srcset]').each((_, element) => sanitizeSrcSet($, element, sourceUrl))

  return body.html()?.trim() ?? ''
}

function sanitizeUrlAttribute(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  attribute: string,
  sourceUrl: string
): void {
  const target = $(element)
  const rawValue = target.attr(attribute)?.trim()
  const resolved = rawValue ? resolveAllowedHttpUrl(rawValue, sourceUrl) : null
  if (resolved) target.attr(attribute, resolved)
  else target.removeAttr(attribute)
}

function sanitizeSrcSet(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  sourceUrl: string
): void {
  const target = $(element)
  const normalized = (target.attr('srcset') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [rawUrl, descriptor] = item.split(/\s+/, 2)
      if (!rawUrl) return null
      const resolved = resolveAllowedHttpUrl(rawUrl, sourceUrl)
      if (!resolved) return null
      return descriptor ? `${resolved} ${descriptor}` : resolved
    })
    .filter((item): item is string => item !== null)
    .join(', ')

  if (normalized) target.attr('srcset', normalized)
  else target.removeAttr('srcset')
}

function resolveAllowedHttpUrl(value: string, sourceUrl: string): string | null {
  try {
    const resolved = new URL(value, sourceUrl)
    return ALLOWED_URL_SCHEMES.has(resolved.protocol) ? resolved.toString() : null
  } catch {
    return null
  }
}

