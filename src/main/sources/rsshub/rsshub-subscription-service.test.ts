import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import type { RssHubProbeResult } from '../../../shared/rsshub'
import { LibraryRepository } from '../../database/library-repository'
import type { ArticleFilterRepository } from '../../filter/article-filter-repository'
import { RssSubscriptionService } from '../rss/rss-subscription-service'
import { RssHubSubscriptionService } from './rsshub-subscription-service'

describe('RssHubSubscriptionService', () => {
  it('persists the resolved feed URL and original page URL atomically', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new RssHubSubscriptionService(repository)
    try {
      const saved = service.subscribe('https://www.cls.cn/', availableResult())
      const feed = repository.getFeedById(saved.feedId)
      expect(feed?.url).toBe('https://rsshub.example.com/cls/hot')
      expect(feed?.sourcePageUrl).toBe('https://www.cls.cn/')
      expect(repository.getRssHubSourceUrl(saved.feedId)).toBe('https://www.cls.cn/')
      expect(repository.listArticles()).toHaveLength(1)
    } finally {
      database.close()
    }
  })
  it('persists provenance for a directly entered known RSSHub endpoint', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const service = new RssHubSubscriptionService(repository)
    const routeUrl = 'https://rsshub.app/telegram/channel/demo'
    const discovered = availableResult().feed!
    discovered.feedUrl = routeUrl
    discovered.sourcePageUrl = routeUrl
    try {
      const saved = service.subscribeDirect(routeUrl, discovered)
      expect(repository.getFeedById(saved.feedId)?.url).toBe(routeUrl)
      expect(repository.getRssHubSourceUrl(saved.feedId)).toBe(routeUrl)
      expect(saved).toMatchObject({ routeId: 'direct-endpoint', routeName: 'RSSHub' })
    } finally {
      database.close()
    }
  })

  it('filters the first RSSHub article batch before persistence', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const filter = {
      filterArticles: (_feedId: string, articles: any[]) => ({
        kept: articles.filter((article) => !article.title.includes('Blocked')),
        filtered: articles.filter((article) => article.title.includes('Blocked')).length
      })
    } as unknown as ArticleFilterRepository
    const service = new RssHubSubscriptionService(repository, filter)
    const result = availableResult()
    result.feed!.items.push({
      ...result.feed!.items[0]!,
      sourceId: '2',
      title: 'Blocked article',
      link: 'https://www.cls.cn/detail/2'
    })
    try {
      const saved = service.subscribe('https://www.cls.cn/', result)
      expect(saved.insertedArticles).toBe(1)
      expect(repository.listArticles().map((article) => article.title)).toEqual(['Article'])
    } finally {
      database.close()
    }
  })

  it('does not retrofit RSSHub provenance onto an already existing normal RSS feed', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const rss = new RssSubscriptionService(repository)
    const service = new RssHubSubscriptionService(repository)
    const result = availableResult()
    try {
      const existing = rss.addDiscovered(result.feed!)
      const saved = service.subscribe('https://www.cls.cn/', result)
      expect(saved.feedId).toBe(existing.feedId)
      expect(saved.insertedArticles).toBe(0)
      expect(repository.getRssHubSourceUrl(existing.feedId)).toBeNull()
    } finally {
      database.close()
    }
  })

})

function availableResult(): RssHubProbeResult {
  return {
    state: 'available',
    available: true,
    message: null,
    match: {
      route: {
        id: 'cls-hot',
        name: '热门文章排行榜',
        host: 'cls.cn',
        pathPrefix: '/',
        target: '/cls/hot'
      },
      feedUrl: 'https://rsshub.example.com/cls/hot',
      parameters: {},
      missingParameters: [],
      resolved: true
    },
    feed: {
      feedUrl: 'https://rsshub.example.com/cls/hot',
      sourcePageUrl: 'https://www.cls.cn/',
      discoveredFromPage: false,
      title: '财联社',
      siteUrl: 'https://www.cls.cn/',
      iconUrl: null,
      items: [{
        sourceId: '1',
        title: 'Article',
        link: 'https://www.cls.cn/detail/1',
        author: null,
        publishedAt: 1_000,
        descriptionHtml: '<p>Body</p>',
        contentHtml: null,
        imageUrl: null
      }]
    }
  }
}
