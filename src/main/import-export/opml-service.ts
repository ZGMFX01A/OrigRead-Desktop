import { randomUUID } from 'node:crypto'
import { DOMParser } from 'linkedom'
import type { LibraryRepository } from '../database/library-repository'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { OpmlImportResult } from '../../shared/opml'

interface ParsedFeed {
  name: string
  url: string
  isNotification: boolean
  isFullContent: boolean
  isBrowser: boolean
}

interface ParsedGroup {
  name: string
  isDefault: boolean
  feeds: ParsedFeed[]
}

interface XmlElement {
  localName: string
  children: ArrayLike<XmlElement>
  getAttribute(name: string): string | null
}

/**
 * Desktop OPML behavior follows Android OpmlService / OPMLDataSource:
 * - top-level feeds belong to the default group;
 * - top-level group outlines create groups unless isDefault=true;
 * - existing feed URLs are skipped rather than updated;
 * - OrigRead-specific feed flags are optional OPML attributes.
 */
export class OpmlService {
  constructor(private readonly library: LibraryRepository) {}

  importFromString(content: string): OpmlImportResult {
    const parsed = parseOpml(content)
    const existingGroups = this.library.listGroups()
    const existingUrls = new Set(this.library.listFeeds().map((feed) => feed.url.trim()).filter(Boolean))
    const importedUrls = new Set<string>()
    let groupsAdded = 0
    let feedsAdded = 0
    let feedsSkipped = 0

    for (const sourceGroup of parsed) {
      let groupId = this.library.getCurrentDefaultGroup().id
      if (!sourceGroup.isDefault) {
        const group: GroupRecord = {
          id: `group-${randomUUID()}`,
          name: sourceGroup.name,
          sortOrder: existingGroups.length + groupsAdded,
          isDefault: false
        }
        this.library.upsertGroup(group)
        groupId = group.id
        groupsAdded++
      }

      for (const sourceFeed of sourceGroup.feeds) {
        const url = sourceFeed.url.trim()
        if (!url || existingUrls.has(url) || importedUrls.has(url)) {
          feedsSkipped++
          continue
        }
        const now = Date.now()
        const feed: FeedRecord = {
          id: `feed-${randomUUID()}`,
          groupId,
          name: sourceFeed.name,
          url,
          sourcePageUrl: url,
          sourceType: 'rss',
          icon: null,
          isNotification: sourceFeed.isNotification,
          isFullContent: sourceFeed.isFullContent,
          isBrowser: sourceFeed.isBrowser,
          dynamicRendering: false,
          createdAt: now,
          updatedAt: now
        }
        this.library.upsertFeed(feed)
        importedUrls.add(url)
        feedsAdded++
      }
    }

    return { groupsAdded, feedsAdded, feedsSkipped }
  }

  exportToString(attachInfo: boolean): string {
    const groups = this.library.listGroups()
    const feeds = this.library.listFeeds()
    const outlines = groups.map((group) => {
      const groupFeeds = feeds.filter((feed) => feed.groupId === group.id)
      const groupAttrs: Record<string, string> = { text: group.name, title: group.name }
      if (attachInfo) groupAttrs.isDefault = String(group.isDefault)
      const children = groupFeeds.map((feed) => {
        const attrs: Record<string, string> = {
          text: feed.name,
          title: feed.name,
          xmlUrl: feed.url,
          htmlUrl: feed.url
        }
        if (attachInfo) {
          attrs.isNotification = String(feed.isNotification)
          attrs.isFullContent = String(feed.isFullContent)
          attrs.isBrowser = String(feed.isBrowser)
        }
        return `    <outline ${serializeAttributes(attrs)} />`
      })
      return [
        `  <outline ${serializeAttributes(groupAttrs)}>`,
        ...children,
        '  </outline>'
      ].join('\n')
    })

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      ' <head>',
      '  <title>OrigRead</title>',
      `  <dateCreated>${escapeXml(new Date().toString())}</dateCreated>`,
      ' </head>',
      ' <body>',
      ...outlines,
      ' </body>',
      '</opml>',
      ''
    ].join('\n')
  }
}

function parseOpml(content: string): ParsedGroup[] {
  if (!content.trim()) throw new Error('OPML 文件为空')
  const document = new DOMParser().parseFromString(content, 'text/xml')
  const root = document?.documentElement as unknown as XmlElement | undefined
  if (!root || root.localName.toLowerCase() !== 'opml') throw new Error('不是有效的 OPML 文件')
  const body = Array.from(root.children).find((element) => element.localName.toLowerCase() === 'body')
  if (!body) throw new Error('OPML 文件缺少 body')

  const defaultGroup: ParsedGroup = { name: 'Default', isDefault: true, feeds: [] }
  const groups: ParsedGroup[] = [defaultGroup]
  const topLevel = Array.from(body.children).filter((element) => element.localName.toLowerCase() === 'outline')

  for (const outline of topLevel) {
    const children = Array.from(outline.children).filter((element) => element.localName.toLowerCase() === 'outline')
    if (children.length === 0) {
      const feed = parseFeed(outline)
      if (feed) {
        defaultGroup.feeds.push(feed)
      } else if (!readBoolean(outline.getAttribute('isDefault'))) {
        groups.push({ name: outlineName(outline), isDefault: false, feeds: [] })
      }
      continue
    }

    const isDefault = readBoolean(outline.getAttribute('isDefault'))
    const group: ParsedGroup = isDefault
      ? defaultGroup
      : { name: outlineName(outline), isDefault: false, feeds: [] }
    if (!isDefault) groups.push(group)
    for (const child of children) {
      const feed = parseFeed(child)
      if (feed) group.feeds.push(feed)
    }
  }

  return groups
}

function parseFeed(element: XmlElement): ParsedFeed | null {
  const url = decodeXmlEntities(element.getAttribute('xmlUrl') ?? element.getAttribute('url') ?? '').trim()
  if (!url) return null
  return {
    name: outlineName(element),
    url,
    isNotification: readBoolean(element.getAttribute('isNotification')),
    isFullContent: readBoolean(element.getAttribute('isFullContent')),
    isBrowser: readBoolean(element.getAttribute('isBrowser'))
  }
}

function outlineName(element: XmlElement): string {
  const explicit = element.getAttribute('title') ?? element.getAttribute('text')
  if (explicit !== null) return decodeXmlEntities(explicit)
  const url = element.getAttribute('xmlUrl') ?? element.getAttribute('htmlUrl') ?? element.getAttribute('url')
  if (!url) return ''
  try {
    return new URL(decodeXmlEntities(url)).hostname
  } catch {
    return ''
  }
}

function readBoolean(value: string | null): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function serializeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(' ')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
