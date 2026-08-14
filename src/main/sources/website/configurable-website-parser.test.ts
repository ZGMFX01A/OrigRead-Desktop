import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { defaultWebsiteRule } from '../../../shared/website'
import { ConfigurableWebsiteParser } from './configurable-website-parser'

describe('ConfigurableWebsiteParser', () => {
  it('uses the first matching selector, resolves links/images and preserves Android HH:mm/MM-dd date behavior', () => {
    const fetchedAt = new Date(2026, 7, 5, 12, 0, 0).getTime()
    const $ = cheerio.load(`<ul class="news"><li class="item"><a class="title" href="/0/123/456.htm">足够长的真实新闻标题</a><b>09:30</b><img data-original="/cover.jpg"></li></ul>`)
    const rule = defaultWebsiteRule({
      id: 'sample', name: 'Sample', hosts: ['example.com'],
      articleSelectors: ['.missing', 'ul.news li.item'],
      titleSelector: 'a.title',
      dateRules: [{ selector: 'b', pattern: 'HH:mm' }],
      imageSelector: 'img',
      includeUrlRegex: '^https?://example\\.com/0/\\d+/\\d+\\.htm$'
    })
    const article = new ConfigurableWebsiteParser(rule).parse($, 'https://example.com/', 'https://example.com/', fetchedAt)[0]!
    expect(article.link).toBe('https://example.com/0/123/456.htm')
    expect(article.imageUrl).toBe('https://example.com/cover.jpg')
    const date = new Date(article.publishedAt)
    expect([date.getHours(), date.getMinutes()]).toEqual([9, 30])
  })

  it('URL_ID_RANGE cleanup never deletes starred articles', () => {
    const rule = defaultWebsiteRule({
      id: 'cleanup', name: 'Cleanup', hosts: ['example.com'], articleSelectors: ['li'], titleSelector: 'a',
      cleanupMode: 'URL_ID_RANGE', urlIdRegex: '/(\\d+)\\.htm'
    })
    const parser = new ConfigurableWebsiteParser(rule)
    const fetched = [100, 99].map((id) => ({ stableId: String(id), title: `文章 ${id}`, link: `https://example.com/${id}.htm`, author: null, publishedAt: 0, descriptionHtml: '', imageUrl: null }))
    expect(parser.findObsoleteArticleIds([
      { id: '101', url: 'https://example.com/101.htm', isStarred: false },
      { id: '102', url: 'https://example.com/102.htm', isStarred: true },
      { id: '98', url: 'https://example.com/98.htm', isStarred: false }
    ], fetched)).toEqual(['101'])
  })
})

