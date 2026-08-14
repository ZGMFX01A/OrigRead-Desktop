import { describe, expect, it } from 'vitest'
import {
  RssDiscoveryService,
  buildCommonFeedCandidates,
  type RssFetchPayload,
  type RssFetcher
} from './rss-discovery-service'

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

describe('RssDiscoveryService Android behavior parity', () => {
  it('parses the input URL directly before attempting page discovery', async () => {
    const requests: string[] = []
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/feed.xml': rss(RSS_XML)
    }, requests))

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

  it('discovers rel alternate after direct parse fails and resolves relative href against input URL', async () => {
    const requests: string[] = []
    const page = `<!doctype html><html><head>
      <link rel="alternate" type="application/rss+xml" href="/news/feed.xml">
    </head></html>`
    const service = new RssDiscoveryService(createFetcher({
      'https://example.com/news': html(page),
      'https://example.com/news/feed.xml': rss(RSS_XML)
    }, requests))

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
    }, requests))

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

