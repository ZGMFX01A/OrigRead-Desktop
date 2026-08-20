import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { AutomaticArticleDateExtractor } from './automatic-article-date-extractor'

describe('AutomaticArticleDateExtractor', () => {
  const fetchedAt = Date.parse('2026-08-05T10:00:00+08:00')
  const html = readFileSync(join(process.cwd(), 'tests/fixtures/website-samples/date-extraction.html'), 'utf8')
  const $ = cheerio.load(html)
  const extractor = AutomaticArticleDateExtractor.create($, 'https://news.example.com/', fetchedAt)

  it('extracts metadata, JSON-LD, time, nearby text, relative and URL dates in Android order', () => {
    expect(extractor.extract($('#meta-date').get(0)!, 'https://news.example.com/article/1001'))
      .toBe(Date.parse('2026-08-05T07:30:00+08:00'))
    expect(extractor.extract($('#jsonld-date').get(0)!, 'https://news.example.com/article/1002'))
      .toBe(Date.parse('2026-08-04T08:15:00+08:00'))
    expect(extractor.extract($('#time-date').get(0)!, 'https://news.example.com/article/1003'))
      .toBe(Date.parse('2026-08-03T11:45:00+08:00'))
    expect(extractor.extract($('#relative-date').get(0)!, 'https://news.example.com/article/1005'))
      .toBe(Date.parse('2026-08-05T08:00:00+08:00'))
    const urlDate = extractor.extract($('#url-date').get(0)!, 'https://news.example.com/news/2026/08/01/url-date-1006.html')
    const parsedUrlDate = new Date(urlDate)
    expect([parsedUrlDate.getFullYear(), parsedUrlDate.getMonth() + 1, parsedUrlDate.getDate()]).toEqual([2026, 8, 1])
  })

  it('falls back to fetchedAt when no date exists', () => {
    const fragment = cheerio.load(`<article id="plain"><a href="/article/2001">没有日期的文章</a></article>`)
    const localExtractor = AutomaticArticleDateExtractor.create(fragment, 'https://news.example.com/', fetchedAt)
    expect(localExtractor.extract(fragment('#plain').get(0)!, 'https://news.example.com/article/2001')).toBe(fetchedAt)
  })

  it('extracts Hacker News relative dates from the age class', () => {
    const fragment = cheerio.load('<article id="hn-age"><span class="age">11 hours ago</span><a href="/item?id=2002">Hacker News story</a></article>')
    const localExtractor = AutomaticArticleDateExtractor.create(fragment, 'https://news.ycombinator.com/', fetchedAt)
    expect(localExtractor.extract(fragment('#hn-age').get(0)!, 'https://news.ycombinator.com/item?id=2002'))
      .toBe(Date.parse('2026-08-04T23:00:00+08:00'))
  })
})

