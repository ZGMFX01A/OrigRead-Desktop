import { describe, expect, it, vi } from 'vitest'
import type { DiscoveredRssFeed } from '../../shared/rss'
import type { JsonSourceProbeResult } from '../../shared/json-source'
import type { WebsiteInspectionResult } from '../../shared/website'
import { SourceDiscoveryService } from './source-discovery-service'
import type { RssDiscoveryService } from './rss/rss-discovery-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import type { RssHubResolver } from './rsshub/rsshub-resolver'
import type { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import type { JsonSourceService } from './json/json-source-service'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { WebsiteSourceService } from './website/website-source-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'

describe('SourceDiscoveryService parity', () => {
  it('short-circuits immediately after RSS succeeds', async () => {
    const rss = vi.fn(async () => rssFeed('https://example.com/feed.xml', false))
    const rssHub = vi.fn(async () => [])
    const json = vi.fn(async () => jsonProbe())
    const website = vi.fn(async () => websiteInspection(false))
    const dynamic = vi.fn(async () => websiteInspection(true))
    const service = createService({ rss, rssHub, json, website, dynamic })

    const result = await service.discover('https://example.com/feed.xml')

    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['RSS_DIRECT'])
    expect(rss).toHaveBeenCalledTimes(1)
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('returns before every network probe when the normalized input source already exists', async () => {
    const rss = vi.fn(async () => rssFeed('https://example.com/feed.xml', false))
    const rssHub = vi.fn(async () => [])
    const json = vi.fn(async () => jsonProbe())
    const website = vi.fn(async () => websiteInspection(false))
    const dynamic = vi.fn(async () => websiteInspection(true))
    const service = createService({
      rss, rssHub, json, website, dynamic,
      existingSource: (url) => url === 'https://example.com/feed/?utm_source=test'
    })

    const result = await service.discover('https://example.com/feed/?utm_source=test')

    expect(result.candidates).toEqual([])
    expect(result.error).toBe('来源已存在')
    expect(rss).not.toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('keeps a successfully parsed empty RSS selectable and never falls through', async () => {
    const emptyFeed = rssFeed('https://example.com/quiet.xml', false)
    emptyFeed.items = []
    const dynamic = vi.fn()
    const service = createService({
      rss: async () => emptyFeed,
      rssHub: vi.fn(), json: vi.fn(), website: vi.fn(), dynamic
    })

    const result = await service.discover('https://example.com/quiet.xml')

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ kind: 'RSS_DIRECT', diagnostics: { accepted: true, articleCount: 0 } })
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('uses a JSON-shaped URL only as a hint and short-circuits after real JSON success', async () => {
    const order: string[] = []
    const rss = vi.fn(async () => { order.push('rss'); return rssFeed('https://example.com/feed.xml', false) })
    const json = vi.fn(async () => { order.push('json'); return jsonProbe() })
    const service = createService({ rss, rssHub: vi.fn(), json, website: vi.fn(), dynamic: vi.fn() })

    const result = await service.discover('https://example.com/api/news')

    expect(order).toEqual(['json'])
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['JSON'])
    expect(rss).not.toHaveBeenCalled()
  })

  it('falls back from a failed JSON hint to RSS instead of treating /api/ as authoritative', async () => {
    const order: string[] = []
    const service = createService({
      rss: async () => { order.push('rss'); return rssFeed('https://example.com/api/news', false) },
      rssHub: vi.fn(),
      json: async () => { order.push('json'); return null },
      website: vi.fn(), dynamic: vi.fn()
    })

    const result = await service.discover('https://example.com/api/news')

    expect(order).toEqual(['json', 'rss'])
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['RSS_DIRECT'])
  })

  it('runs fallback stages sequentially as RSS -> JSON -> RSSHub -> Website and stops on Website', async () => {
    const order: string[] = []
    const progress: string[] = []
    const service = createService({
      rss: async () => { order.push('rss'); throw new Error('no rss') },
      json: async () => { order.push('json'); return null },
      rssHub: async () => { order.push('rsshub'); return [] },
      website: async () => { order.push('website'); return websiteInspection(false) },
      dynamic: async () => { order.push('dynamic'); return websiteInspection(true) }
    })

    const result = await service.discover('https://example.com/blog', (stage, state) => progress.push(`${stage}:${state}`))

    expect(order).toEqual(['rss', 'json', 'rsshub', 'website'])
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['WEBSITE'])
    expect(progress).toContain('rss:running')
    expect(progress).toContain('json:running')
    expect(progress).toContain('rsshub:running')
    expect(progress).toContain('website:running')
    expect(progress.some((entry) => entry.startsWith('dynamic_website:'))).toBe(false)
  })

  it('aborts the active RSS probe when the discovery-stage deadline expires instead of leaving detached work running', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const rss = vi.fn((_url: string, signal?: AbortSignal) => new Promise<DiscoveredRssFeed>((_resolve, reject) => {
        if (!signal) return reject(new Error('missing abort signal'))
        const onAbort = (): void => {
          aborted = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }))
      const service = createService({
        rss, rssHub: vi.fn(), json: async () => jsonProbe(), website: vi.fn(), dynamic: vi.fn()
      })

      const pending = service.discover('https://example.com/')
      await vi.advanceTimersByTimeAsync(20_000)
      const result = await pending

      expect(aborted).toBe(true)
      expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['JSON'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates an outer cancellation through the active RSS probe and does not continue fallback stages', async () => {
    let rssAborted = false
    const rss = vi.fn((_url: string, signal?: AbortSignal) => new Promise<DiscoveredRssFeed>((_resolve, reject) => {
      if (!signal) return reject(new Error('missing abort signal'))
      const onAbort = (): void => {
        rssAborted = true
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }))
    const json = vi.fn(async () => jsonProbe())
    const rssHub = vi.fn(async () => [])
    const website = vi.fn(async () => websiteInspection(false))
    const dynamic = vi.fn(async () => websiteInspection(true))
    const service = createService({ rss, rssHub, json, website, dynamic })
    const controller = new AbortController()

    const pending = service.discover('https://example.com/', () => undefined, controller.signal)
    await Promise.resolve()
    controller.abort(new Error('user cancelled discovery'))

    await expect(pending).rejects.toThrow('user cancelled discovery')
    expect(rssAborted).toBe(true)
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('starts dynamic Website only after every structured and static fallback fails', async () => {
    const order: string[] = []
    const service = createService({
      rss: async () => { order.push('rss'); throw new Error('no rss') },
      json: async () => { order.push('json'); return null },
      rssHub: async () => { order.push('rsshub'); return [] },
      website: async () => { order.push('website'); throw new Error('static failed') },
      dynamic: async () => { order.push('dynamic'); return websiteInspection(true) }
    })

    const result = await service.discover('https://example.com/')

    expect(order).toEqual(['rss', 'json', 'rsshub', 'website', 'dynamic'])
    expect(result.candidates[0]?.kind).toBe('WEBSITE_DYNAMIC')
  })

  it('binds the dynamic payload when an invalid static Website and dynamic result share the same URL id', async () => {
    const staticInspection = websiteInspection(false)
    staticInspection.candidate.articles = []
    staticInspection.candidate.diagnostics = {
      ...staticInspection.candidate.diagnostics,
      state: 'INVALID_CONTENT', articleCount: 0, score: 0,
      validTitleRate: 0, validLinkRate: 0, uniqueLinkRate: 0, parsedDateRate: 0,
      reasons: ['invalid static list']
    }
    const dynamicInspection = websiteInspection(true)
    const addWebsite = vi.fn(async (_inspection: WebsiteInspectionResult, dynamic: boolean) => ({
      feedId: dynamic ? 'dynamic-feed' : 'static-feed', insertedArticles: 0
    }))
    const service = createService({
      rss: async () => { throw new Error('no rss') }, rssHub: async () => [], json: async () => null,
      website: async () => staticInspection, dynamic: async () => dynamicInspection, websiteSubscribe: addWebsite
    })

    const discovery = await service.discover('https://example.com/')
    const selected = discovery.candidates.find((candidate) => candidate.kind === 'WEBSITE_DYNAMIC')!
    const subscribed = await service.subscribe(discovery.discoveryId, selected.id)

    expect(subscribed.feedId).toBe('dynamic-feed')
    expect(addWebsite).toHaveBeenCalledWith(dynamicInspection, true)
  })

  it('treats a known RSSHub route as the only exclusive pre-network branch for Local accounts', async () => {
    const routeUrl = 'https://hub.example.com/rsshub/telegram/channel/demo'
    const feed = rssFeed(routeUrl, false)
    feed.feedUrl = routeUrl
    const directRss = vi.fn(async () => feed)
    const rss = vi.fn()
    const rssHub = vi.fn()
    const json = vi.fn()
    const website = vi.fn()
    const directSubscribe = vi.fn(() => ({ feedId: 'hub-direct' }))
    const service = createService({
      directRss, rss, rssHub, json, website, dynamic: vi.fn(),
      knownRssHubInstances: ['https://hub.example.com/rsshub'],
      rssHubDirectSubscribe: directSubscribe
    })
    const progress: string[] = []

    const discovery = await service.discover(routeUrl, (stage, state) => progress.push(`${stage}:${state}`))

    expect(discovery.catalogMatches).toEqual([])
    expect(discovery.candidates.map((candidate) => candidate.kind)).toEqual(['RSSHUB'])
    expect(discovery.rssHubRoutes).toEqual([
      expect.objectContaining({ name: 'RSSHub', state: 'available', available: true, candidateId: discovery.candidates[0]!.id })
    ])
    expect(directRss).toHaveBeenCalledWith(routeUrl, routeUrl, expect.anything())
    expect(rss).not.toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
    expect(progress).toContain('rsshub:running')
    expect(progress).toContain('rsshub:completed')
    expect(progress.some((entry) => entry.startsWith('rss:'))).toBe(false)
    const subscribed = await service.subscribe(discovery.discoveryId, discovery.candidates[0]!.id)
    expect(subscribed.feedId).toBe('hub-direct')
    expect(directSubscribe).toHaveBeenCalledWith(routeUrl, feed)
  })

  it('treats a known RSSHub route as plain RSS for remote accounts', async () => {
    const routeUrl = 'https://rsshub.app/telegram/channel/demo'
    const feed = rssFeed(routeUrl, false)
    feed.feedUrl = routeUrl
    const remoteSubscribe = vi.fn(async () => 'remote-feed')
    const service = createService({
      directRss: async () => feed,
      rss: vi.fn(), rssHub: vi.fn(), json: vi.fn(), website: vi.fn(), dynamic: vi.fn(),
      accountCoordinator: { current: () => ({ type: 'fresh_rss' }), subscribeRss: remoteSubscribe }
    })

    const discovery = await service.discover(routeUrl)

    expect(discovery.candidates.map((candidate) => candidate.kind)).toEqual(['RSS_DIRECT'])
    const subscribed = await service.subscribe(discovery.discoveryId, discovery.candidates[0]!.id)
    expect(subscribed.feedId).toBe('remote-feed')
    expect(remoteSubscribe).toHaveBeenCalledWith(feed)
  })

  it('does not probe Local-only JSON/RSSHub/Website sources for remote accounts', async () => {
    const json = vi.fn(async () => jsonProbe())
    const rssHub = vi.fn(async () => [])
    const website = vi.fn(async () => websiteInspection(false))
    const dynamic = vi.fn(async () => websiteInspection(true))
    const service = createService({
      rss: async () => { throw new Error('no rss') }, rssHub, json, website, dynamic,
      accountCoordinator: { current: () => ({ type: 'google_reader' }), subscribeRss: vi.fn() }
    })

    const discovery = await service.discover('https://example.com/api/news')

    expect(discovery.candidates).toEqual([])
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('short-circuits on an available RSSHub candidate before Website probing', async () => {
    const sparseFeed = rssFeed('https://rsshub.example.com/example/sparse', false)
    sparseFeed.items = [{
      sourceId: 'sparse', title: '', link: '', author: null,
      publishedAt: null, descriptionHtml: '', contentHtml: null, imageUrl: null
    }]
    const website = vi.fn(async () => websiteInspection(false))
    const service = createService({
      rss: async () => { throw new Error('no rss') }, json: async () => null,
      rssHub: async () => [{
        available: true, state: 'available', feed: sparseFeed, message: null,
        match: {
          route: { id: 'sparse', name: 'Sparse Hub', host: 'example.com', pathPrefix: '/', target: '/example/sparse' },
          feedUrl: sparseFeed.feedUrl, parameters: {}, missingParameters: [], resolved: true
        }
      }],
      website, dynamic: vi.fn()
    })

    const result = await service.discover('https://example.com/')

    expect(result.candidates.some((candidate) => candidate.kind === 'RSSHUB')).toBe(true)
    expect(result.rssHubRoutes[0]).toMatchObject({ routeId: 'sparse', state: 'available', available: true })
    expect(website).not.toHaveBeenCalled()
  })

  it('keeps local RSSHub diagnostics when network probing fails, then continues to Website', async () => {
    const localMatch = {
      available: false, state: 'network_unavailable', feed: null, message: 'RSSHub instance probing failed',
      match: {
        route: { id: 'example', name: 'Example Hub', host: 'example.com', pathPrefix: '/', target: '/example' },
        feedUrl: 'https://rsshub.app/example', parameters: {}, missingParameters: [], resolved: true
      }
    }
    const service = createService({
      rss: async () => { throw new Error('no rss') }, json: async () => null,
      rssHubLocal: () => [localMatch], rssHub: async () => { throw new Error('instance failed') },
      website: async () => websiteInspection(false), dynamic: vi.fn()
    })

    const result = await service.discover('https://example.com/')

    expect(result.rssHubRoutes).toEqual([
      expect.objectContaining({ routeId: 'example', state: 'network_unavailable', available: false })
    ])
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['WEBSITE'])
  })

  it('subscribes every selected RSSHub channel without re-probing', async () => {
    const subscribeHub = vi.fn((_sourceUrl: string, result: any) => ({ feedId: `hub-${result.match.route.id}` }))
    const hubResults = ['hot', 'telegraph'].map((routeId) => {
      const feed = rssFeed(`https://rsshub.example.com/example/${routeId}`, false)
      return {
        available: true, state: 'available', feed, message: null,
        match: {
          route: { id: routeId, name: routeId, host: 'example.com', pathPrefix: '/', target: `/example/${routeId}` },
          feedUrl: feed.feedUrl, parameters: {}, missingParameters: [], resolved: true
        }
      }
    })
    const rssHub = vi.fn(async () => hubResults)
    const service = createService({
      rss: async () => { throw new Error('no direct rss') }, json: async () => null, rssHub,
      rssHubSubscribe: subscribeHub, website: vi.fn(), dynamic: vi.fn()
    })

    const discovery = await service.discover('https://example.com/')
    const hubCandidateIds = discovery.candidates.filter((candidate) => candidate.kind === 'RSSHUB').map((candidate) => candidate.id)
    const subscribed = await service.subscribeMany(discovery.discoveryId, hubCandidateIds)

    expect(subscribed.map((item) => item.feedId).sort()).toEqual(['hub-hot', 'hub-telegraph'])
    expect(subscribeHub).toHaveBeenCalledTimes(2)
    expect(rssHub).toHaveBeenCalledTimes(1)
  })

  it('routes successful RSS through the current remote account coordinator', async () => {
    const remoteSubscribe = vi.fn(async () => 'remote-feed')
    const json = vi.fn()
    const rssHub = vi.fn()
    const website = vi.fn()
    const service = createService({
      rss: async () => rssFeed('https://example.com/feed.xml', false),
      rssHub, json, website, dynamic: vi.fn(),
      accountCoordinator: { current: () => ({ type: 'fresh_rss' }), subscribeRss: remoteSubscribe }
    })
    const discovery = await service.discover('https://example.com/')
    const selected = discovery.candidates[0]!
    const [result] = await service.subscribeMany(discovery.discoveryId, [selected.id])

    expect(result?.feedId).toBe('remote-feed')
    expect(remoteSubscribe).toHaveBeenCalledTimes(1)
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
  })

  it('does not wait for a slow catalog Feed before continuing the normal discovery chain', async () => {
    const knownFeedUrl = 'https://feeds.example.com/slow.xml'
    const catalogEntry = {
      id: 'slow', name: 'Slow Feed', feedUrl: knownFeedUrl, siteUrl: 'https://example.com/',
      categories: [], origins: []
    }
    let catalogAborted = false
    const rss = vi.fn(async (url: string, signal?: AbortSignal) => {
      if (url === knownFeedUrl) {
        return new Promise<DiscoveredRssFeed>((_resolve, reject) => {
          if (!signal) return reject(new Error('missing catalog abort signal'))
          const onAbort = (): void => {
            catalogAborted = true
            reject(signal.reason instanceof Error ? signal.reason : new Error('catalog aborted'))
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      }
      throw new Error('input is not RSS')
    })
    const json = vi.fn(async () => jsonProbe())
    const service = createService({
      rss, rssHub: vi.fn(), json, website: vi.fn(), dynamic: vi.fn(),
      feedDiscoveryCatalog: { matchUrl: () => ({ preferred: catalogEntry, suggestions: [catalogEntry], totalSuggestions: 1 }) }
    })

    const result = await service.discover('https://example.com/')

    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(['JSON'])
    expect(json).toHaveBeenCalledTimes(1)
    expect(catalogAborted).toBe(true)
  })

  it('uses a catalog Feed as structured RSS fallback and then short-circuits', async () => {
    const knownFeedUrl = 'https://feeds.example.com/known.xml'
    const catalogEntry = {
      id: 'known', name: 'Known Feed', feedUrl: knownFeedUrl, siteUrl: 'https://example.com/',
      categories: ['Tech & Engineering'], origins: [{ sourceId: 'bestblogs', category: 'Technology' }]
    }
    const rss = vi.fn(async (url: unknown) => {
      if (url === knownFeedUrl) return rssFeed(knownFeedUrl, false)
      // Give the concurrently-started catalog probe one turn to settle, matching the
      // Android rule: use it only if it is already ready when the input RSS probe fails.
      await new Promise((resolve) => setTimeout(resolve, 0))
      throw new Error('input is not RSS')
    })
    const json = vi.fn()
    const rssHub = vi.fn()
    const website = vi.fn()
    const service = createService({
      rss, rssHub, json, website, dynamic: vi.fn(),
      feedDiscoveryCatalog: { matchUrl: () => ({ preferred: catalogEntry, suggestions: [catalogEntry], totalSuggestions: 1 }) }
    })

    const result = await service.discover('https://example.com/')

    expect(result.catalogMatches).toEqual([catalogEntry])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ kind: 'RSS_DIRECT', feedLink: knownFeedUrl })
    expect(rss).toHaveBeenCalledWith('https://example.com/', expect.anything())
    expect(rss).toHaveBeenCalledWith(knownFeedUrl, expect.anything())
    expect(rss).toHaveBeenCalledTimes(2)
    expect(json).not.toHaveBeenCalled()
    expect(rssHub).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
  })
})

function createService(options: {
  directRss?: (url: string, sourcePageUrl?: string, signal?: AbortSignal) => Promise<DiscoveredRssFeed>
  rss: (url: string, signal?: AbortSignal) => Promise<DiscoveredRssFeed>
  rssHub: (...args: unknown[]) => Promise<any[]>
  rssHubLocal?: (...args: unknown[]) => any[]
  json: (...args: unknown[]) => Promise<JsonSourceProbeResult | null>
  website: (...args: unknown[]) => Promise<WebsiteInspectionResult>
  dynamic: (...args: unknown[]) => Promise<WebsiteInspectionResult>
  rssHubSubscribe?: (...args: any[]) => any
  rssHubDirectSubscribe?: (...args: any[]) => any
  knownRssHubInstances?: string[]
  websiteSubscribe?: (...args: any[]) => Promise<{ feedId: string; insertedArticles: number }>
  accountCoordinator?: { current: () => any; subscribeRss: (...args: any[]) => Promise<string> }
  feedDiscoveryCatalog?: { matchUrl: (...args: any[]) => any }
  existingSource?: (url: string) => boolean
}): SourceDiscoveryService {
  return new SourceDiscoveryService(
    {
      parseDirect: options.directRss ?? (async () => { throw new Error('not a direct feed') }),
      discover: options.rss
    } as unknown as RssDiscoveryService,
    {
      addDiscovered: () => ({ feedId: 'rss-feed', insertedArticles: 0 }),
      hasExistingSource: options.existingSource ?? (() => false)
    } as unknown as RssSubscriptionService,
    {
      probe: options.rssHub,
      localRouteDiagnostics: options.rssHubLocal ?? (() => []),
      knownInstanceUrls: () => options.knownRssHubInstances ?? []
    } as unknown as RssHubResolver,
    {
      subscribe: options.rssHubSubscribe ?? (() => ({ feedId: 'hub-feed' })),
      subscribeDirect: options.rssHubDirectSubscribe ?? (() => ({ feedId: 'hub-direct-feed' }))
    } as unknown as RssHubSubscriptionService,
    { probe: options.json } as unknown as JsonSourceService,
    { add: async () => ({ feedId: 'json-feed', insertedArticles: 0 }) } as unknown as JsonSubscriptionService,
    {
      inspect: options.website,
      inspectDynamic: options.dynamic,
      hasRule: () => false
    } as unknown as WebsiteSourceService,
    { add: options.websiteSubscribe ?? (async () => ({ feedId: 'website-feed', insertedArticles: 0 })) } as unknown as WebsiteSubscriptionService,
    options.accountCoordinator as any,
    options.feedDiscoveryCatalog as any
  )
}

function rssFeed(feedUrl: string, discoveredFromPage: boolean): DiscoveredRssFeed {
  return {
    feedUrl,
    sourcePageUrl: 'https://example.com/',
    discoveredFromPage,
    title: 'Example Feed',
    siteUrl: 'https://example.com/',
    iconUrl: null,
    items: items().map((item, index) => ({
      sourceId: String(index), title: item.title, link: item.link, author: null,
      publishedAt: item.publishedAt, descriptionHtml: '', contentHtml: null, imageUrl: null
    }))
  }
}

function jsonProbe(): JsonSourceProbeResult {
  return {
    rule: {
      id: 'json', name: 'JSON', version: 1, enabled: true, hosts: ['example.com'], sourceKind: 'API',
      endpoint: '/api/news', itemsPath: '$[*]', titlePath: '$.title', linkPath: '$.link', datePath: null,
      authorPath: null, descriptionPath: null, imagePath: null, idPath: null, dateFormat: null, maxItems: 50
    },
    endpointUrl: 'https://example.com/api/news',
    sourcePageUrl: 'https://example.com/',
    title: 'Example JSON',
    articles: items().map((item, index) => ({ stableId: String(index), title: item.title, link: item.link, author: null, publishedAt: item.publishedAt!, descriptionHtml: '', imageUrl: null }))
  }
}

function websiteInspection(dynamic: boolean): WebsiteInspectionResult {
  const articles = items().map((item, index) => ({ stableId: String(index), title: item.title, link: item.link, author: null, publishedAt: item.publishedAt!, descriptionHtml: '', imageUrl: null }))
  const rule = {
    id: dynamic ? 'auto-dom:example:dynamic' : 'auto-dom:example:static', name: 'Smart detection', version: 7, enabled: true,
    hosts: ['example.com'], articleSelectors: ['article'], titleSelector: 'a', linkSelector: 'a', linkAttribute: 'href',
    dateRules: [], imageSelector: null, imageAttributes: ['src'], contentSelectors: [], includeUrlRegex: null,
    automaticUrlPattern: 'example.com/article/{number}', automaticDateExtraction: true, automaticRegionScore: 0,
    excludeTitleRegexes: [], maxItems: 50, cleanupMode: 'NONE' as const, urlIdRegex: null
  }
  return {
    title: 'Example Website', sourceUrl: 'https://example.com/', finalUrl: 'https://example.com/', description: '', iconUrl: null,
    candidate: { rule, articles, diagnostics: { score: 100, linkQualityScore: 0, regionScore: 0, historyScore: 0, state: 'AVAILABLE', articleCount: articles.length, validTitleRate: 1, validLinkRate: 1, uniqueLinkRate: 1, parsedDateRate: 1, chronologicalRate: 1, reasons: [] } },
    candidates: []
  }
}

function items() {
  return Array.from({ length: 20 }, (_, index) => ({
    title: `Article ${index + 1}`,
    link: `https://example.com/article/${index + 1}`,
    publishedAt: 1_786_000_000_000 - index * 60_000
  }))
}

