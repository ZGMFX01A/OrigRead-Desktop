import { describe, expect, it } from 'vitest'
import type { FeedRecord } from '../../../shared/library'
import { DesktopDatabase } from '../../database/database'
import { LibraryRepository } from '../../database/library-repository'
import { DEFAULT_GROUP_ID } from '../../database/migrations'
import { RssDiscoveryService, type RssFetchPayload, type RssFetcher } from './rss-discovery-service'
import { RssSubscriptionService } from './rss-subscription-service'
import type { RssHubResolver } from '../rsshub/rsshub-resolver'

describe('RssSubscriptionService', () => {
  it('adds a discovered feed and persists its first article', async () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = createService(repository, RSS_ONE)

    const result = await service.add('https://example.com/feed.xml')

    expect(result.insertedArticles).toBe(1)
    expect(repository.listFeeds()[0]).toMatchObject({
      id: result.feedId,
      url: 'https://example.com/feed.xml',
      sourceType: 'rss'
    })
    expect(repository.listArticles()[0]).toMatchObject({
      title: 'Article one',
      url: 'https://example.com/1',
      isUnread: true,
      isStarred: false
    })
    database.close()
  })

  it('refreshes by feed link and preserves local read/starred state while inserting new links', async () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    let xml = RSS_ONE
    const fetcher: RssFetcher = async (url) => rssPayload(url, xml)
    const service = new RssSubscriptionService(repository, new RssDiscoveryService(fetcher))
    const added = await service.add('https://example.com/feed.xml')
    const first = repository.listArticles()[0]!
    repository.setArticleUnread(first.id, false)
    repository.setArticleStarred(first.id, true)

    xml = RSS_TWO
    const refreshed = await service.refresh(added.feedId)
    const articles = repository.listArticles()
    const original = articles.find((article) => article.url === 'https://example.com/1')!

    expect(refreshed).toMatchObject({ fetchedArticles: 2, insertedArticles: 1 })
    expect(articles).toHaveLength(2)
    expect(original.isUnread).toBe(false)
    expect(original.isStarred).toBe(true)
    database.close()
  })

  it('recovers a failed RSSHub fixed URL using the original source page and updates only the feed URL', async () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const oldUrl = 'https://old-rsshub.example.com/cls/hot'
    const sourceUrl = 'https://www.cls.cn/'
    const newUrl = 'https://new-rsshub.example.com/cls/hot'
    const now = Date.now()
    const feed = createFeed('feed-rsshub', oldUrl, sourceUrl, now)
    repository.upsertRssHubFeedWithArticles(feed, [], sourceUrl)

    const discovery = {
      discover: async () => { throw new Error('not used') },
      parseDirect: async () => { throw new Error('old instance offline') }
    } as unknown as RssDiscoveryService
    const resolver = {
      probe: async () => [{
        state: 'available',
        available: true,
        message: null,
        match: {
          route: { id: 'cls-hot', name: '热门文章排行榜', host: 'cls.cn', pathPrefix: '/', target: '/cls/hot' },
          feedUrl: newUrl,
          parameters: {},
          missingParameters: [],
          resolved: true
        },
        feed: {
          feedUrl: newUrl,
          sourcePageUrl: sourceUrl,
          discoveredFromPage: false,
          title: '财联社',
          siteUrl: sourceUrl,
          iconUrl: null,
          items: [{
            sourceId: 'article-1',
            title: 'Recovered article',
            link: 'https://www.cls.cn/detail/1',
            author: null,
            publishedAt: now,
            descriptionHtml: 'Recovered',
            contentHtml: null,
            imageUrl: null
          }]
        }
      }]
    } as unknown as RssHubResolver

    try {
      const service = new RssSubscriptionService(repository, discovery, resolver)
      const result = await service.refresh(feed.id)
      expect(result.insertedArticles).toBe(1)
      expect(repository.getFeedById(feed.id)?.url).toBe(newUrl)
      expect(repository.getRssHubSourceUrl(feed.id)).toBe(sourceUrl)
    } finally {
      database.close()
    }
  })
})

function createFeed(id: string, url: string, sourcePageUrl: string, now: number): FeedRecord {
  return {
    id,
    groupId: DEFAULT_GROUP_ID,
    name: 'RSSHub source',
    url,
    sourcePageUrl,
    sourceType: 'rss',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

function createService(repository: LibraryRepository, xml: string): RssSubscriptionService {
  const fetcher: RssFetcher = async (url) => rssPayload(url, xml)
  return new RssSubscriptionService(repository, new RssDiscoveryService(fetcher))
}

function rssPayload(url: string, xml: string): RssFetchPayload {
  return {
    finalUrl: url,
    contentType: 'application/rss+xml; charset=UTF-8',
    bytes: new TextEncoder().encode(xml)
  }
}

const RSS_ONE = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Example</title><link>https://example.com/</link>
<item><guid>one</guid><title>Article one</title><link>https://example.com/1</link><description>First</description></item>
</channel></rss>`

const RSS_TWO = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Example updated</title><link>https://example.com/</link>
<item><guid>two</guid><title>Article two</title><link>https://example.com/2</link><description>Second</description></item>
<item><guid>one</guid><title>Article one updated</title><link>https://example.com/1</link><description>First updated</description></item>
</channel></rss>`

