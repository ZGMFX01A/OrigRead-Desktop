import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'

const REMOVED_ELEMENTS = 'script, style, noscript, template, iframe, object, embed, form, input, button, textarea, select, option, nav, footer, aside, base, link, meta, svg, math, applet, frame, frameset'
const ALLOWED_ELEMENTS = new Set('article section header main div span p br hr h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre code kbd samp var em strong b i u s del ins mark small sub sup cite q abbr time a img picture source video audio figure figcaption table thead tbody tfoot tr th td caption colgroup col details summary'.split(' '))
const ALLOWED_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href', 'title', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'srcset', 'sizes'],
  source: ['src', 'srcset', 'type', 'media'],
  video: ['src', 'poster', 'controls', 'width', 'height'],
  audio: ['src', 'poster', 'controls', 'width', 'height'],
  td: ['colspan', 'rowspan', 'scope'], th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'type', 'reversed'], time: ['datetime'], abbr: ['title'],
  pre: ['class'], code: ['class']
}
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:'])

/** Only article semantics and per-tag safe attributes may cross into the renderer. */
export function sanitizeContentHtml(html: string, sourceUrl: string): string {
  const $ = cheerio.load(`<body>${html}</body>`, { xml: false })
  const body = $('body')
  body.find(REMOVED_ELEMENTS).remove()
  body.find('*').each((_, element) => {
    const target = $(element)
    if (!ALLOWED_ELEMENTS.has(element.name)) {
      target.replaceWith(target.contents())
      return
    }
    if (element.name === 'img' && !target.attr('src')?.trim()) {
      const lazySource = target.attr('data-src')?.trim() || target.attr('data-original')?.trim()
      if (lazySource) target.attr('src', lazySource)
    }
    const allowed = ALLOWED_ATTRIBUTES[element.name] ?? []
    for (const attribute of Object.keys(element.attribs ?? {})) {
      if (!allowed.includes(attribute)) target.removeAttr(attribute)
    }
    if (target.attr('class') !== undefined) {
      const classes = target.attr('class')!.split(/\s+/).filter((value) => /^(?:(?:language|lang)-)?[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value))
      if (classes.length) target.attr('class', classes.join(' '))
      else target.removeAttr('class')
    }
    for (const attribute of ['href', 'src', 'poster']) {
      if (target.attr(attribute) !== undefined) sanitizeUrlAttribute($, element, attribute, sourceUrl)
    }
    if (target.attr('srcset') !== undefined) sanitizeSrcSet($, element, sourceUrl)
  })
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
      if (!resolved || (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor))) return null
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

