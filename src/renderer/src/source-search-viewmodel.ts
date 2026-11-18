import type { FeedRecord, GroupRecord } from '../../shared/library'
import { buildGroupTree, getGroupDescendantIds, type GroupTreeNode } from '../../shared/group-tree'

export interface SourceGroupEntry {
  group: GroupRecord
  feeds: FeedRecord[]
}

export interface BuildSourceSearchViewModelOptions {
  groups: readonly GroupRecord[]
  feeds: readonly FeedRecord[]
  query: string
  ungroupedGroupName?: string
}

export interface GroupTreeStats {
  totalFeeds: number
  totalUnread: number
}

/**
 * 递归收集节点及其所有后代的直属来源条目（全子树保留直属源）。
 */
function collectSubtreeEntries(
  node: GroupTreeNode<GroupRecord>,
  feedsByGroupId: Map<string, FeedRecord[]>
): SourceGroupEntry[] {
  const result: SourceGroupEntry[] = [
    {
      group: node.group,
      feeds: feedsByGroupId.get(node.id) ?? []
    }
  ]
  for (const child of node.children) {
    result.push(...collectSubtreeEntries(child, feedsByGroupId))
  }
  return result
}

/**
 * 构建来源树搜索视图模型：
 * 1. 无 query 时保留全部完整分组（含空父组）及直属来源，并在存在孤儿来源时挂载 __ungrouped__ 根；
 * 2. 有 query 时：
 *    - group.name 命中保留其全子树 + 全部直属 feed；
 *    - 仅某 feed 或后代组命中时保留祖先通路链，祖先仅保留通路组和直属匹配 feed；
 *    - 来源严格只在直属分组出现一次；
 *    - 未知 group feed 在有命中时保留在 __ungrouped__ 根。
 */
export function buildSourceSearchViewModel(
  options: BuildSourceSearchViewModelOptions
): SourceGroupEntry[] {
  const { groups, feeds, query, ungroupedGroupName } = options
  const normalizedQuery = query.trim().toLocaleLowerCase()

  // 1. 建立 groupId -> feeds 映射，保持稳定顺序
  const feedsByGroupId = new Map<string, FeedRecord[]>()
  for (const feed of feeds) {
    const list = feedsByGroupId.get(feed.groupId)
    if (list) {
      list.push(feed)
    } else {
      feedsByGroupId.set(feed.groupId, [feed])
    }
  }

  const knownGroupIds = new Set(groups.map((g) => g.id))
  const ungroupedFeeds = feeds.filter((f) => !knownGroupIds.has(f.groupId))

  // 2. 无 query：返回完整分组与完整直属源（含空组）
  if (!normalizedQuery) {
    const sortedGroups = groups
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))

    const result: SourceGroupEntry[] = sortedGroups.map((group) => ({
      group,
      feeds: feedsByGroupId.get(group.id) ?? []
    }))

    if (ungroupedFeeds.length > 0) {
      result.push({
        group: {
          id: '__ungrouped__',
          name: ungroupedGroupName ?? 'Ungrouped sources',
          sortOrder: Number.MAX_SAFE_INTEGER,
          isDefault: false
        },
        feeds: ungroupedFeeds
      })
    }
    return result
  }

  // 3. 有 query：按树结构自顶向下/自底向上裁剪
  const isFeedMatch = (feed: FeedRecord): boolean =>
    `${feed.name} ${feed.url}`.toLocaleLowerCase().includes(normalizedQuery)

  const treeRoots = buildGroupTree(groups)

  function processNode(
    node: GroupTreeNode<GroupRecord>,
    parentMatched: boolean
  ): SourceGroupEntry[] | null {
    // 若祖先已按组名命中，则全子树全直属源保留
    if (parentMatched) {
      return collectSubtreeEntries(node, feedsByGroupId)
    }

    const isSelfNameMatch = node.group.name.toLocaleLowerCase().includes(normalizedQuery)
    if (isSelfNameMatch) {
      // 当前组名命中：保留当前组自身及全子树全部直属 feed
      return collectSubtreeEntries(node, feedsByGroupId)
    }

    // 当前组名未命中：检查自身直属源匹配情况与子节点命中情况
    const directFeeds = feedsByGroupId.get(node.id) ?? []
    const matchingDirectFeeds = directFeeds.filter(isFeedMatch)

    const childEntries: SourceGroupEntry[] = []
    for (const child of node.children) {
      const entries = processNode(child, false)
      if (entries) {
        childEntries.push(...entries)
      }
    }

    if (matchingDirectFeeds.length > 0 || childEntries.length > 0) {
      // 作为通路组或自身有直属匹配源：保留自身（仅匹配直属源）及子树通路
      return [{ group: node.group, feeds: matchingDirectFeeds }, ...childEntries]
    }

    return null
  }

  const result: SourceGroupEntry[] = []
  for (const root of treeRoots) {
    const entries = processNode(root, false)
    if (entries) {
      result.push(...entries)
    }
  }

  // 处理未分组来源
  if (ungroupedFeeds.length > 0) {
    const ungroupedNameMatch = (ungroupedGroupName ?? '').toLocaleLowerCase().includes(normalizedQuery)
    const matchingUngrouped = ungroupedNameMatch
      ? ungroupedFeeds
      : ungroupedFeeds.filter(isFeedMatch)

    if (matchingUngrouped.length > 0) {
      result.push({
        group: {
          id: '__ungrouped__',
          name: ungroupedGroupName ?? 'Ungrouped sources',
          sortOrder: Number.MAX_SAFE_INTEGER,
          isDefault: false
        },
        feeds: matchingUngrouped
      })
    }
  }

  return result
}

/**
 * 从完整分组树与完整来源统计各分组展示指标（self + 所有后代，源仅出现一次）。
 * 搜索期间分组按钮展示完整范围统计，而非 query 缩小后的子集。
 */
export function computeGroupStatsById(
  groups: readonly GroupRecord[],
  feeds: readonly FeedRecord[],
  getFeedUnread: (feedId: string) => number
): Map<string, GroupTreeStats> {
  const statsMap = new Map<string, GroupTreeStats>()

  const feedsByGroupId = new Map<string, FeedRecord[]>()
  for (const feed of feeds) {
    const list = feedsByGroupId.get(feed.groupId)
    if (list) {
      list.push(feed)
    } else {
      feedsByGroupId.set(feed.groupId, [feed])
    }
  }

  for (const group of groups) {
    let descendantIds: string[] = []
    try {
      descendantIds = getGroupDescendantIds(group.id, groups)
    } catch {
      descendantIds = []
    }
    const targetGroupIds = [group.id, ...descendantIds]
    const seenFeedIds = new Set<string>()
    let totalUnread = 0

    for (const gid of targetGroupIds) {
      const groupFeeds = feedsByGroupId.get(gid) ?? []
      for (const feed of groupFeeds) {
        if (!seenFeedIds.has(feed.id)) {
          seenFeedIds.add(feed.id)
          totalUnread += getFeedUnread(feed.id)
        }
      }
    }

    statsMap.set(group.id, {
      totalFeeds: seenFeedIds.size,
      totalUnread
    })
  }

  const knownGroupIds = new Set(groups.map((g) => g.id))
  const ungroupedFeeds = feeds.filter((f) => !knownGroupIds.has(f.groupId))
  if (ungroupedFeeds.length > 0) {
    const seenFeedIds = new Set<string>()
    let totalUnread = 0
    for (const feed of ungroupedFeeds) {
      if (!seenFeedIds.has(feed.id)) {
        seenFeedIds.add(feed.id)
        totalUnread += getFeedUnread(feed.id)
      }
    }
    statsMap.set('__ungrouped__', {
      totalFeeds: seenFeedIds.size,
      totalUnread
    })
  }

  return statsMap
}
