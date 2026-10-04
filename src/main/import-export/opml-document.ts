import { DOMParser } from 'linkedom'

export interface ParsedFeed {
  name: string; url: string; groupKey: string
  isNotification: boolean; isFullContent: boolean; isBrowser: boolean
}
export interface ParsedGroup { key: string; name: string; isDefault: boolean }
export interface ParsedOpml { groups: ParsedGroup[]; feeds: ParsedFeed[] }
interface XmlElement { localName: string; children: ArrayLike<XmlElement>; getAttribute(name: string): string | null }

// 默认组身份独立于名称和 XML 中的出现位置。
const DEFAULT_GROUP_KEY = 'default'

/** 递归读取所有 outline；平面分组使用完整路径，文章来源保留 XML 的首次出现顺序。 */
export function parseOpml(content: string): ParsedOpml {
  if (!content.trim()) throw new Error('OPML 文件为空')
  const document = new DOMParser().parseFromString(content, 'text/xml')
  const root = document?.documentElement as unknown as XmlElement | undefined
  if (!root || root.localName.toLowerCase() !== 'opml') throw new Error('不是有效的 OPML 文件')
  const body = Array.from(root.children).find((element) => element.localName.toLowerCase() === 'body')
  if (!body) throw new Error('OPML 文件缺少 body')
  const group: ParsedGroup = { key: DEFAULT_GROUP_KEY, name: 'Default', isDefault: true }
  const branches = outlines(body).map((outline) => collect(outline, { group, path: [] }))
  const groups = new Map([group, ...branches.flatMap((branch) => branch.groups)].map((item) => [item.key, item]))
  return { groups: [...groups.values()], feeds: branches.flatMap((branch) => branch.feeds) }
}

/** 来源节点也可以包含子 outline；默认节点重置分组路径，但不改变去重优先级。 */
function collect(outline: XmlElement, context: { group: ParsedGroup; path: string[] }): ParsedOpml {
  const url = outline.getAttribute('xmlUrl') ?? outline.getAttribute('url')
  if (url?.trim()) {
    const feed: ParsedFeed = {
      name: outlineName(outline), url: decodeXmlEntities(url).trim(), groupKey: context.group.key,
      isNotification: readBoolean(outline.getAttribute('isNotification')),
      isFullContent: readBoolean(outline.getAttribute('isFullContent')), isBrowser: readBoolean(outline.getAttribute('isBrowser'))
    }
    const children = outlines(outline).map((child) => collect(child, context))
    return { groups: children.flatMap((child) => child.groups), feeds: [feed, ...children.flatMap((child) => child.feeds)] }
  }
  const isDefault = readBoolean(outline.getAttribute('isDefault'))
  const path = isDefault ? [] : [...context.path, outlineName(outline)]
  const group = isDefault ? { key: DEFAULT_GROUP_KEY, name: 'Default', isDefault: true }
    : { key: 'group:' + path.join(' / '), name: path.join(' / '), isDefault: false }
  const children = outlines(outline).map((child) => collect(child, { group, path }))
  return { groups: [group, ...children.flatMap((child) => child.groups)], feeds: children.flatMap((child) => child.feeds) }
}

function outlines(element: XmlElement): XmlElement[] { return Array.from(element.children).filter((child) => child.localName.toLowerCase() === 'outline') }
function readBoolean(value: string | null): boolean { return value?.trim().toLowerCase() === 'true' }

/** 保留已有标题、文本及域名命名语义。 */
function outlineName(element: XmlElement): string {
  const explicit = element.getAttribute('title') ?? element.getAttribute('text')
  if (explicit !== null) return decodeXmlEntities(explicit)
  const url = element.getAttribute('xmlUrl') ?? element.getAttribute('htmlUrl') ?? element.getAttribute('url')
  if (!url) return ''
  try { return new URL(decodeXmlEntities(url)).hostname }
  catch { return '' } // 缺失或非 URL 名称保持空标题，不影响后续来源地址校验。
}

/** Linkedom 的 XML 属性仍可能包含实体，按属性文本解码后再比较 URL。 */
function decodeXmlEntities(value: string): string {
  return value.replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}
