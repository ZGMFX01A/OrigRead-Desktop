import { describe, expect, it } from 'vitest'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import {
  buildSourceSearchViewModel,
  computeGroupStatsById
} from './source-search-viewmodel'

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

describe('source-search-viewmodel', () => {
  const gTech = makeGroup('g-tech', 'Technology', null, 1)
  const gWeb = makeGroup('g-web', 'Web Dev', 'g-tech', 1)
  const gBackend = makeGroup('g-backend', 'Backend', 'g-tech', 2)
  const gEmpty = makeGroup('g-empty', 'Empty Category', null, 3)

  const feedTech = makeFeed('f-tech', 'Tech News', 'g-tech', 'https://tech.org/feed.xml')
  const feedReact = makeFeed('f-react', 'React Official', 'g-web', 'https://react.dev/feed.xml')
  const feedVue = makeFeed('f-vue', 'Vue News', 'g-web', 'https://vuejs.org/feed.xml')
  const feedGo = makeFeed('f-go', 'Go Blog', 'g-backend', 'https://go.dev/feed.xml')
  const feedUngrouped = makeFeed('f-ungrouped', 'Orphan Feed', 'unknown-group', 'https://orphan.org/rss')

  const allGroups = [gTech, gWeb, gBackend, gEmpty]
  const allFeeds = [feedTech, feedReact, feedVue, feedGo, feedUngrouped]

  describe('buildSourceSearchViewModel', () => {
    it('returns all groups (including empty ones) and ungrouped feeds when query is empty', () => {
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: ''
      })

      const groupIds = result.map((r) => r.group.id)
      expect(groupIds).toEqual(['g-tech', 'g-web', 'g-backend', 'g-empty', '__ungrouped__'])

      const emptyEntry = result.find((r) => r.group.id === 'g-empty')
      expect(emptyEntry?.feeds).toEqual([])

      const ungroupedEntry = result.find((r) => r.group.id === '__ungrouped__')
      expect(ungroupedEntry?.feeds).toEqual([feedUngrouped])
    })

    it('retains ancestor path when descendant feed matches, with ancestor only retaining direct matches', () => {
      // Searching for "Vue" matches feedVue under g-web, which is under g-tech
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'Vue'
      })

      const groupMap = new Map(result.map((r) => [r.group.id, r.feeds]))
      // g-tech is ancestor path node, has no direct matches, so feeds is empty
      expect(groupMap.has('g-tech')).toBe(true)
      expect(groupMap.get('g-tech')).toEqual([])

      // g-web has matching feed
      expect(groupMap.has('g-web')).toBe(true)
      expect(groupMap.get('g-web')?.map((f) => f.id)).toEqual(['f-vue'])

      // g-backend and g-empty have no matches and are pruned
      expect(groupMap.has('g-backend')).toBe(false)
      expect(groupMap.has('g-empty')).toBe(false)
      expect(groupMap.has('__ungrouped__')).toBe(false)
    })

    it('retains entire subtree and all direct feeds when group name matches', () => {
      // Searching for "Web Dev" matches g-web
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'Web Dev'
      })

      const groupMap = new Map(result.map((r) => [r.group.id, r.feeds]))
      // g-tech is ancestor path node
      expect(groupMap.has('g-tech')).toBe(true)
      expect(groupMap.get('g-tech')).toEqual([])

      // g-web matched by name, so ALL its direct feeds are kept (even React which does not say "Web Dev")
      expect(groupMap.has('g-web')).toBe(true)
      expect(groupMap.get('g-web')?.map((f) => f.id)).toEqual(['f-react', 'f-vue'])

      // g-backend is not under g-web, so pruned
      expect(groupMap.has('g-backend')).toBe(false)
    })

    it('retains entire tree when top root group name matches', () => {
      // Searching for "Technology" matches g-tech
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'Technology'
      })

      const groupMap = new Map(result.map((r) => [r.group.id, r.feeds]))
      expect(groupMap.has('g-tech')).toBe(true)
      expect(groupMap.get('g-tech')?.map((f) => f.id)).toEqual(['f-tech'])

      expect(groupMap.has('g-web')).toBe(true)
      expect(groupMap.get('g-web')?.map((f) => f.id)).toEqual(['f-react', 'f-vue'])

      expect(groupMap.has('g-backend')).toBe(true)
      expect(groupMap.get('g-backend')?.map((f) => f.id)).toEqual(['f-go'])

      // g-empty is a sibling root, does not match, so pruned
      expect(groupMap.has('g-empty')).toBe(false)
    })

    it('matches feeds by url as well as title', () => {
      // Searching for "react.dev"
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'react.dev'
      })

      const groupMap = new Map(result.map((r) => [r.group.id, r.feeds]))
      expect(groupMap.has('g-web')).toBe(true)
      expect(groupMap.get('g-web')?.map((f) => f.id)).toEqual(['f-react'])
    })

    it('keeps empty group visible if its name matches', () => {
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'Empty Category'
      })

      expect(result.length).toBe(1)
      expect(result[0]?.group.id).toBe('g-empty')
      expect(result[0]?.feeds).toEqual([])
    })

    it('handles ungrouped feeds when matched', () => {
      const result = buildSourceSearchViewModel({
        groups: allGroups,
        feeds: allFeeds,
        query: 'Orphan'
      })

      expect(result.length).toBe(1)
      expect(result[0]?.group.id).toBe('__ungrouped__')
      expect(result[0]?.feeds.map((f) => f.id)).toEqual(['f-ungrouped'])
    })
  })

  describe('computeGroupStatsById', () => {
    it('aggregates total feeds and total unread for self and all descendants with deduplication', () => {
      const feedStatsMap: Record<string, number> = {
        'f-tech': 2,
        'f-react': 5,
        'f-vue': 3,
        'f-go': 4,
        'f-ungrouped': 1
      }
      const getUnread = (id: string) => feedStatsMap[id] ?? 0

      const stats = computeGroupStatsById(allGroups, allFeeds, getUnread)

      // g-tech has self (f-tech: 2) + g-web (f-react: 5, f-vue: 3) + g-backend (f-go: 4) = 4 feeds, 14 unread
      const techStats = stats.get('g-tech')
      expect(techStats).toEqual({
        totalFeeds: 4,
        totalUnread: 14
      })

      // g-web has f-react + f-vue = 2 feeds, 8 unread
      const webStats = stats.get('g-web')
      expect(webStats).toEqual({
        totalFeeds: 2,
        totalUnread: 8
      })

      // g-empty has 0 feeds, 0 unread
      const emptyStats = stats.get('g-empty')
      expect(emptyStats).toEqual({
        totalFeeds: 0,
        totalUnread: 0
      })

      // __ungrouped__ has 1 feed, 1 unread
      const ungroupedStats = stats.get('__ungrouped__')
      expect(ungroupedStats).toEqual({
        totalFeeds: 1,
        totalUnread: 1
      })
    })
  })
})
