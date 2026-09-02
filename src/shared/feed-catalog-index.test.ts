import { describe, expect, it } from 'vitest'
import { FeedCatalogIndex, catalogComparisonKey, preferredCatalogProbeUrl } from './feed-catalog-index'
import type { FeedCatalogEntry } from './source-catalog'

const feeds: FeedCatalogEntry[] = [
  {
    id: 'one', name: 'Example Engineering', feedUrl: 'https://feeds.example.com/rss?utm_source=test',
    siteUrl: 'https://www.example.com/', categories: ['Tech & Engineering'],
    origins: [{ sourceId: 'bestblogs', category: 'Engineering' }]
  },
  {
    id: 'two', name: 'Example Podcast', feedUrl: 'https://example.com/podcast.xml',
    siteUrl: 'https://example.com/podcast', categories: ['Podcasts'],
    origins: [{ sourceId: 'awesome-rss-feeds', category: 'Audio' }]
  }
]

describe('FeedCatalogIndex', () => {
  it('matches Android catalog search fields and localized category terms', () => {
    const index = new FeedCatalogIndex(feeds)
    expect(index.search('科技')).toEqual([feeds[0]])
    expect(index.search('bestblogs')).toEqual([feeds[0]])
    expect(index.search('audio')).toEqual([feeds[1]])
    expect(index.search('', 'Podcasts')).toEqual([feeds[1]])
  })

  it('uses exact feed/site matches conservatively and host matches only as suggestions', () => {
    const index = new FeedCatalogIndex(feeds)
    expect(index.matchUrl('http://feeds.example.com/rss?utm_source=other').preferred?.id).toBe('one')
    const site = index.matchUrl('http://example.com/')
    expect(site.preferred?.id).toBe('one')
    expect(preferredCatalogProbeUrl(site, 'https://example.com')).toBe(feeds[0]!.feedUrl)
    const host = index.matchUrl('https://example.com/unknown')
    expect(host.preferred).toBeNull()
    expect(host.suggestions.map((item) => item.id)).toEqual(['one', 'two'])
  })

  it('normalizes scheme, www, trailing slash and tracking parameters without dropping business query parameters', () => {
    expect(catalogComparisonKey('https://www.Example.com/feed/?utm_source=x&a=1')).toBe('example.com/feed?a=1')
    expect(catalogComparisonKey('http://example.com/feed?a=2')).toBe('example.com/feed?a=2')
  })
})
