import { DOMParser } from 'linkedom'
import { MAX_GROUP_TREE_DEPTH } from '../../shared/group-tree'

export interface ParsedFeed {
  name: string
  url: string
  groupKey: string
  isNotification: boolean
  isFullContent: boolean
  isBrowser: boolean
}

export interface ParsedGroup {
  key: string
  name: string
  isDefault: boolean
  parentKey: string | null
  path: string[]
}

export interface ParsedOpml {
  groups: ParsedGroup[]
  feeds: ParsedFeed[]
}

interface XmlElement {
  localName: string
  children: ArrayLike<XmlElement>
  getAttribute(name: string): string | null
}

export const DEFAULT_GROUP_KEY = 'default'

interface TraversalContext {
  currentGroupKey: string
  currentParentFolderKey: string | null
  path: string[]
  depth: number
  groupDepth: number
}

/** 递归读取所有 outline；本地保留真实嵌套与空文件夹，支持远端平面路径降级。 */
export function parseOpml(content: string): ParsedOpml {
  if (!content.trim()) throw new Error('OPML 文件为空')
  const document = new DOMParser().parseFromString(content, 'text/xml')
  const root = document?.documentElement as unknown as XmlElement | undefined
  if (!root || root.localName.toLowerCase() !== 'opml') throw new Error('不是有效的 OPML 文件')
  const body = Array.from(root.children).find((element) => element.localName.toLowerCase() === 'body')
  if (!body) throw new Error('OPML 文件缺少 body')

  const defaultGroup: ParsedGroup = {
    key: DEFAULT_GROUP_KEY,
    name: 'Default',
    isDefault: true,
    parentKey: null,
    path: []
  }

  const groupMap = new Map<string, ParsedGroup>([[defaultGroup.key, defaultGroup]])
  const feeds: ParsedFeed[] = []

  const initialContext: TraversalContext = {
    currentGroupKey: DEFAULT_GROUP_KEY,
    currentParentFolderKey: null,
    path: [],
    depth: 0,
    groupDepth: 0
  }

  for (const outline of outlines(body)) {
    collectOutline(outline, initialContext, groupMap, feeds)
  }

  return {
    groups: [...groupMap.values()],
    feeds
  }
}

/** 递归收集 outline 节点，支持有界深度、匿名容器提升、来源子节点及同父同名合并。 */
function collectOutline(
  outline: XmlElement,
  context: TraversalContext,
  groupMap: Map<string, ParsedGroup>,
  feeds: ParsedFeed[]
): void {
  const nextDepth = context.depth + 1
  if (nextDepth > 64) {
    throw new Error(`分组层级深度超过最大限制 (${MAX_GROUP_TREE_DEPTH})`)
  }

  const url = outline.getAttribute('xmlUrl') ?? outline.getAttribute('url')
  if (url?.trim()) {
    // 来源节点（带 xmlUrl / url）
    const feed: ParsedFeed = {
      name: outlineName(outline),
      url: decodeXmlEntities(url).trim(),
      groupKey: context.currentGroupKey,
      isNotification: readBoolean(outline.getAttribute('isNotification')),
      isFullContent: readBoolean(outline.getAttribute('isFullContent')),
      isBrowser: readBoolean(outline.getAttribute('isBrowser'))
    }
    feeds.push(feed)

    // 来源节点也可以包含子 outline：视为 feed + 已有子结构处理（孩子沿用当前分组上下文）
    for (const child of outlines(outline)) {
      collectOutline(
        child,
        {
          currentGroupKey: context.currentGroupKey,
          currentParentFolderKey: context.currentParentFolderKey,
          path: context.path,
          depth: nextDepth,
          groupDepth: context.groupDepth
        },
        groupMap,
        feeds
      )
    }
    return
  }

  const isDefault = readBoolean(outline.getAttribute('isDefault'))
  if (isDefault) {
    // 默认分组标记：子来源归入默认分组；由于默认分组不可作为父节点，子文件夹提升到根层
    for (const child of outlines(outline)) {
      collectOutline(
        child,
        {
          currentGroupKey: DEFAULT_GROUP_KEY,
          currentParentFolderKey: null,
          path: [],
          depth: nextDepth,
          groupDepth: 0
        },
        groupMap,
        feeds
      )
    }
    return
  }

  const name = outlineName(outline).trim()
  if (!name) {
    // 匿名容器：不创建虚假文件夹，其孩子提升到当前层级
    for (const child of outlines(outline)) {
      collectOutline(
        child,
        {
          currentGroupKey: context.currentGroupKey,
          currentParentFolderKey: context.currentParentFolderKey,
          path: context.path,
          depth: nextDepth,
          groupDepth: context.groupDepth
        },
        groupMap,
        feeds
      )
    }
    return
  }

  // 普通文件夹节点：保留普通名称不按 / 拆分
  const nextGroupDepth = context.groupDepth + 1
  if (nextGroupDepth > MAX_GROUP_TREE_DEPTH) {
    throw new Error(`分组层级深度超过最大限制 (${MAX_GROUP_TREE_DEPTH})`)
  }

  const groupPath = [...context.path, name]
  const groupKey = JSON.stringify(groupPath)
  const parentKey = context.currentParentFolderKey

  if (!groupMap.has(groupKey)) {
    groupMap.set(groupKey, {
      key: groupKey,
      name,
      isDefault: false,
      parentKey,
      path: groupPath
    })
  }

  const nextContext: TraversalContext = {
    currentGroupKey: groupKey,
    currentParentFolderKey: groupKey,
    path: groupPath,
    depth: nextDepth,
    groupDepth: nextGroupDepth
  }

  for (const child of outlines(outline)) {
    collectOutline(child, nextContext, groupMap, feeds)
  }
}

function outlines(element: XmlElement): XmlElement[] {
  return Array.from(element.children).filter((child) => child.localName.toLowerCase() === 'outline')
}

function readBoolean(value: string | null): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/** 保留已有标题、文本及域名命名语义。 */
function outlineName(element: XmlElement): string {
  const explicit = element.getAttribute('title') ?? element.getAttribute('text')
  if (explicit !== null) return decodeXmlEntities(explicit)
  const url = element.getAttribute('xmlUrl') ?? element.getAttribute('htmlUrl') ?? element.getAttribute('url')
  if (!url) return ''
  try {
    return new URL(decodeXmlEntities(url)).hostname
  } catch {
    return '' // 缺失或非 URL 名称保持空标题，不影响后续来源地址校验。
  }
}

/** Linkedom 的 XML 属性仍可能包含实体，按属性文本解码后再比较 URL。 */
function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {quot:'"', apos:"'", lt:'<', gt:'>', amp:'&'}
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|lt|gt|amp);/gi, (entity, key: string) => {
    if (!key.startsWith('#')) return named[key] ?? entity
    const point = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
    return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) || point === 0 ? '\uFFFD' : String.fromCodePoint(point)
  })
}
