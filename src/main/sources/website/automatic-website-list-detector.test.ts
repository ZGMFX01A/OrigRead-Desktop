import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cheerio from 'cheerio'
import { describe, expect, it } from 'vitest'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import {
  AUTOMATIC_WEBSITE_RULE_VERSION,
  detectAutomaticWebsiteLists,
  isReusableAutomaticWebsiteRule
} from './automatic-website-list-detector'

const fetchedAt = 1_786_000_000_000
const sourceUrl = 'https://news.example.com/'

describe('detectAutomaticWebsiteLists', () => {
  it('clusters article URLs and removes category/author/tag/search/external pollution', () => {
    const $ = loadFixture('url-clusters.html')
    const candidate = detectAutomaticWebsiteLists($, sourceUrl, sourceUrl, fetchedAt)[0]!
    expect(candidate.articles).toHaveLength(5)
    expect(candidate.articles.every((article) => article.link.includes('/news/2026/08/05/'))).toBe(true)
    expect(candidate.articles.some((article) => /\/category\/|\/author\/|\/tag\/|\/search/.test(article.link))).toBe(false)
    expect(candidate.articles.some((article) => article.link.includes('external.example.net'))).toBe(false)
  })

  it('keeps rule ID stable when concrete article IDs change and cached rule reparses the new page', () => {
    const first$ = loadFixture('url-clusters.html')
    const first = detectAutomaticWebsiteLists(first$, sourceUrl, sourceUrl, fetchedAt)[0]!
    const changedHtml = fixtureText('url-clusters.html').replaceAll('100', '900')
    const second$ = cheerio.load(changedHtml)
    const second = detectAutomaticWebsiteLists(second$, sourceUrl, sourceUrl, fetchedAt)[0]!
    expect(second.rule.id).toBe(first.rule.id)
    expect(isReusableAutomaticWebsiteRule(first.rule)).toBe(true)
    expect(new ConfigurableWebsiteParser(first.rule).parse(second$, sourceUrl, sourceUrl, fetchedAt)).toHaveLength(5)
  })

  it('invalidates older cached automatic rule versions', () => {
    const current = detectAutomaticWebsiteLists(loadFixture('url-clusters.html'), sourceUrl, sourceUrl, fetchedAt)[0]!.rule
    expect(current.version).toBe(AUTOMATIC_WEBSITE_RULE_VERSION)
    expect(isReusableAutomaticWebsiteRule({ ...current, version: 6 })).toBe(false)
    expect(isReusableAutomaticWebsiteRule({ ...current, version: 5 })).toBe(false)
  })

  it('main latest list outranks larger sidebar ranking list', () => {
    const candidates = detectAutomaticWebsiteLists(loadFixture('region-priority.html'), sourceUrl, sourceUrl, fetchedAt)
    expect(candidates[0]!.articles).toHaveLength(5)
    expect(candidates[0]!.articles.every((article) => article.link.includes('/news/2026/08/05/'))).toBe(true)
    expect(candidates[0]!.diagnostics.regionScore).toBeGreaterThan(0)
  })

  it('history score can promote a previously stable neutral candidate', () => {
    const html = `<html><body><section><div class="alpha-list">${cards('alpha', 100)}</div></section><section><div class="beta-list">${cards('beta', 200)}</div></section></body></html>`
    const baseline$ = cheerio.load(html)
    const baseline = detectAutomaticWebsiteLists(baseline$, sourceUrl, sourceUrl, fetchedAt)
    expect(baseline.length).toBeGreaterThanOrEqual(2)
    const stableRuleId = baseline[1]!.rule.id
    const rescored$ = cheerio.load(html)
    const rescored = detectAutomaticWebsiteLists(rescored$, sourceUrl, sourceUrl, fetchedAt, (id) => id === stableRuleId ? 12 : 0)
    expect(rescored[0]!.rule.id).toBe(stableRuleId)
    expect(rescored[0]!.diagnostics.historyScore).toBe(12)
  })
})

function cards(prefix: string, start: number): string {
  return Array.from({ length: 5 }, (_, index) => `<article><h2><a href="/${prefix}/${start + index}.html">${prefix} article ${index + 1}</a></h2></article>`).join('')
}

function fixtureText(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/website-samples', name), 'utf8')
}

function loadFixture(name: string): cheerio.CheerioAPI {
  return cheerio.load(fixtureText(name))
}

