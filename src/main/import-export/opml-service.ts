import { randomUUID } from 'node:crypto'
import type { LibraryRepository } from '../database/library-repository'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import type { OpmlImportResult } from '../../shared/opml'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import { parseOpml, type ParsedFeed } from './opml-document'

/** 标准 OPML 仅搬运 RSS 来源；任意深度分组映射为完整路径。 */
export class OpmlService {
  constructor(private readonly library: LibraryRepository) {}

  /** 先规划、校验与去重，再在单个事务中导入，避免重复组和部分写入。 */
  importFromString(content: string): OpmlImportResult {
    const parsed = parseOpml(content)
    const accountId = this.library.getCurrentAccountId()
    const existingGroups = this.library.listGroupsForAccount(accountId)
    const defaultGroup = this.library.getDefaultGroupForAccount(accountId)
    if (!defaultGroup) throw new Error('导入账户缺少默认分组')
    const newGroups: GroupRecord[] = []
    const groups = new Map(parsed.groups.map((sourceGroup) => {
      const existing = sourceGroup.isDefault ? defaultGroup
        : [...existingGroups, ...newGroups].find((group) => !group.isDefault && group.name === sourceGroup.name)
      const group = existing ?? {
        id: 'group-' + randomUUID(), accountId, name: sourceGroup.name,
        sortOrder: existingGroups.length + newGroups.length, isDefault: false
      }
      if (!existing) newGroups.push(group)
      return [sourceGroup.key, group] as const
    }))
    const seen = new Set(this.library.listFeedsForAccount(accountId).map((feed) => sourceUrlComparisonKey(feed.url)))
    const now = Date.now()
    const feeds = parsed.feeds.flatMap((sourceFeed) => {
      const url = validateFeedUrl(sourceFeed.url)
      const key = sourceUrlComparisonKey(url)
      if (seen.has(key)) return []
      seen.add(key)
      return [importedFeed(sourceFeed, { group: groups.get(sourceFeed.groupKey)!, url, now })]
    })
    this.library.transaction(() => {
      newGroups.forEach((group) => this.library.upsertGroup(group))
      feeds.forEach((feed) => this.library.upsertFeed(feed))
    })
    return { groupsAdded: newGroups.length, feedsAdded: feeds.length, feedsSkipped: parsed.feeds.length - feeds.length }
  }

  /** JSON 规则与网站解析配置不能伪装成 XML 来源，标准 OPML 只导出 RSS。 */
  exportToString(attachInfo: boolean): string {
    const groups = this.library.listGroups()
    const feeds = this.library.listFeeds().filter((feed) => feed.sourceType === 'rss')
    const outlines = groups.map((group) => {
      const attrs: Record<string, string> = { text: group.name, title: group.name }
      if (attachInfo) attrs.isDefault = String(group.isDefault)
      const children = feeds.filter((feed) => feed.groupId === group.id)
        .map((feed) => '    <outline ' + serializeAttributes(feedAttributes(feed, attachInfo)) + ' />')
      return ['  <outline ' + serializeAttributes(attrs) + '>', ...children, '  </outline>'].join('\n')
    })
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', ' <head>',
      '  <title>OrigRead</title>', '  <dateCreated>' + escapeXml(new Date().toString()) + '</dateCreated>',
      ' </head>', ' <body>', ...outlines, ' </body>', '</opml>', ''].join('\n')
  }
}

/** 外部 OPML 的来源必须是可请求的绝对 HTTP 地址，异常在任何写入前暴露。 */
function validateFeedUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OPML 来源仅支持 HTTP(S)：' + value)
  return url.toString()
}

/** 每条导入来源固定到解析时的分组账户，保留已有 OPML 标志。 */
function importedFeed(source: ParsedFeed, options: { group: GroupRecord; url: string; now: number }): FeedRecord {
  return {
    id: 'feed-' + randomUUID(), accountId: options.group.accountId, groupId: options.group.id,
    name: source.name, url: options.url, sourcePageUrl: options.url, sourceType: 'rss', icon: null,
    isNotification: source.isNotification, isFullContent: source.isFullContent, isBrowser: source.isBrowser,
    dynamicRendering: false, createdAt: options.now, updatedAt: options.now
  }
}

function feedAttributes(feed: FeedRecord, attachInfo: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    text: feed.name, title: feed.name, type: 'rss', xmlUrl: feed.url, htmlUrl: feed.url
  }
  if (attachInfo) {
    attrs.isNotification = String(feed.isNotification)
    attrs.isFullContent = String(feed.isFullContent)
    attrs.isBrowser = String(feed.isBrowser)
  }
  return attrs
}

/** 属性始终 XML 转义，避免 URL 查询参数和文章标题破坏文档结构。 */
function serializeAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).map(([key, value]) => key + '="' + escapeXml(value) + '"').join(' ')
}
function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
