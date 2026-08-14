import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JsonRule } from '../../../shared/json-source'
import { JsonArticleParser } from './json-article-parser'
import { JsonRuleRepository } from './json-rule-repository'
import { JsonSourceService, type JsonTextFetcher } from './json-source-service'

describe('JsonSourceService Android parity', () => {
  it('automatically detects WordPress installed under subdirectory', async () => {
    const requests: string[] = []
    const fetcher: JsonTextFetcher = async (url) => {
      requests.push(new URL(url).pathname + new URL(url).search)
      return wordpressResponse('WordPress article', 'https://example.com/article/7', 7)
    }
    const service = serviceOf(fetcher)

    const result = await service.probe('https://example.com/news/')

    expect(result?.articles[0]?.title).toBe('WordPress article')
    expect(requests[0]).toBe('/news/wp-json/wp/v2/posts?_embed=1&per_page=30')
  })

  it('falls back to root WordPress installation', async () => {
    const requests: string[] = []
    const fetcher: JsonTextFetcher = async (url) => {
      const path = new URL(url).pathname + new URL(url).search
      requests.push(path)
      if (path.startsWith('/news/wp-json/')) throw new Error('HTTP 404')
      return wordpressResponse('Root WordPress article', 'https://example.com/article/8', 8)
    }
    const result = await serviceOf(fetcher).probe('https://example.com/news/')

    expect(result).not.toBeNull()
    expect(requests).toEqual([
      '/news/wp-json/wp/v2/posts?_embed=1&per_page=30',
      '/wp-json/wp/v2/posts?_embed=1&per_page=30'
    ])
  })

  it('does not misidentify an invalid WordPress response', async () => {
    const result = await serviceOf(async () => '<html>not json</html>').probe('https://example.com/news')
    expect(result).toBeNull()
  })

  it('prefers an imported rule before WordPress auto detection', async () => {
    const repository = new JsonRuleRepository(join(process.cwd(), '.does-not-exist-json-rule-file'))
    const imported: JsonRule = {
      id: 'custom', name: 'Custom API', version: 1, enabled: true,
      hosts: ['example.com'], sourceKind: 'API', endpoint: '/api/custom',
      itemsPath: '$.items[*]', titlePath: '$.title', linkPath: '$.url',
      datePath: null, authorPath: null, descriptionPath: null, imagePath: null,
      idPath: null, dateFormat: null, maxItems: 50
    }
    repository.findRules = () => [imported]
    const requests: string[] = []
    const service = new JsonSourceService(repository, new JsonArticleParser(), async (url) => {
      requests.push(url)
      return JSON.stringify({ items: [{ title: 'Custom', url: '/post/1' }] })
    })
    const result = await service.probe('https://example.com/news')
    expect(result?.rule.id).toBe('custom')
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0]!).pathname).toBe('/api/custom')
  })

  it('reads Next and Nuxt embedded JSON without executing JavaScript', async () => {
    const nextRule: JsonRule = {
      id: 'next', name: 'Next', version: 1, enabled: true, hosts: ['example.com'],
      sourceKind: 'NEXT_DATA', endpoint: '.', itemsPath: '$.props.items[*]',
      titlePath: '$.title', linkPath: '$.url', datePath: null, authorPath: null,
      descriptionPath: null, imagePath: null, idPath: null, dateFormat: null, maxItems: 50
    }
    const repository = new JsonRuleRepository(join(process.cwd(), '.does-not-exist-json-rule-file'))
    repository.findRules = () => [nextRule]
    const service = new JsonSourceService(repository, new JsonArticleParser(), async () => `
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"items":[{"title":"Next article","url":"/next/1"}]}}
      </script>
    `)
    expect((await service.probe('https://example.com/news'))?.articles[0]?.title).toBe('Next article')
  })
})

function serviceOf(fetcher: JsonTextFetcher): JsonSourceService {
  return new JsonSourceService(
    new JsonRuleRepository(join(process.cwd(), '.does-not-exist-json-rule-file')),
    new JsonArticleParser(),
    fetcher
  )
}

function wordpressResponse(title: string, link: string, id: number): string {
  return JSON.stringify([{
    id,
    date_gmt: '2026-08-03T08:00:00',
    link,
    title: { rendered: title },
    excerpt: { rendered: 'Article summary' }
  }])
}
