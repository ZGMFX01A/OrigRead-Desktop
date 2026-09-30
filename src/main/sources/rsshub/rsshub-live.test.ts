import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import { RssHubResolver } from './rsshub-resolver'
import { RssHubRouteMatcher } from './rsshub-route-matcher'
import { RssHubSettingsRepository } from './rsshub-settings-repository'

const liveDescribe = process.env.ORIGREAD_RSSHUB_LIVE === '1' ? describe : describe.skip

liveDescribe('RSSHub public-instance live acceptance', () => {
  it('keeps the reported routes usable and exercises several independent route families', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    const resolver = new RssHubResolver(new RssHubRouteMatcher([]), settings)
    const routes = [
      '/zhihu/hot',
      '/bilibili/user/dynamic/1161918898',
      '/tiddlywiki/releases',
      '/bilibili/hot-search',
      '/sspai/matrix',
      '/douban/movie/coming',
      '/telegram/blog',
      '/github/issue/DIYgod/RSSHub?filter_link=https%3A%2F%2Fgithub.com'
    ]
    const required = new Set(['/zhihu/hot', '/bilibili/user/dynamic/1161918898'])
    const usableFamilies = new Set<string>()

    try {
      for (const routePath of routes) {
        let results = await resolver.probeRoute(
          routePath,
          routePath === '/zhihu/hot' ? 'https://rsshub.app' : null
        )
        if (required.has(routePath) && !results.some((result) => result.available)) {
          results = await resolver.probeRoute(
            routePath,
            routePath === '/zhihu/hot' ? 'https://rsshub.app' : null
          )
        }
        const available = results.find((result) => result.available)
        if (available) usableFamilies.add(routeFamily(routePath))
        if (required.has(routePath)) {
          expect(
            available,
            `${routePath} has no usable instance: ${results.map((result) =>
              `${result.instanceBaseUrl ?? 'unknown'}:${result.state}:${result.message ?? ''}`).join(' | ')}`
          ).toBeDefined()
        }
      }
      expect([...usableFamilies].length).toBeGreaterThanOrEqual(3)
    } finally {
      database.close()
    }
  }, 180_000)
})

function routeFamily(routePath: string): string {
  return routePath.split('?')[0]!.split('/').filter(Boolean).slice(0, 3).join('/')
}
