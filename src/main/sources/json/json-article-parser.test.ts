import { describe, expect, it } from 'vitest'
import type { JsonRule } from '../../../shared/json-source'
import { extractNextData, extractNuxtData } from './embedded-json-extractor'
import { JsonArticleParser } from './json-article-parser'
import { firstJsonPath, queryJsonPath } from './simple-json-path'
import { createWordPressRule } from './wordpress-json-rule-factory'

describe('JsonArticleParser Android parity', () => {
  it('parses nested array timestamp and relative url', () => {
    const rule = ruleOf({
      itemsPath: '$.data.items[*]',
      titlePath: '$.title',
      linkPath: '$.path',
      datePath: '$.publishedAt',
      descriptionPath: '$.summary',
      imagePath: '$.cover',
      idPath: '$.id'
    })
    const content = JSON.stringify({
      data: {
        items: [{
          id: '42',
          title: '第一篇文章',
          path: '/posts/42',
          publishedAt: 1722470400,
          summary: '摘要',
          cover: '/images/42.jpg'
        }]
      }
    })

    const article = new JsonArticleParser().parse(
      content,
      rule,
      'https://example.com/api/posts',
      0
    )[0]!

    expect(article.title).toBe('第一篇文章')
    expect(article.link).toBe('https://example.com/posts/42')
    expect(article.imageUrl).toBe('https://example.com/images/42.jpg')
    expect(article.publishedAt).toBeGreaterThan(0)
  })

  it('decodes rendered html title and tolerates missing optional fields', () => {
    const fetchedAt = 1_700_000_000_000
    const rule = ruleOf({
      id: 'wordpress-like',
      name: 'WordPress Like',
      itemsPath: '$[*]',
      titlePath: '$.title.rendered',
      linkPath: '$.link',
      datePath: '$.missingDate',
      authorPath: '$.missingAuthor',
      descriptionPath: '$.missingDescription',
      imagePath: '$.missingImage'
    })

    const article = new JsonArticleParser().parse(
      JSON.stringify([{
        title: { rendered: '<strong>OrigRead</strong> &#8217; Release' },
        link: 'https://example.com/posts/release'
      }]),
      rule,
      'https://example.com/api/posts',
      fetchedAt
    )[0]!

    expect(article.title).toBe('OrigRead ’ Release')
    expect(article.publishedAt).toBe(fetchedAt)
    expect(article.author).toBeNull()
    expect(article.descriptionHtml).toBe('')
    expect(article.imageUrl).toBeNull()
  })

  it('keeps Android lenient JSON parsing behavior', () => {
    const rule = ruleOf({ itemsPath: '$.items[*]' })
    const article = new JsonArticleParser().parse(
      "{items:[{title:'Lenient',url:'/lenient'}]}",
      rule,
      'https://example.com/api/',
      0
    )[0]!
    expect(article.title).toBe('Lenient')
    expect(article.link).toBe('https://example.com/lenient')
  })

  it('supports array index and wildcard in restricted JSONPath', () => {
    const root = { items: [{ name: 'a' }, { name: 'b' }] }
    expect(queryJsonPath(root, '$.items[*]')).toHaveLength(2)
    expect(firstJsonPath(root, '$.items[1].name')).toBe('b')
  })

  it('extracts Next and Nuxt embedded JSON', () => {
    const html = `
      <script id="__NEXT_DATA__" type="application/json">{"props":{"items":[]}}</script>
      <script id="__NUXT_DATA__" type="application/json">[{"data":[]}]</script>
    `
    expect(extractNextData(html)).toContain('props')
    expect(extractNuxtData(html)).toContain('data')
  })

  it('creates the standard WordPress REST rule', () => {
    const rule = createWordPressRule('https://blog.example.com/news')
    expect(rule.endpoint).toBe('https://blog.example.com/wp-json/wp/v2/posts?_embed=1&per_page=30')
    expect(rule.itemsPath).toBe('$[*]')
    expect(rule.titlePath).toBe('$.title.rendered')
  })
})

function ruleOf(patch: Partial<JsonRule>): JsonRule {
  return {
    id: 'sample',
    name: 'Sample',
    version: 1,
    enabled: true,
    hosts: ['example.com'],
    sourceKind: 'API',
    endpoint: '/api/posts',
    itemsPath: '$[*]',
    titlePath: '$.title',
    linkPath: '$.url',
    datePath: null,
    authorPath: null,
    descriptionPath: null,
    imagePath: null,
    idPath: null,
    dateFormat: null,
    maxItems: 50,
    ...patch
  }
}
