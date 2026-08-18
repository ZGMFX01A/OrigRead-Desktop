import { describe, expect, it, vi } from 'vitest'
import {
  RssDiscoveryService,
  buildCommonFeedCandidates,
  fetchRssPayload,
  type RssFetchPayload,
  type RssFetcher
} from './rss-discovery-service'
import type { RssIconFinder } from './best-icon-finder'

const noIconFinder: RssIconFinder = { findBestIcon: async () => null }

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <item>
      <guid>article-1</guid>
      <title>First &amp; best</title>
      <link>https://example.com/1</link>
      <pubDate>Fri, 14 Aug 2026 01:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <img src="https://example.com/cover.jpg" /></p>]]></description>
    </item>
  </channel>
</rss>`

const PODCAST_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Podcast Feed</title>
    <link>https://example.com/</link>
    <item>
      <guid>episode-1</guid>
      <title>Episode 1</title>
      <link>https://example.com/episodes/1</link>
      <enclosure url="https://files.example.com/episode-1.mp3" type="audio/mp3" length="123" />
      <description><![CDATA[<p>No cover image here</p>]]></description>
    </item>
  </channel>
</rss>`

describe('RssDiscoveryService Android behavior parity', () => {
  it('parses the input URL directly before attempting page discovery', async () => {
    const requests: string[] = []
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/feed.xml': rss(RSS_XML)
    }, requests), noIconFinder)

    const result = await service.discover('https://example.com/feed.xml')

    expect(requests).toEqual(['https://example.com/feed.xml'])
    expect(result.discoveredFromPage).toBe(false)
    expect(result.title).toBe('Example Feed')
    expect(result.items[0]).toMatchObject({
      sourceId: 'article-1',
      title: 'First & best',
      link: 'https://example.com/1',
      imageUrl: 'https://example.com/cover.jpg'
    })
  })

  it('does not treat podcast audio enclosure as an article image', async () => {
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/podcast.xml': rss(PODCAST_RSS_XML)
    }, []), noIconFinder)

    const result = await service.parseDirect('https://example.com/podcast.xml')

    expect(result.items[0]?.imageUrl).toBeNull()
  })

  it('discovers rel alternate after direct parse fails and resolves relative href against input URL', async () => {
    const requests: string[] = []
    const page = `<!doctype html><html><head>
      <link rel="alternate" type="application/rss+xml" href="/news/feed.xml">
    </head></html>`
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/news': html(page),
      'https://example.com/news/feed.xml': rss(RSS_XML)
    }, requests), noIconFinder)

    const result = await service.discover('https://example.com/news')

    expect(requests).toEqual([
      'https://example.com/news',
      'https://example.com/news',
      'https://example.com/news/feed.xml'
    ])
    expect(result.feedUrl).toBe('https://example.com/news/feed.xml')
    expect(result.discoveredFromPage).toBe(true)
  })

  it('falls back to the same common origin paths used by Android when no alternate is declared', async () => {
    const requests: string[] = []
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/section': html('<!doctype html><html><body>No feed link</body></html>'),
      'https://example.com/feed': rss(RSS_XML)
    }, requests), noIconFinder)

    const result = await service.discover('https://example.com/section')

    expect(result.feedUrl).toBe('https://example.com/feed')
    expect(requests.slice(-1)).toEqual(['https://example.com/feed'])
  })

  it('keeps Android common candidate order', () => {
    expect(buildCommonFeedCandidates('https://example.com/news/latest?q=1')).toEqual([
      'https://example.com/feed',
      'https://example.com/feed/',
      'https://example.com/rss',
      'https://example.com/rss.xml',
      'https://example.com/atom.xml',
      'https://example.com/feed.xml',
      'https://example.com/index.xml'
    ])
  })

  it('default fetcher sends HTTP validators and treats 304 as not modified', async () => {
    const lastModified = 'Tue, 18 Aug 2026 12:00:00 GMT'
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers['If-None-Match']).toBe('"etag-v1"')
      expect(headers['If-Modified-Since']).toBe(lastModified)
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag-v1"', 'Last-Modified': lastModified }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await fetchRssPayload('https://example.com/feed.xml', {
        etag: '"etag-v1"',
        lastModified
      })
      expect(result.notModified).toBe(true)
      expect(result.etag).toBe('"etag-v1"')
      expect(result.lastModified).toBe(lastModified)
      expect(result.bytes).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

function createFetcher(fixtures: Record<string, RssFetchPayload>, requests: string[]): RssFetcher {
  return async (url) => {
    requests.push(url)
    const fixture = fixtures[url]
    if (!fixture) throw new Error(`HTTP 404: ${url}`)
    return fixture
  }
}

function rss(content: string): RssFetchPayload {
  return payload(content, 'application/rss+xml; charset=UTF-8')
}

function html(content: string): RssFetchPayload {
  return payload(content, 'text/html; charset=UTF-8')
}

function payload(content: string, contentType: string): RssFetchPayload {
  return {
    finalUrl: 'https://example.com/',
    contentType,
    bytes: new TextEncoder().encode(content)
  }
}

