import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'
import { buildGroupTree, type GroupTreeNode } from '../../shared/group-tree'
import { formatGroupDisplayPath } from './group-display-path'

export interface SourceSwitcherGroupNode {
  id: string
  name: string
  group: GroupRecord
  parentId: string | null
  depth: number
  /** 当前分组直属的 Feeds（根据搜索已过滤） */
  directFeeds: FeedRecord[]
  /** 子分组（根据搜索已过滤） */
  children: SourceSwitcherGroupNode[]
  /** 完整子树（自身 + 所有后代分组）的 Feed 总数（不随搜索 query 缩水） */
  totalFeeds: number
  /** 完整子树的未读总数（不随搜索 query 缩水） */
  totalUnread: number
  /** 自身名称是否直接匹配 query */
  matchedBySelf: boolean
}

export interface SourceSwitcherTreeResult {
  tree: SourceSwitcherGroupNode[]
  ungrouped: FeedRecord[]
  visibleFeedCount: number
  hasResults: boolean
}

export interface SubtreeStats {
  totalFeeds: number
  totalUnread: number
}

/** 提取主机名，用于展示简短 host 避免撑爆切换器 */
export function feedHost(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** 检查单个源是否命中搜索 query（匹配名称或 host） */
export function feedMatchesQuery(feed: FeedRecord, query: string): boolean {
  if (!query) return true
  const q = query.toLocaleLowerCase()
  return `${feed.name} ${feedHost(feed.url)}`.toLocaleLowerCase().includes(q)
}

/** 清洗 ID 用于 DOM 元素 ID */
export function sanitizeOptionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, character => `_${character.charCodeAt(0).toString(16)}_`)
}

/**
 * 递归自底向上计算分组树中每个节点的完整子树（self + 后代）统计信息。
 * 统计包含子树内所有去重源数量与未读数总和，且不受搜索 query 影响。
 */
export function computeSubtreeStatsMap(
  rawRoots: readonly GroupTreeNode<GroupRecord>[],
  directFeedsMap: ReadonlyMap<string, FeedRecord[]>,
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
): Map<string, SubtreeStats> {
  const statsMap = new Map<string, SubtreeStats>()

  interface InternalStats {
    feedIds: Set<string>
    totalUnread: number
  }

  function walk(node: GroupTreeNode<GroupRecord>): InternalStats {
    const feedIds = new Set<string>()
    let totalUnread = 0

    const direct = directFeedsMap.get(node.id) ?? []
    for (const feed of direct) {
      if (!feedIds.has(feed.id)) {
        feedIds.add(feed.id)
        totalUnread += feedStatsById.get(feed.id)?.unread ?? 0
      }
    }

    for (const child of node.children) {
      const childStats = walk(child)
      for (const id of childStats.feedIds) {
        if (!feedIds.has(id)) {
          feedIds.add(id)
          totalUnread += feedStatsById.get(id)?.unread ?? 0
        }
      }
    }

    statsMap.set(node.id, {
      totalFeeds: feedIds.size,
      totalUnread
    })

    return { feedIds, totalUnread }
  }

  for (const root of rawRoots) {
    walk(root)
  }

  return statsMap
}

/**
 * 构建并过滤来源切换器分组树：
 * 1. 使用共享 buildGroupTree 获得标准树结构（防止环并支持孤儿分组兜底）。
 * 2. 计算完整子树统计信息（父范围统计用完整后代集，不随 query 缩水）。
 * 3. 搜索纯 helper 过滤：
 *    - 命中 group.name 含其全部子树和直属 feed；
 *    - 后代组/源命中保留祖先通路；
 *    - 来源树中仅直属渲染一次。
 */
export function buildSourceSwitcherTree(params: {
  groups: readonly GroupRecord[]
  feeds: readonly FeedRecord[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  query: string
  maxDepth?: number
}): SourceSwitcherTreeResult {
  const { groups, feeds, feedStatsById, query, maxDepth } = params
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const directFeedsMap = new Map<string, FeedRecord[]>()
  for (const feed of feeds) {
    const list = directFeedsMap.get(feed.groupId)
    if (list) {
      list.push(feed)
    } else {
      directFeedsMap.set(feed.groupId, [feed])
    }
  }

  const knownGroupIds = new Set(groups.map((group) => group.id))
  const allUngroupedFeeds = feeds.filter((feed) => !knownGroupIds.has(feed.groupId))

  const rawRoots = buildGroupTree(groups, { maxDepth })
  const statsMap = computeSubtreeStatsMap(rawRoots, directFeedsMap, feedStatsById)

  function filterNode(
    node: GroupTreeNode<GroupRecord>,
    parentMatched: boolean
  ): SourceSwitcherGroupNode | null {
    const stats = statsMap.get(node.id) ?? { totalFeeds: 0, totalUnread: 0 }
    const isGroupMatched = normalizedQuery.length > 0 && node.name.toLocaleLowerCase().includes(normalizedQuery)
    const effectiveMatched = parentMatched || isGroupMatched

    const allDirect = directFeedsMap.get(node.id) ?? []

    if (effectiveMatched) {
      // 命中自身或祖先：含全部直属 feeds 与全部后代子树
      const directFeeds = allDirect
      const children = node.children
        .map((child) => filterNode(child, true))
        .filter((c): c is SourceSwitcherGroupNode => c !== null)
      return {
        id: node.id,
        name: node.name,
        group: node.group,
        parentId: node.parentId,
        depth: node.depth,
        directFeeds,
        children,
        totalFeeds: stats.totalFeeds,
        totalUnread: stats.totalUnread,
        matchedBySelf: isGroupMatched
      }
    }

    if (!normalizedQuery) {
      // 无搜索：返回完整树
      return {
        id: node.id,
        name: node.name,
        group: node.group,
        parentId: node.parentId,
        depth: node.depth,
        directFeeds: allDirect,
        children: node.children
          .map((child) => filterNode(child, false))
          .filter((c): c is SourceSwitcherGroupNode => c !== null),
        totalFeeds: stats.totalFeeds,
        totalUnread: stats.totalUnread,
        matchedBySelf: false
      }
    }

    // 搜索中且自身未命中：过滤直属 feeds，并递归检查子节点
    const matchingDirectFeeds = allDirect.filter((feed) => feedMatchesQuery(feed, normalizedQuery))
    const matchingChildren = node.children
      .map((child) => filterNode(child, false))
      .filter((c): c is SourceSwitcherGroupNode => c !== null)

    if (matchingDirectFeeds.length > 0 || matchingChildren.length > 0) {
      // 后代组或源命中：保留祖先通路
      return {
        id: node.id,
        name: node.name,
        group: node.group,
        parentId: node.parentId,
        depth: node.depth,
        directFeeds: matchingDirectFeeds,
        children: matchingChildren,
        totalFeeds: stats.totalFeeds,
        totalUnread: stats.totalUnread,
        matchedBySelf: false
      }
    }

    return null
  }

  const tree = rawRoots
    .map((root) => filterNode(root, false))
    .filter((n): n is SourceSwitcherGroupNode => n !== null)

  const ungrouped = normalizedQuery
    ? allUngroupedFeeds.filter((feed) => feedMatchesQuery(feed, normalizedQuery))
    : allUngroupedFeeds

  const visibleFeedCount = countVisibleFeeds(tree, ungrouped)
  const hasResults = tree.length > 0 || ungrouped.length > 0

  return {
    tree,
    ungrouped,
    visibleFeedCount,
    hasResults
  }
}

/** 统计树结构中所有可见的直属源与未分组源总数 */
export function countVisibleFeeds(
  tree: readonly SourceSwitcherGroupNode[],
  ungrouped: readonly FeedRecord[]
): number {
  let count = ungrouped.length
  function walk(node: SourceSwitcherGroupNode): void {
    count += node.directFeeds.length
    for (const child of node.children) {
      walk(child)
    }
  }
  for (const node of tree) {
    walk(node)
  }
  return count
}

export type RecentSourceScopeItem =
  | {
      key: string
      kind: 'group'
      group: GroupRecord
      fullLabel: string
      totalFeeds: number
      totalUnread: number
    }
  | {
      key: string
      kind: 'feed'
      feed: FeedRecord
      groupPath: string
      host: string
      fullSubtitle: string
    }

/**
 * 解析最近使用 Scope 列表，附加完整路径与统计信息：
 * - 最近分组：显示完整父路径（如 Tech / Backend），聚合后代未读与源数量；
 * - 最近源：附加所属完整分组路径，便于同名或多层级源区分。
 */
export function getRecentSourceScopeItems(params: {
  recentScopeKeys: readonly string[]
  groups: readonly GroupRecord[]
  feeds: readonly FeedRecord[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  normalizedQuery: string
}): RecentSourceScopeItem[] {
  const { recentScopeKeys, groups, feeds, feedStatsById, normalizedQuery } = params
  if (normalizedQuery) return []

  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const feedsById = new Map(feeds.map((feed) => [feed.id, feed]))

  // 预先建立 groups 的 subtreeStatsMap，以提供真实层级聚合统计
  const directFeedsMap = new Map<string, FeedRecord[]>()
  for (const feed of feeds) {
    const list = directFeedsMap.get(feed.groupId)
    if (list) {
      list.push(feed)
    } else {
      directFeedsMap.set(feed.groupId, [feed])
    }
  }
  const rawRoots = buildGroupTree(groups)
  const statsMap = computeSubtreeStatsMap(rawRoots, directFeedsMap, feedStatsById)

  return recentScopeKeys.reduce<RecentSourceScopeItem[]>((result, key) => {
    const separator = key.indexOf(':')
    if (separator <= 0) return result
    const kind = key.slice(0, separator)
    const id = key.slice(separator + 1)

    if (kind === 'group') {
      const group = groupsById.get(id)
      if (group) {
        const fullLabel = formatGroupDisplayPath(group.id, groups, { fallbackName: group.name })
        const stats = statsMap.get(group.id) ?? {
          totalFeeds: directFeedsMap.get(group.id)?.length ?? 0,
          totalUnread: (directFeedsMap.get(group.id) ?? []).reduce(
            (sum, f) => sum + (feedStatsById.get(f.id)?.unread ?? 0),
            0
          )
        }
        result.push({
          key,
          kind: 'group',
          group,
          fullLabel,
          totalFeeds: stats.totalFeeds,
          totalUnread: stats.totalUnread
        })
      }
      return result
    }

    if (kind === 'feed') {
      const feed = feedsById.get(id)
      if (feed) {
        const groupPath = feed.groupId ? formatGroupDisplayPath(feed.groupId, groups) : ''
        const host = feedHost(feed.url)
        const fullSubtitle = groupPath ? `${groupPath} · ${host}` : host
        result.push({
          key,
          kind: 'feed',
          feed,
          groupPath,
          host,
          fullSubtitle
        })
      }
      return result
    }

    return result
  }, [])
}
