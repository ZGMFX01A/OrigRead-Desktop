import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import type { RssHubProbeResult } from '../../../shared/rsshub'
import { LibraryRepository } from '../../database/library-repository'
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
