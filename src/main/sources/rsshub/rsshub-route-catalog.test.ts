import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { loadRssHubRoutes } from './rsshub-route-catalog'
import { matchRssHubRoutes } from './rsshub-route-matcher'

describe('RSSHub bundled route catalog', () => {
  it('loads the same schema-2 data asset copied from Android', () => {
    const routes = loadRssHubRoutes(resolve('resources/rsshub_routes.json'))
    expect(routes.length).toBeGreaterThan(1_000)
    expect(routes.some((route) => route.host === 'cls.cn' && route.target.startsWith('/cls/'))).toBe(true)
    expect(routes.some((route) => route.sourcePathTemplate || route.sourceQueryTemplate)).toBe(true)

    const clsMatches = matchRssHubRoutes(
      'https://www.cls.cn/',
      routes,
      'https://rsshub.example.com',
      8
    )
    expect(clsMatches.some((match) => match.route.target === '/cls/hot' && match.resolved)).toBe(true)
    expect(clsMatches.some((match) => match.route.target === '/cls/telegraph' && match.resolved)).toBe(true)
    expect(clsMatches.filter((match) => match.resolved).every((match) => match.feedUrl?.startsWith('https://rsshub.example.com/cls/'))).toBe(true)
  })
})
