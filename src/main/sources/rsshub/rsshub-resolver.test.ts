import { describe, expect, it, vi } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubRouteDefinition } from '../../../shared/rsshub'
import { FeedFetchError, RssHubResolver } from './rsshub-resolver'
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
  it('does not record a success if the caller cancels as the feed probe completes', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    const controller = new AbortController()
    const success = vi.spyOn(settings, 'recordSuccess')
    try {
      const resolver = new RssHubResolver(new RssHubRouteMatcher([]), settings, async () => {
        await Promise.resolve()
        controller.abort(new Error('cancel route'))
        return fakeFeed()
      })
      await expect(resolver.probeRoute('/zhihu/hot', 'https://one.example.com', controller.signal)).rejects.toThrow('cancel route')
      expect(success).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it.each([403, 404, 503])('does not cool the entire instance for a typed HTTP %s route failure', async (status) => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    settings.restore({ enabled: true, instances: [{ id: 'one', url: 'https://one.example.com', enabled: true, builtIn: false, location: '', maintainer: '' }] })
    const recordFailure = vi.spyOn(settings, 'recordFailure')
    try {
      const resolver = new RssHubResolver(new RssHubRouteMatcher([]), settings, async () => {
        throw new FeedFetchError('http_error', status, `HTTP ${status}`)
      })
      expect((await resolver.probeRoute('/zhihu/hot'))[0]).toMatchObject({ statusCode: status, failureReason: 'http_error' })
      expect(recordFailure).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('parses a direct logical route using only the feed request, without favicon discovery', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    const instance = 'https://hub.example.com'
    settings.restore({ enabled: true, instances: [{ id: 'one', url: instance, enabled: true, builtIn: false, location: '', maintainer: '' }] })
    const fetcher = vi.fn(async () => new Response('<rss version="2.0"><channel><title>RSSHub</title><link>https://example.com</link><description>Feed</description></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const resolver = new RssHubResolver(new RssHubRouteMatcher([]), settings)
      const result = await resolver.probeRoute('/bilibili/user/dynamic/42')
      expect(result[0]?.available).toBe(true)
      expect(fetcher.mock.calls.map((call) => (call as unknown[])[0])).toEqual([`${instance}/bilibili/user/dynamic/42`])
      expect(result[0]?.feed?.sourcePageUrl).toBe(`${instance}/bilibili/user/dynamic/42`)
    } finally {
      vi.unstubAllGlobals()
      database.close()
    }
  })

  it('classifies the transport cause of a native fetch failure', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    try {
      const resolver = new RssHubResolver(new RssHubRouteMatcher([]), settings, async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
      })
      expect((await resolver.probeRoute('/zhihu/hot', 'https://one.example.com'))[0]?.failureReason).toBe('dns_failure')
    } finally {
      database.close()
    }
  })

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
      expect(requested).toEqual(expect.arrayContaining([
        'https://first.example.com/example/user/42',
        'https://second.example.com/example/user/42'
      ]))
      expect(settings.candidateInstances()[0]).toBe('https://second.example.com')
    } finally {
      database.close()
    }
  })

  it('probes backup instances in parallel and cancels slower peers after success', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    settings.restoreDefault()
    const defaults = settings.current().instances
    settings.setEnabled(true)
    for (const item of defaults) settings.setInstanceEnabled(item.id, false)
    settings.addInstance('https://first.example.com')
    settings.addInstance('https://second.example.com')

    const events: string[] = []
    let firstAborted = false
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async (feedUrl, _sourceUrl, signal) => {
        if (feedUrl.startsWith('https://first.example.com')) {
          events.push('first:start')
          return new Promise<DiscoveredRssFeed>((_resolve, reject) => {
            if (!signal) return reject(new Error('missing abort signal'))
            const onAbort = (): void => {
              firstAborted = true
              events.push('first:abort')
              reject(signal.reason)
            }
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          })
        }
        events.push('second:start')
        return fakeFeed()
      }
    )

    try {
      const result = await resolver.probe('https://example.com/user/42')
      await Promise.resolve()
      expect(events.slice(0, 2)).toEqual(['first:start', 'second:start'])
      expect(firstAborted).toBe(true)
      expect(result[0]?.match.feedUrl).toBe('https://second.example.com/example/user/42')
      expect(settings.candidateInstances()[0]).toBe('https://second.example.com')
    } finally {
      database.close()
    }
  })

  it('probes a logical route across instances and records the resolved physical instance', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    for (const item of settings.current().instances) settings.setInstanceEnabled(item.id, false)
    settings.addInstance('https://first.example.com')
    settings.addInstance('https://second.example.com')
    const requested: string[] = []
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([]),
      settings,
      async (feedUrl) => {
        requested.push(feedUrl)
        if (feedUrl.startsWith('https://first.example.com')) throw new TypeError('fetch failed')
        return { ...fakeFeed(), feedUrl }
      }
    )

    try {
      const routePath = '/bilibili/user/dynamic/1161918898'
      const result = await resolver.probeRoute(routePath, 'https://first.example.com')
      const available = result.find((item) => item.available)
      expect(available).toMatchObject({
        routePath,
        instanceBaseUrl: 'https://second.example.com'
      })
      expect(available?.match.feedUrl).toBe(`https://second.example.com${routePath}`)
      expect(requested).toEqual(expect.arrayContaining([
        `https://first.example.com${routePath}`,
        `https://second.example.com${routePath}`
      ]))
    } finally {
      database.close()
    }
  })

  it('cools an instance on HTTP 429 but not on an ordinary HTTP route failure', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    for (const item of settings.current().instances) settings.setInstanceEnabled(item.id, false)
    const limited = 'https://limited.example.com'
    settings.addInstance(limited)
    const recordFailure = vi.spyOn(settings, 'recordFailure')

    try {
      const limitedResolver = new RssHubResolver(
        new RssHubRouteMatcher([]),
        settings,
        async () => { throw new Error('HTTP 429') }
      )
      const limitedResult = await limitedResolver.probeRoute('/zhihu/hot')
      expect(limitedResult[0]).toMatchObject({ statusCode: 429, state: 'invalid_content' })
      expect(recordFailure).toHaveBeenCalledWith(limited)

      recordFailure.mockClear()
      const routeFailureResolver = new RssHubResolver(
        new RssHubRouteMatcher([]),
        settings,
        async () => { throw new Error('HTTP 503') }
      )
      const routeFailureResult = await routeFailureResolver.probeRoute('/zhihu/hot')
      expect(routeFailureResult[0]).toMatchObject({ statusCode: 503, state: 'invalid_content' })
      expect(recordFailure).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('aborts the active RSSHub probe when the total probe budget expires', async () => {
    vi.useFakeTimers()
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    let aborted = false
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async (_feedUrl, _sourceUrl, signal) => new Promise<DiscoveredRssFeed>((_resolve, reject) => {
        if (!signal) return reject(new Error('missing abort signal'))
        const onAbort = (): void => {
          aborted = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    )
    try {
      const pending = resolver.probe('https://example.com/user/42', 'https://rsshub.example.com')
      await vi.advanceTimersByTimeAsync(12_000)
      const result = await pending

      expect(aborted).toBe(true)
      expect(result).toHaveLength(1)
      expect(result[0]?.state).toBe('timeout')
    } finally {
      vi.useRealTimers()
      database.close()
    }
  })

  it('propagates an outer cancellation instead of converting it to a timeout diagnostic', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    const controller = new AbortController()
    let aborted = false
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async (_feedUrl, _sourceUrl, signal) => new Promise<DiscoveredRssFeed>((_resolve, reject) => {
        if (!signal) return reject(new Error('missing abort signal'))
        const onAbort = (): void => {
          aborted = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    )
    try {
      const pending = resolver.probe('https://example.com/user/42', 'https://rsshub.example.com', controller.signal)
      await Promise.resolve()
      controller.abort(new Error('cancel rsshub probe'))

      await expect(pending).rejects.toThrow('cancel rsshub probe')
      expect(aborted).toBe(true)
    } finally {
      database.close()
    }
  })

  it('keeps locally matched routes visible when RSSHub is disabled', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    settings.setEnabled(false)
    let requests = 0
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async () => { requests += 1; return fakeFeed() }
    )
    try {
      const result = await resolver.probe('https://example.com/user/42')
      expect(result).toHaveLength(1)
      expect(result[0]?.state).toBe('unsupported')
      expect(result[0]?.match.feedUrl).toBe('https://rsshub.app/example/user/42')
      expect(requests).toBe(0)
    } finally {
      database.close()
    }
  })

  it('keeps locally matched routes visible when no instance is enabled', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    for (const instance of settings.current().instances) settings.setInstanceEnabled(instance.id, false)
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async () => fakeFeed()
    )
    try {
      const result = await resolver.probe('https://example.com/user/42')
      expect(result).toHaveLength(1)
      expect(result[0]?.state).toBe('unsupported')
      expect(result[0]?.match.route.id).toBe('dynamic-user')
    } finally {
      database.close()
    }
  })

  it('returns local route diagnostics without making a network request', () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    let requests = 0
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher([dynamicRoute]),
      settings,
      async () => { requests += 1; return fakeFeed() }
    )
    try {
      const result = resolver.localRouteDiagnostics('https://example.com/user/42')
      expect(result).toHaveLength(1)
      expect(result[0]?.state).toBe('network_unavailable')
      expect(result[0]?.match.feedUrl).toBe('https://rsshub.app/example/user/42')
      expect(requests).toBe(0)
    } finally {
      database.close()
    }
  })

  it('merges different routes that are available on different instances', async () => {
    const database = new DesktopDatabase(':memory:')
    const settings = new RssHubSettingsRepository(database.connection)
    settings.restoreDefault()
    const defaults = settings.current().instances
    for (const item of defaults) settings.setInstanceEnabled(item.id, false)
    settings.addInstance('https://first.example.com')
    settings.addInstance('https://second.example.com')
    const routes: RssHubRouteDefinition[] = [
      { id: 'hot', name: 'Hot', host: 'example.com', pathPrefix: '/', target: '/example/hot' },
      { id: 'telegraph', name: 'Telegraph', host: 'example.com', pathPrefix: '/', target: '/example/telegraph' }
    ]
    const resolver = new RssHubResolver(
      new RssHubRouteMatcher(routes),
      settings,
      async (feedUrl) => {
        const succeeds = feedUrl === 'https://first.example.com/example/hot'
          || feedUrl === 'https://second.example.com/example/telegraph'
        if (!succeeds) throw new TypeError('fetch failed')
        return { ...fakeFeed(), feedUrl }
      }
    )

    try {
      const result = (await resolver.probe('https://example.com/')).filter((item) => item.available)
      expect(result.map((item) => item.match.route.id).sort()).toEqual(['hot', 'telegraph'])
      expect(result.find((item) => item.match.route.id === 'hot')?.match.feedUrl)
        .toBe('https://first.example.com/example/hot')
      expect(result.find((item) => item.match.route.id === 'telegraph')?.match.feedUrl)
        .toBe('https://second.example.com/example/telegraph')
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
