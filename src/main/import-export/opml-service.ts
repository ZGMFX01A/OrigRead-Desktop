import { randomUUID } from 'node:crypto'
import type { LibraryRepository } from '../database/library-repository'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import { normalizeGroupName } from '../../shared/group-name'
import { buildGroupTree, findSiblingGroupByName, type GroupTreeNode } from '../../shared/group-tree'
import type { OpmlImportResult } from '../../shared/opml'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import { parseOpml, DEFAULT_GROUP_KEY, type ParsedFeed } from './opml-document'

/** 标准 OPML 仅搬运 RSS 来源；本地支持真实嵌套层级与往返。 */
export class OpmlService {
  constructor(private readonly library: LibraryRepository) {}

  /** 先规划、校验与去重，再在单个事务中导入，支持本地嵌套幂等，远端账户拒绝导入，invalidURL 不得留下半组。 */
  importFromString(content: string): OpmlImportResult {
    const parsed = parseOpml(content)
    const accountId = this.library.getCurrentAccountId()
    const accountType = this.library.getAccountType(accountId)
    if (accountType !== 'local') {
      throw new Error('当前远端账户不支持导入 OPML；请在服务端管理订阅，或切换到 Local 账户。')
    }
    const existingGroups = this.library.listGroupsForAccount(accountId)
    const defaultGroup = this.library.getDefaultGroupForAccount(accountId)
    if (!defaultGroup) throw new Error('导入账户缺少默认分组')

    const newGroups: GroupRecord[] = []
    const keyToGroup = new Map<string, GroupRecord>()
    keyToGroup.set(DEFAULT_GROUP_KEY, defaultGroup)

    for (const sourceGroup of parsed.groups) {
      if (sourceGroup.key === DEFAULT_GROUP_KEY || sourceGroup.isDefault) {
        keyToGroup.set(sourceGroup.key, defaultGroup)
        continue
      }

      const normalizedName = normalizeGroupName(sourceGroup.name)
      if (normalizedName.length > 200) {
        throw new Error('分组名称不能超过 200 个字符')
      }

      // 本地账户：保留真实层级结构
      let parentId: string | null = null
      if (sourceGroup.parentKey) {
        const parentGroup = keyToGroup.get(sourceGroup.parentKey)
        // 默认组不能作为父分组
        parentId = parentGroup && !parentGroup.isDefault ? parentGroup.id : null
      }

      // 按父关系匹配同级名称；若根级精确匹配默认分组名称则归入默认组（区分大小写）
      let existing: GroupRecord | undefined
      if (parentId === null && sourceGroup.name.trim() === defaultGroup.name.trim()) {
        existing = defaultGroup
      } else {
        existing = findSiblingGroupByName([...existingGroups, ...newGroups], sourceGroup.name, parentId)
      }

      const group = existing ?? {
        id: 'group-' + randomUUID(),
        accountId,
        name: normalizedName,
        sortOrder: existingGroups.length + newGroups.length,
        isDefault: false,
        parentId
      }
      if (!existing) newGroups.push(group)
      keyToGroup.set(sourceGroup.key, group)
    }

    // 先完整解析校验所有来源 URL，出现非法 URL 则在任何写入前失败抛错
    const seen = new Set(this.library.listFeedsForAccount(accountId).map((feed) => sourceUrlComparisonKey(feed.url)))
    const now = Date.now()
    const feeds = parsed.feeds.flatMap((sourceFeed) => {
      const url = validateFeedUrl(sourceFeed.url)
      const key = sourceUrlComparisonKey(url)
      if (seen.has(key)) return []
      seen.add(key)
      const targetGroup = keyToGroup.get(sourceFeed.groupKey) ?? defaultGroup
      return [importedFeed(sourceFeed, { group: targetGroup, url, now })]
    })

    this.library.transaction(() => {
      newGroups.forEach((group) => this.library.upsertGroup(group))
      feeds.forEach((feed) => this.library.upsertFeed(feed))
    })

    return {
      groupsAdded: newGroups.length,
      feedsAdded: feeds.length,
      feedsSkipped: parsed.feeds.length - feeds.length
    }
  }

  /** JSON 规则与网站解析配置不能伪装成 XML 来源，标准 OPML 只导出 RSS；本地支持真实嵌套层级。 */
  exportToString(attachInfo: boolean): string {
    const groups = this.library.listGroups()
    const feeds = this.library.listFeeds().filter((feed) => feed.sourceType === 'rss')

    const feedsByGroup = new Map<string, FeedRecord[]>()
    for (const feed of feeds) {
      const list = feedsByGroup.get(feed.groupId)
      if (list) {
        list.push(feed)
      } else {
        feedsByGroup.set(feed.groupId, [feed])
      }
    }

    const groupTree = buildGroupTree(groups)
    const outlines = groupTree.flatMap((node) => serializeGroupNode(node, feedsByGroup, attachInfo, '  '))

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0">',
      ' <head>',
      '  <title>OrigRead</title>',
      '  <dateCreated>' + escapeXml(new Date().toString()) + '</dateCreated>',
      ' </head>',
      ' <body>',
      ...outlines,
      ' </body>',
      '</opml>',
      ''
    ].join('\n')
  }
}

/** 序列化分组树节点为嵌套 outline。 */
function serializeGroupNode(
  node: GroupTreeNode,
  feedsByGroup: Map<string, FeedRecord[]>,
  attachInfo: boolean,
  indent: string
): string[] {
  const group = node.group
  const attrs: Record<string, string> = { text: group.name, title: group.name }
  if (attachInfo && group.isDefault) {
    attrs.isDefault = String(group.isDefault)
  }

  const groupFeeds = feedsByGroup.get(group.id) ?? []
  const feedLines = groupFeeds.map(
    (feed) => indent + '  <outline ' + serializeAttributes(feedAttributes(feed, attachInfo)) + ' />'
  )
  const childGroupLines = node.children.flatMap((child) =>
    serializeGroupNode(child, feedsByGroup, attachInfo, indent + '  ')
  )

  const allChildren = [...feedLines, ...childGroupLines]
  if (allChildren.length === 0) {
    return [indent + '<outline ' + serializeAttributes(attrs) + ' />']
  }
  return [
    indent + '<outline ' + serializeAttributes(attrs) + '>',
    ...allChildren,
    indent + '</outline>'
  ]
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
    id: 'feed-' + randomUUID(),
    accountId: options.group.accountId,
    groupId: options.group.id,
    name: source.name,
    url: options.url,
    sourcePageUrl: options.url,
    sourceType: 'rss',
    icon: null,
    isNotification: source.isNotification,
    isFullContent: source.isFullContent,
    isBrowser: source.isBrowser,
    dynamicRendering: false,
    createdAt: options.now,
    updatedAt: options.now
  }
}

function feedAttributes(feed: FeedRecord, attachInfo: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    text: feed.name,
    title: feed.name,
    type: 'rss',
    xmlUrl: feed.url,
    htmlUrl: feed.url
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
  return Object.entries(attributes)
    .map(([key, value]) => key + '="' + escapeXml(value) + '"')
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
