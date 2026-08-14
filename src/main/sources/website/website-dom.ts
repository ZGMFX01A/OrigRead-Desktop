import * as cheerio from 'cheerio'
import type { AnyNode, Element } from 'domhandler'

export interface WebsiteDocument {
  $: cheerio.CheerioAPI
  baseUrl: string
}

export function loadWebsiteDocument(html: string, baseUrl: string): WebsiteDocument {
  return { $: cheerio.load(html), baseUrl }
}

export function elementChildren($: cheerio.CheerioAPI, node: Element): Element[] {
  return $(node).children().toArray().filter(isElement)
}

export function parentElement($: cheerio.CheerioAPI, node: Element): Element | null {
  const parent = $(node).parent().get(0)
  return parent && isElement(parent) ? parent : null
}

export function ancestorElements($: cheerio.CheerioAPI, node: Element, maxDepth = Number.POSITIVE_INFINITY): Element[] {
  const result: Element[] = []
  let current = parentElement($, node)
  while (current && result.length < maxDepth) {
    result.push(current)
    current = parentElement($, current)
  }
  return result
}

export function previousElementSibling($: cheerio.CheerioAPI, node: Element): Element | null {
  const previous = $(node).prev().get(0)
  return previous && isElement(previous) ? previous : null
}

export function classNames($: cheerio.CheerioAPI, node: Element): string[] {
  return ($(node).attr('class') ?? '').split(/\s+/).map((value) => value.trim()).filter(Boolean)
}

export function tagName(node: Element): string {
  return node.name.toLowerCase()
}

export function selectWithin($: cheerio.CheerioAPI, root: Element, selector: string): Element[] {
  const result: Element[] = []
  if ($(root).is(selector)) result.push(root)
  for (const node of $(root).find(selector).toArray()) {
    if (isElement(node)) result.push(node)
  }
  return result
}

export function selectFirstWithin($: cheerio.CheerioAPI, root: Element, selector: string): Element | null {
  return selectWithin($, root, selector)[0] ?? null
}

export function resolveHttpUrl(baseUrl: string, value: string): string | null {
  try {
    const url = new URL(value.trim(), baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function resolveElementAttribute(
  $: cheerio.CheerioAPI,
  element: Element,
  attribute: string,
  baseUrl: string
): string | null {
  const raw = $(element).attr(attribute)?.trim()
  return raw ? resolveHttpUrl(baseUrl, raw) : null
}

export function isElement(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
}

/** Kotlin/Java String.hashCode()，用于让自动规则 ID 与 Android 保持稳定语义。 */
export function javaStringHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

export function unsignedHex(value: number): string {
  return (value >>> 0).toString(16)
}

export function compileAndroidRegex(pattern: string): RegExp {
  let source = pattern
  let flags = ''
  const inline = source.match(/^\(\?([ims]+)\)/)
  if (inline) {
    flags = inline[1]!.replace('s', 's')
    source = source.slice(inline[0].length)
  }
  return new RegExp(source, flags)
}

