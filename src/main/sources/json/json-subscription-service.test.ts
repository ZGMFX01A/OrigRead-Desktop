import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import { LibraryRepository } from '../../database/library-repository'
import { JsonArticleParser } from './json-article-parser'
import { JsonRuleRepository } from './json-rule-repository'
import { JsonSourceService } from './json-source-service'
import { JsonSubscriptionService } from './json-subscription-service'

describe('JsonSubscriptionService', () => {
  it('persists probe articles without a second request and preserves read/starred state on refresh', async () => {
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new LibraryRepository(database.connection)
      const rules = new JsonRuleRepository(join(process.cwd(), '.does-not-exist-json-rule-file'))
      let body = JSON.stringify({ items: [{ id: 1, title: 'One', url: '/1' }] })
      let fetchCalls = 0
      const source = new JsonSourceService(rules, new JsonArticleParser(), async () => {
        fetchCalls += 1
        return body
      })
      const subscription = new JsonSubscriptionService(repository, source)
      const probe = {
        rule: {
          id: 'custom', name: 'Custom JSON', version: 1, enabled: true,
          hosts: ['example.com'], sourceKind: 'API' as const, endpoint: '/api/posts',
          itemsPath: '$.items[*]', titlePath: '$.title', linkPath: '$.url',
          datePath: null, authorPath: null, descriptionPath: null, imagePath: null,
          idPath: '$.id', dateFormat: null, maxItems: 50
        },
        endpointUrl: 'https://example.com/api/posts',
        sourcePageUrl: 'https://example.com/news',
        title: 'Custom JSON',
        articles: [{
          stableId: '1',
          title: 'One',
          link: 'https://example.com/1',
          author: null,
          publishedAt: 1_700_000_000_000,
          descriptionHtml: '<p>Probe body</p>',
          imageUrl: null
        }]
      }
      rules.findRuleForEndpoint = () => probe.rule

      const added = await subscription.add(probe)
      expect(fetchCalls).toBe(0)
      const first = repository.listArticles()[0]!
      expect(first.contentHtml).toBe('<p>Probe body</p>')
      repository.setArticleUnread(first.id, false)
      repository.setArticleStarred(first.id, true)

      body = JSON.stringify({ items: [
        { id: 1, title: 'One updated', url: '/1' },
        { id: 2, title: 'Two', url: '/2' }
      ] })
      const refreshed = await subscription.refresh(added.feedId)
      expect(fetchCalls).toBe(1)
      const articles = repository.listArticles()
      const original = articles.find((article) => article.url === 'https://example.com/1')!

      expect(added.insertedArticles).toBe(1)
      expect(refreshed).toMatchObject({ fetchedArticles: 2, insertedArticles: 1 })
      expect(repository.getFeedById(added.feedId)).toMatchObject({
        url: 'https://example.com/api/posts',
        sourcePageUrl: 'https://example.com/news',
        sourceType: 'json'
      })
      expect(original.title).toBe('One updated')
      expect(original.isUnread).toBe(false)
      expect(original.isStarred).toBe(true)
    } finally {
      database.close()
    }
  })
})
