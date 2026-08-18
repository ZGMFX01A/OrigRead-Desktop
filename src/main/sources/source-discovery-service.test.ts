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
  it('runs independent static probes concurrently and reports real progress stages', async () => {
    let started = 0
    let release!: () => void
    const allStarted = new Promise<void>((resolve) => { release = resolve })
    const joinBarrier = async <T>(value: T): Promise<T> => {
      started += 1
      if (started === 4) release()
      await allStarted
      return value
    }
    const progress: string[] = []
    const service = createService({
      rss: async () => joinBarrier(rssFeed('https://example.com/feed.xml', false)),
      rssHub: async () => joinBarrier([]),
      json: async () => joinBarrier(null),
      website: async () => joinBarrier(websiteInspection(false)),
      dynamic: vi.fn()
    })

    const result = await service.discover('https://example.com/', (stage, state) => progress.push(`${stage}:${state}`))

    expect(started).toBe(4)
    expect(result.candidates.some((candidate) => candidate.kind === 'RSS_DIRECT')).toBe(true)
    for (const stage of ['rss', 'rsshub', 'json', 'website']) {
      expect(progress).toContain(`${stage}:running`)
      expect(progress).toContain(`${stage}:completed`)
    }
    expect(progress).toContain('ranking:running')
    expect(progress).toContain('ranking:completed')
    expect(progress.some((entry) => entry.startsWith('dynamic_website:'))).toBe(false)
  })

  it('does not start dynamic Chromium when a static candidate already passes unified scoring', async () => {
    const dynamic = vi.fn()
    const service = createService({
      rss: async () => rssFeed('https://example.com/feed.xml', false),
      rssHub: async () => [],
      json: async () => null,
      website: async () => { throw new Error('static website unavailable') },
      dynamic
    })
    const result = await service.discover('https://example.com/')
    expect(result.candidates[0]?.kind).toBe('RSS_DIRECT')
    expect(dynamic).not.toHaveBeenCalled()
  })

  it('starts dynamic website only when all static candidate scores are empty', async () => {
    const dynamic = vi.fn(async () => websiteInspection(true))
    const service = createService({
      rss: async () => { throw new Error('no rss') },
      rssHub: async () => [],
      json: async () => null,
      website: async () => { throw new Error('static failed') },
      dynamic
    })
    const result = await service.discover('https://example.com/')
    expect(dynamic).toHaveBeenCalledTimes(1)
    expect(result.candidates[0]?.kind).toBe('WEBSITE_DYNAMIC')
  })

  it('explicit JSON endpoint is JSON-only and never falls through to RSS or Website', async () => {
    const rss = vi.fn()
    const website = vi.fn()
    const probe = jsonProbe()
    const service = createService({ rss, rssHub: async () => [], json: async () => probe, website, dynamic: vi.fn() })
    const result = await service.discover('https://example.com/api/news')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.kind).toBe('JSON')
    expect(rss).not.toHaveBeenCalled()
    expect(website).not.toHaveBeenCalled()
  })

  it('ranks direct RSS above JSON and RSSHub when all expose equivalent healthy content', async () => {
    const direct = rssFeed('https://example.com/feed.xml', false)
    const hub = rssFeed('https://rsshub.example.com/example', false)
    const service = createService({
      rss: async () => direct,
      rssHub: async () => [{
        available: true,
        state: 'available',
        feed: hub,
        message: null,
        match: {
          route: { id: 'example', name: 'Example Hub', host: 'example.com', pathPrefix: '/', target: '/example' },
          feedUrl: hub.feedUrl,
          parameters: {}, missingParameters: [], resolved: true
        }
      }],
      json: async () => jsonProbe(),
      website: async () => websiteInspection(false),
      dynamic: vi.fn()
    })
    const result = await service.discover('https://example.com/')
    expect(result.candidates.map((item) => item.kind).slice(0, 4)).toEqual(['RSS_DIRECT', 'JSON', 'RSSHUB', 'WEBSITE'])
    expect(result.rssHubRoutes).toHaveLength(1)
    expect(result.rssHubRoutes[0]).toMatchObject({ name: 'Example Hub', state: 'available', articleCount: 20 })
  })

  it('keeps local RSSHub matches in the result when instance probing throws', async () => {
    const localMatch = {
      available: false,
      state: 'network_unavailable',
      feed: null,
      message: 'RSSHub instance probing failed',
      match: {
        route: { id: 'example', name: 'Example Hub', host: 'example.com', pathPrefix: '/', target: '/example' },
        feedUrl: 'https://rsshub.app/example',
        parameters: {}, missingParameters: [], resolved: true
      }
    }
    const service = createService({
      rss: async () => { throw new Error('no rss') },
      rssHubLocal: () => [localMatch],
      rssHub: async () => { throw new Error('instance failed') },
      json: async () => null,
      website: async () => websiteInspection(false),
      dynamic: vi.fn()
    })
    const result = await service.discover('https://example.com/')
    expect(result.rssHubRoutes).toEqual([
      expect.objectContaining({ routeId: 'example', name: 'Example Hub', state: 'network_unavailable', available: false })
    ])
    expect(result.candidates.some((candidate) => candidate.kind === 'WEBSITE')).toBe(true)
  })

  it('marks a reachable RSSHub feed as invalid_content when unified scoring rejects its articles', async () => {
    const invalidFeed = rssFeed('https://rsshub.example.com/example/bad', false)
    invalidFeed.items = [{
      sourceId: 'bad', title: '', link: '', author: null,
      publishedAt: null, descriptionHtml: '', contentHtml: null, imageUrl: null
    }]
    const service = createService({
      rss: async () => { throw new Error('no direct rss') },
      rssHub: async () => [{
        available: true,
        state: 'available',
        feed: invalidFeed,
        message: null,
        match: {
          route: { id: 'bad', name: 'Bad Hub', host: 'example.com', pathPrefix: '/', target: '/example/bad' },
          feedUrl: invalidFeed.feedUrl,
          parameters: {}, missingParameters: [], resolved: true
        }
      }],
      json: async () => null,
      website: async () => websiteInspection(false),
      dynamic: vi.fn()
    })
    const result = await service.discover('https://example.com/')
    expect(result.candidates.some((candidate) => candidate.kind === 'RSSHUB')).toBe(false)
    expect(result.rssHubRoutes[0]).toMatchObject({
      routeId: 'bad', state: 'invalid_content', available: false, candidateId: null
    })
  })

  it('subscribes every selected RSSHub channel', async () => {
    const subscribeHub = vi.fn((sourceUrl: string, result: any) => ({ feedId: `hub-${result.match.route.id}` }))
    const hubResults = ['hot', 'telegraph'].map((routeId) => {
      const feed = rssFeed(`https://rsshub.example.com/example/${routeId}`, false)
      return {
        available: true,
        state: 'available',
        feed,
        message: null,
        match: {
          route: { id: routeId, name: routeId, host: 'example.com', pathPrefix: '/', target: `/example/${routeId}` },
          feedUrl: feed.feedUrl,
          parameters: {}, missingParameters: [], resolved: true
        }
      }
    })
    const service = createService({
      rss: async () => { throw new Error('no direct rss') },
      rssHub: async () => hubResults,
      rssHubSubscribe: subscribeHub,
      json: async () => null,
      website: async () => { throw new Error('no static website') },
      dynamic: vi.fn(async () => websiteInspection(true))
    })

    const discovery = await service.discover('https://example.com/')
    const hubCandidateIds = discovery.candidates.filter((candidate) => candidate.kind === 'RSSHUB').map((candidate) => candidate.id)
    expect(hubCandidateIds).toHaveLength(2)

    const subscribed = await service.subscribeMany(discovery.discoveryId, hubCandidateIds)
    expect(subscribed.map((item) => item.feedId).sort()).toEqual(['hub-hot', 'hub-telegraph'])
    expect(subscribeHub).toHaveBeenCalledTimes(2)
  })

  it('routes RSS subscription through the current Google Reader/FreshRSS account coordinator', async () => {
    const remoteSubscribe = vi.fn(async () => 'remote-feed')
    const service = createService({
      rss: async () => rssFeed('https://example.com/feed.xml', false),
      rssHub: async () => [], json: async () => null,
      website: async () => { throw new Error('no website') }, dynamic: vi.fn(),
      accountCoordinator: { current: () => ({ type: 'fresh_rss' }), subscribeRss: remoteSubscribe }
    })
    const discovery = await service.discover('https://example.com/')
    const rssCandidate = discovery.candidates.find((candidate) => candidate.kind === 'RSS_DIRECT')!
    const [result] = await service.subscribeMany(discovery.discoveryId, [rssCandidate.id])
    expect(result?.feedId).toBe('remote-feed')
    expect(remoteSubscribe).toHaveBeenCalledTimes(1)
  })

  it('rejects Website subscription under a remote account because Android exposes it only to Local', async () => {
    const service = createService({
      rss: async () => { throw new Error('no rss') }, rssHub: async () => [], json: async () => null,
      website: async () => websiteInspection(false), dynamic: vi.fn(),
      accountCoordinator: { current: () => ({ type: 'google_reader' }), subscribeRss: vi.fn() }
    })
    const discovery = await service.discover('https://example.com/')
    const website = discovery.candidates.find((candidate) => candidate.kind === 'WEBSITE')!
    await expect(service.subscribeMany(discovery.discoveryId, [website.id])).rejects.toThrow('网站 来源仅支持 Local 账户')
  })
})

function createService(options: {
  rss: (...args: unknown[]) => Promise<DiscoveredRssFeed>
  rssHub: (...args: unknown[]) => Promise<any[]>
  rssHubLocal?: (...args: unknown[]) => any[]
  json: (...args: unknown[]) => Promise<JsonSourceProbeResult | null>
  website: (...args: unknown[]) => Promise<WebsiteInspectionResult>
  dynamic: (...args: unknown[]) => Promise<WebsiteInspectionResult>
  rssHubSubscribe?: (...args: any[]) => any
  accountCoordinator?: { current: () => any; subscribeRss: (...args: any[]) => Promise<string> }
}): SourceDiscoveryService {
  return new SourceDiscoveryService(
    { discover: options.rss } as unknown as RssDiscoveryService,
    { addDiscovered: () => ({ feedId: 'rss-feed', insertedArticles: 0 }) } as unknown as RssSubscriptionService,
    {
      probe: options.rssHub,
      localRouteDiagnostics: options.rssHubLocal ?? (() => [])
    } as unknown as RssHubResolver,
    { subscribe: options.rssHubSubscribe ?? (() => ({ feedId: 'hub-feed' })) } as unknown as RssHubSubscriptionService,
    { probe: options.json } as unknown as JsonSourceService,
    { add: async () => ({ feedId: 'json-feed', insertedArticles: 0 }) } as unknown as JsonSubscriptionService,
    {
      inspect: options.website,
      inspectDynamic: options.dynamic,
      hasRule: () => false
    } as unknown as WebsiteSourceService,
    { add: async () => ({ feedId: 'website-feed', insertedArticles: 0 }) } as unknown as WebsiteSubscriptionService,
    options.accountCoordinator as any
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

