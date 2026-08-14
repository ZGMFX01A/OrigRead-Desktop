import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import { detectAutomaticWebsiteLists } from './automatic-website-list-detector'

const sourceUrl = 'https://news.example.com/'
const fetchedAt = 1_786_000_000_000

describe('Android website fixture parity', () => {
  it('supports the same common static list structures as Android', () => {
    const cases: Array<[string, string, number]> = [
      ['stateful-list.html', '/news/2026/08/05/stateful-news-', 6],
      ['table-list.html', '/notice/2026/08/05/', 5],
      ['definition-list.html', '/brief/2026/08/05/', 5],
      ['advertising-pagination.html', '/news/2026/08/05/mixed-stream-', 5],
      ['anonymous-cards.html', '/stories/2026/08/05/anonymous-card-', 5],
      ['query-id-list.html', '/view.php?', 5],
      ['nested-card-list.html', '/features/2026/08/05/nested-feature-', 5],
      ['mixed-separators.html', '/updates/2026/08/05/update-item-', 5],
      ['multi-link-card.html', '/reviews/2026/08/05/multi-link-review-', 5],
      ['pinned-list.html', '/pinned/2026/08/05/pinned-story-', 5],
      ['responsive-utility-list.html', '/responsive/2026/08/05/responsive-story-', 5],
      ['portal-columns.html', '/portal/2026/08/05/main-story-', 5],
      ['category-pollution.html', '/analysis/2026/08/05/category-clean-', 5],
      ['missing-date-list.html', '/nodate/2026/08/05/no-date-story-', 5],
      ['subdomain-mixed.html', 'm.news.example.com/subdomain/2026/08/05/', 5],
      ['wordpress-archive.html', '/2026/08/05/wordpress-entry-', 5],
      ['pagination-content-area.html', '/page-two/2026/08/05/page-two-story-', 5]
    ]

    for (const [name, marker, expectedCount] of cases) {
      const $ = loadFixture(name)
      const candidates = detectAutomaticWebsiteLists($, sourceUrl, sourceUrl, fetchedAt)
      const candidate = candidates.find((result) => result.articles.length === expectedCount && result.articles.every((article) => article.link.includes(marker)))
      expect(candidate, `${name} should produce matching candidate`).toBeDefined()
      const reparsed = new ConfigurableWebsiteParser(candidate!.rule).parse($, sourceUrl, sourceUrl, fetchedAt)
      expect(reparsed, `${name} cached rule should be reusable`).toHaveLength(expectedCount)
    }
  }, 20_000)

  it('query ID rules ignore tracking values and remain reusable after IDs change', () => {
    const $ = loadFixture('query-id-list.html')
    const candidate = detectAutomaticWebsiteLists($, sourceUrl, sourceUrl, fetchedAt)[0]!
    expect(candidate.rule.automaticUrlPattern).toBe('news.example.com/view.php?id={number}')
    const refreshed = cheerio.load(fixtureText('query-id-list.html').replaceAll('utm_source=homepage', 'utm_source=refresh').replaceAll('100', '900'))
    const articles = new ConfigurableWebsiteParser(candidate.rule).parse(refreshed, sourceUrl, sourceUrl, fetchedAt)
    expect(articles).toHaveLength(5)
    expect(articles.every((article) => article.link.includes('id=9'))).toBe(true)
  })

  it('cached selectors do not include transient state/responsive classes', () => {
    for (const name of ['stateful-list.html', 'pinned-list.html', 'responsive-utility-list.html']) {
      const $ = loadFixture(name)
      const candidate = detectAutomaticWebsiteLists($, sourceUrl, sourceUrl, fetchedAt)[0]!
      const selector = candidate.rule.articleSelectors[0]!
      expect(selector).not.toMatch(/\.(odd|even|first|last|sticky|pinned|featured|md-card)(?:\b|\.)/)
    }
  })
})

function fixtureText(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/website-samples', name), 'utf8')
}

function loadFixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(fixtureText(name))
}

