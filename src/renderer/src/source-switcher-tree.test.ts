import { describe, expect, it } from 'vitest'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'
import {
  buildSourceSwitcherTree,
  getRecentSourceScopeItems,
  sanitizeOptionId
} from './source-switcher-tree'

function makeGroup(id: string, name: string, parentId: string | null = null, sortOrder = 0): GroupRecord {
  return {
    id,
    accountId: 1,
    name,
    parentId,
    sortOrder,
    isDefault: false
  }
}

function makeFeed(id: string, name: string, groupId: string, url = `https://example.com/${id}.xml`): FeedRecord {
  return {
    id,
    accountId: 1,
    groupId,
    name,
    url,
    sourcePageUrl: 'https://example.com',
    sourceType: 'rss',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: 1000,
    updatedAt: 1000
  }
}

describe('source-switcher-tree', () => {
  it('keeps remote Unicode IDs and punctuation distinct for keyboard targets', () => {
    const ids = ['user/科技', 'user/技术', 'user-科技', 'user_2f_科技', 'a/b', 'a-b']
    expect(new Set(ids.map(sanitizeOptionId)).size).toBe(ids.length)
  })
  const groups: GroupRecord[] = [
    makeGroup('tech', 'Tech/Dev', null, 0),
    makeGroup('frontend', 'Frontend', 'tech', 0),
    makeGroup('react', 'React Ecosystem', 'frontend', 0),
    makeGroup('design', 'Design', null, 1)
  ]

  const feeds: FeedRecord[] = [
    makeFeed('f-tech', 'Tech Weekly', 'tech'),
    makeFeed('f-fe', 'Frontend Focus', 'frontend'),
    makeFeed('f-react', 'React Official', 'react'),
    makeFeed('f-design', 'Design Digest', 'design'),
    makeFeed('f-orphan', 'Random Blog', 'unknown-group')
  ]

  const feedStats = new Map<string, FeedArticleStats>([
    ['f-tech', { feedId: 'f-tech', total: 10, unread: 2, starred: 0 }],
    ['f-fe', { feedId: 'f-fe', total: 5, unread: 3, starred: 0 }],
    ['f-react', { feedId: 'f-react', total: 8, unread: 4, starred: 0 }],
    ['f-design', { feedId: 'f-design', total: 20, unread: 1, starred: 0 }],
    ['f-orphan', { feedId: 'f-orphan', total: 2, unread: 0, starred: 0 }]
  ])

  describe('buildSourceSwitcherTree & Subtree Stats', () => {
    it('递归构建真实树并计算完整子树源数量与未读聚合', () => {
      const result = buildSourceSwitcherTree({
        groups,
        feeds,
        feedStatsById: feedStats,
        query: ''
      })

      expect(result.tree.length).toBe(2)
      const tech = result.tree[0]!
      expect(tech.id).toBe('tech')
      // tech 子树包含 tech(1) + frontend(1) + react(1) = 3 feeds
      expect(tech.totalFeeds).toBe(3)
      // unread: 2 + 3 + 4 = 9
      expect(tech.totalUnread).toBe(9)
      // 直属源仅直属渲染一次
      expect(tech.directFeeds.map((f) => f.id)).toEqual(['f-tech'])
      expect(tech.children.length).toBe(1)

      const frontend = tech.children[0]!
      expect(frontend.id).toBe('frontend')
      expect(frontend.totalFeeds).toBe(2)
      expect(frontend.totalUnread).toBe(7) // 3 + 4
      expect(frontend.directFeeds.map((f) => f.id)).toEqual(['f-fe'])
      expect(frontend.children.length).toBe(1)

      const react = frontend.children[0]!
      expect(react.id).toBe('react')
      expect(react.totalFeeds).toBe(1)
      expect(react.totalUnread).toBe(4)
      expect(react.directFeeds.map((f) => f.id)).toEqual(['f-react'])
      expect(react.children.length).toBe(0)

      // design
      const design = result.tree[1]!
      expect(design.id).toBe('design')
      expect(design.totalFeeds).toBe(1)
      expect(design.totalUnread).toBe(1)
      expect(design.directFeeds.map((f) => f.id)).toEqual(['f-design'])

      // ungrouped
      expect(result.ungrouped.map((f) => f.id)).toEqual(['f-orphan'])
      expect(result.visibleFeedCount).toBe(5)
    })

    it('不拆分含斜杠的分组名称', () => {
      const result = buildSourceSwitcherTree({
        groups,
        feeds,
        feedStatsById: feedStats,
        query: ''
      })
      expect(result.tree[0]!.name).toBe('Tech/Dev')
    })
  })

  describe('搜索纯 helper 过滤逻辑', () => {
    it('命中祖先分组名称时，保留其全部直属 feeds 与完整后代子树', () => {
      const result = buildSourceSwitcherTree({
        groups,
        feeds,
        feedStatsById: feedStats,
        query: 'tech'
      })

      expect(result.tree.length).toBe(1)
      const tech = result.tree[0]!
      expect(tech.id).toBe('tech')
      expect(tech.matchedBySelf).toBe(true)
      expect(tech.directFeeds.map((f) => f.id)).toEqual(['f-tech'])
      expect(tech.children.length).toBe(1)
      expect(tech.children[0]!.id).toBe('frontend')
      expect(tech.children[0]!.directFeeds.map((f) => f.id)).toEqual(['f-fe'])
      expect(tech.children[0]!.children[0]!.id).toBe('react')
      expect(tech.children[0]!.children[0]!.directFeeds.map((f) => f.id)).toEqual(['f-react'])
    })

    it('后代孙源命中时，保留祖先通路，且自身未命中的祖先直属源不展示', () => {
      const result = buildSourceSwitcherTree({
        groups,
        feeds,
        feedStatsById: feedStats,
        query: 'React Official'
      })

      expect(result.tree.length).toBe(1)
      const tech = result.tree[0]!
      expect(tech.id).toBe('tech')
      expect(tech.matchedBySelf).toBe(false)
      // 祖先直属源不匹配，因此 directFeeds 为空
      expect(tech.directFeeds).toEqual([])
      // 但祖先通路保留
      expect(tech.children.length).toBe(1)

      const frontend = tech.children[0]!
      expect(frontend.id).toBe('frontend')
      expect(frontend.directFeeds).toEqual([])
      expect(frontend.children.length).toBe(1)

      const react = frontend.children[0]!
      expect(react.id).toBe('react')
      expect(react.directFeeds.map((f) => f.id)).toEqual(['f-react'])

      // 父范围统计不随 query 缩水
      expect(tech.totalFeeds).toBe(3)
      expect(tech.totalUnread).toBe(9)
      expect(frontend.totalFeeds).toBe(2)
      expect(frontend.totalUnread).toBe(7)
    })

    it('无任何匹配时 tree 为空', () => {
      const result = buildSourceSwitcherTree({
        groups,
        feeds,
        feedStatsById: feedStats,
        query: 'non-existent-keyword'
      })
      expect(result.tree).toEqual([])
      expect(result.ungrouped).toEqual([])
      expect(result.hasResults).toBe(false)
      expect(result.visibleFeedCount).toBe(0)
    })
  })

  describe('getRecentSourceScopeItems', () => {
    it('正确生成最近分组完整路径与子树统计', () => {
      const recents = getRecentSourceScopeItems({
        recentScopeKeys: ['group:react', 'feed:f-react', 'feed:f-orphan'],
        groups,
        feeds,
        feedStatsById: feedStats,
        normalizedQuery: ''
      })

      expect(recents.length).toBe(3)
      const recentGroup = recents[0]!
      expect(recentGroup.kind).toBe('group')
      if (recentGroup.kind === 'group') {
        expect(recentGroup.fullLabel).toBe('Tech\\/Dev / Frontend / React Ecosystem')
        expect(recentGroup.totalFeeds).toBe(1)
        expect(recentGroup.totalUnread).toBe(4)
      }

      const recentFeed = recents[1]!
      expect(recentFeed.kind).toBe('feed')
      if (recentFeed.kind === 'feed') {
        expect(recentFeed.groupPath).toBe('Tech\\/Dev / Frontend / React Ecosystem')
        expect(recentFeed.fullSubtitle).toBe('Tech\\/Dev / Frontend / React Ecosystem · example.com')
      }

      const recentOrphan = recents[2]!
      expect(recentOrphan.kind).toBe('feed')
      if (recentOrphan.kind === 'feed') {
        expect(recentOrphan.groupPath).toBe('')
        expect(recentOrphan.fullSubtitle).toBe('example.com')
      }
    })

    it('搜索期间最近范围不展示', () => {
      const recents = getRecentSourceScopeItems({
        recentScopeKeys: ['group:react'],
        groups,
        feeds,
        feedStatsById: feedStats,
        normalizedQuery: 'some query'
      })
      expect(recents).toEqual([])
    })
  })

})
