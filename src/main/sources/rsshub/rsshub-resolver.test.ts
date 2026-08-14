import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubRouteDefinition } from '../../../shared/rsshub'
import { RssHubResolver } from './rsshub-resolver'
import { RssHubRouteMatcher } from './rsshub-route-matcher'
import { RssHubSettingsRepository } from './rsshub-settings-repository'

const dynamicRoute: RssHubRouteDefinition = {
  id: 'dynamic-user',
  name: 'Dynamic user',
  host: 'example.com',
  pathPrefix: '/user',
  target: '/example/user/:id',
  sourcePathTemplate: '/user/:id'
}

describe('RssHubResolver Android parity', () => {
  it('does not send a request for unresolved routes', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    let requests = 0
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async () => {
        requests += 1
        return fakeFeed()
      }
    )
    try {
      const result = await resolver.probe('https://example.com/user', 'https://rsshub.example.com')
      expect(result[0]?.state).toBe('needs_input')
      expect(result[0]?.match.missingParameters).toEqual(['id'])
      expect(requests).toBe(0)
    } finally {
      database.close()
    }
  })

  it('falls back to the next instance after a network failure and preserves dynamic parameters', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    settings.restoreDefault()
    const defaults = settings.current().instances
    settings.setEnabled(true)
    for (const item of defaults) settings.setInstanceEnabled(item.id, false)
    settings.addInstance('https://first.example.com')
    settings.addInstance('https://second.example.com')

    const requested: string[] = []
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async (feedUrl) => {
        requested.push(feedUrl)
        if (feedUrl.startsWith('https://first.example.com')) throw new TypeError('fetch failed')
        return fakeFeed()
      }
    )
    try {
      const result = await resolver.probe('https://example.com/user/42')
      expect(result).toHaveLength(1)
      expect(result[0]?.available).toBe(true)
      expect(result[0]?.match.feedUrl).toBe('https://second.example.com/example/user/42')
      expect(result[0]?.match.parameters.id).toBe('42')
      expect(requested).toEqual([
        'https://first.example.com/example/user/42',
        'https://second.example.com/example/user/42'
      ])
      expect(settings.candidateInstances()[0]).toBe('https://second.example.com')
    } finally {
      database.close()
    }
  })
})

function fakeFeed(): DiscoveredRssFeed {
  return {
    feedUrl: 'https://rsshub.example.com/example/user/42',
    sourcePageUrl: 'https://example.com/user/42',
    discoveredFromPage: false,
    title: 'RSSHub source',
    siteUrl: null,
    iconUrl: null,
    items: []
  }
}
