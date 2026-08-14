import { describe, expect, it } from 'vitest'
import type { RssHubRouteDefinition } from '../../../shared/rsshub'
import {
  matchRssHubRoutes,
  normalizeRssHubInstanceUrl,
  rssHubParameterMatches
} from './rsshub-route-matcher'
import { defaultRssHubInstances, orderRssHubInstances } from './rsshub-settings-repository'

const clsRoutes: RssHubRouteDefinition[] = [
  {
    id: 'cls-telegraph',
    name: '电报',
    host: 'cls.cn',
    pathPrefix: '/telegraph',
    target: '/cls/telegraph'
  },
  {
    id: 'cls-hot',
    name: '热门文章排行榜',
    host: 'cls.cn',
    pathPrefix: '/',
    target: '/cls/hot'
  }
]

describe('RssHubRouteMatcher Android parity', () => {
  it('prefers the more specific path route and normalizes www host', () => {
    const result = matchRssHubRoutes(
      'https://www.cls.cn/telegraph',
      clsRoutes,
      'https://rsshub.example.com/'
    )
    expect(result[0]?.route.name).toBe('电报')
    expect(result[0]?.feedUrl).toBe('https://rsshub.example.com/cls/telegraph')
  })

  it('does not match unrelated hosts', () => {
    expect(matchRssHubRoutes(
      'https://example.com/telegraph',
      clsRoutes,
      'https://rsshub.example.com'
    )).toEqual([])
  })

  it('extracts and percent-encodes a dynamic path parameter', () => {
    const route: RssHubRouteDefinition = {
      id: 'dianping-user',
      name: '用户点评',
      host: 'dianping.com',
      pathPrefix: '/member',
      target: '/dianping/user/:id',
      sourcePathTemplate: '/member/:id'
    }
    const result = matchRssHubRoutes(
      'https://www.dianping.com/member/用户-123',
      [route],
      'https://rsshub.example.com'
    )[0]!
    expect(result.resolved).toBe(true)
    expect(result.parameters.id).toBe('用户-123')
    expect(result.feedUrl).toBe('https://rsshub.example.com/dianping/user/%E7%94%A8%E6%88%B7-123')
  })

  it('supports query parameters and returns missing parameters without a request URL', () => {
    const route: RssHubRouteDefinition = {
      id: 'query',
      name: '频道',
      host: 'example.com',
      pathPrefix: '/channel',
      target: '/example/channel/:id',
      sourcePathTemplate: '/channel',
      sourceQueryTemplate: 'id=:id'
    }
    expect(matchRssHubRoutes(
      'https://example.com/channel?id=42',
      [route],
      'https://rsshub.example.com'
    )[0]).toMatchObject({ resolved: true, parameters: { id: '42' } })

    const missing = matchRssHubRoutes(
      'https://example.com/channel',
      [route],
      'https://rsshub.example.com'
    )[0]!
    expect(missing.resolved).toBe(false)
    expect(missing.feedUrl).toBeNull()
    expect(missing.missingParameters).toEqual(['id'])
  })

  it('omits a missing optional target segment', () => {
    const route: RssHubRouteDefinition = {
      id: 'optional',
      name: '可选分类',
      host: 'example.com',
      pathPrefix: '/posts',
      target: '/example/posts/:category?',
      sourcePathTemplate: '/posts/:category?'
    }
    expect(matchRssHubRoutes(
      'https://example.com/posts',
      [route],
      'https://rsshub.example.com'
    )[0]?.feedUrl).toBe('https://rsshub.example.com/example/posts')
  })

  it('rejects encoded path injection and oversized path segments', () => {
    const route: RssHubRouteDefinition = {
      id: 'unsafe',
      name: '不安全参数',
      host: 'example.com',
      pathPrefix: '/user',
      target: '/example/user/:id',
      sourcePathTemplate: '/user/:id'
    }
    expect(matchRssHubRoutes(
      'https://example.com/user/a%2Fb',
      [route],
      'https://rsshub.example.com'
    )).toEqual([])
    expect(matchRssHubRoutes(
      `https://example.com/user/${'a'.repeat(300)}`,
      [route],
      'https://rsshub.example.com'
    )).toEqual([])
  })

  it('only evaluates Android-supported numeric and literal-enum constraints', () => {
    expect(rssHubParameterMatches('123', '\\d+')).toBe(true)
    expect(rssHubParameterMatches('abc', '\\d+')).toBe(false)
    expect(rssHubParameterMatches('hot', 'hot|new')).toBe(true)
    expect(rssHubParameterMatches('other', 'hot|new')).toBe(false)
    expect(rssHubParameterMatches('anything', '(?<arbitrary>.*)')).toBe(true)
  })

  it('keeps Android instance normalization, order and built-in list size', () => {
    expect(orderRssHubInstances(
      'https://backup.example.com/',
      'backup.example.com',
      'https://rsshub.app'
    )).toEqual(['https://backup.example.com', 'https://rsshub.app'])
    expect(normalizeRssHubInstanceUrl('rsshub.app/')).toBe('https://rsshub.app')
    const urls = defaultRssHubInstances().map((item) => item.url)
    expect(urls).toHaveLength(16)
    expect(urls).toContain('https://rsshub.umzzz.com')
    expect(urls).toContain('https://rsshub-balancer.virworks.moe')
  })
})
