import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeedRecord } from '../../../shared/library'
import { WebsiteParsePreferenceRepository } from './website-parse-preference-repository'
import { WebsiteRuleRepository } from './website-rule-repository'
import {
  WebsitePageTooComplexError,
  WebsiteSourceService,
  type WebsiteFetchPayload
} from './website-source-service'
import { automaticRuleHistoryScore } from './automatic-rule-stability-scorer'

const dirs: string[] = []
const FETCHED_AT = 1_786_000_000_000

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('WebsiteSourceService parity', () => {
  it('static inspection returns real parsed entries for unified source scoring', async () => {
    const { service } = createService([payload(fixture('url-clusters.html'))])
    const inspected = await service.inspect('https://news.example.com/', FETCHED_AT)
    expect(inspected.candidate.articles).toHaveLength(5)
    expect(new Set(inspected.candidate.articles.map((article) => article.link))).toHaveLength(5)
    expect(inspected.candidate.articles[0]!.publishedAt).toBeGreaterThan(0)
  })

  it('reuses cached rule and reanalyzes immediately after selector invalidation', async () => {
    const html = fixture('url-clusters.html')
    const { service, preferenceRepository } = createService([
      payload(html),
      payload(html.replaceAll('100', '900')),
      payload(changedStructureHtml())
    ])
    const feed = websiteFeed()

    expect(await service.fetchArticles(feed, FETCHED_AT)).toHaveLength(5)
    const first = preferenceRepository.get(feed.id)!
    const firstRule = first.cachedAutomaticRule!
    expect(firstRule).toBeTruthy()

    expect(await service.fetchArticles(feed, FETCHED_AT)).toHaveLength(5)
    const second = preferenceRepository.get(feed.id)!
    expect(second.cachedAutomaticRule?.id).toBe(firstRule.id)
    expect(second.automaticRuleUpdatedAt).toBe(first.automaticRuleUpdatedAt)

    expect(await service.fetchArticles(feed, FETCHED_AT)).toHaveLength(4)
    const replacement = preferenceRepository.get(feed.id)?.cachedAutomaticRule
    expect(replacement?.id).not.toBe(firstRule.id)
    expect(replacement?.automaticUrlPattern).toBe('news.example.com/posts/{year}/{month}/{day}/{token}.html')
  })

  it('periodically rescans stable cached rule and accumulates Android history score', async () => {
    const html = fixture('url-clusters.html')
    const { service, preferenceRepository } = createService(
      Array.from({ length: 7 }, (_, index) => payload(html.replaceAll('100', `${index + 1}00`)))
    )
    const feed = websiteFeed()
    for (let index = 0; index < 7; index += 1) expect(await service.fetchArticles(feed, FETCHED_AT)).toHaveLength(5)

    const preference = preferenceRepository.get(feed.id)!
    const cachedRuleId = preference.cachedAutomaticRule!.id
    const history = preference.automaticRuleHistory.find((item) => item.ruleId === cachedRuleId)!
    expect(preference.automaticFullScanCount).toBe(2)
    expect(preference.automaticReuseSinceFullScan).toBe(0)
    expect(preference.automaticSelectionStreak).toBe(7)
    expect(history.fullScanAppearances).toBe(2)
    expect(history.successfulSelections).toBe(7)
    expect(automaticRuleHistoryScore(preference, cachedRuleId)).toBe(12)
  })

  it('blocks oversized pages only when no manual/cached parser exists', async () => {
    const oversized = `<html><body>${'x'.repeat(760_000)}<div class="news-list">${cards()}</div></body></html>`
    const auto = createService([payload(oversized)])
    await expect(auto.service.inspect('https://news.example.com/', FETCHED_AT)).rejects.toBeInstanceOf(WebsitePageTooComplexError)

    const manual = createService([payload(oversized)])
    manual.ruleRepository.importRules(JSON.stringify({ rules: [{
      id: 'manual-large', name: 'Manual Large', hosts: ['news.example.com'],
      articleSelectors: ['.news-list article'], titleSelector: 'a.title'
    }] }))
    const inspected = await manual.service.inspect('https://news.example.com/', FETCHED_AT)
    expect(inspected.candidate.articles).toHaveLength(5)
  })

  it('uses only the dynamic renderer when source preference requires dynamic rendering', async () => {
    let requests = 0
    const dir = mkdtempSync(join(tmpdir(), 'origread-website-dynamic-'))
    dirs.push(dir)
    const preferenceRepository = new WebsiteParsePreferenceRepository(join(dir, 'prefs.json'))
    const ruleRepository = new WebsiteRuleRepository(join(dir, 'rules.json'))
    const service = new WebsiteSourceService(ruleRepository, preferenceRepository, async () => {
      requests += 1
      return payload(fixture('url-clusters.html'))
    }, {
      render: async () => ({ finalUrl: 'https://news.example.com/', html: fixture('url-clusters.html') })
    })
    const feed = websiteFeed()
    preferenceRepository.setDynamicRenderingEnabled(feed.id, true)
    expect(await service.fetchArticles(feed, FETCHED_AT)).toHaveLength(5)
    expect(requests).toBe(0)
  })
})

function createService(queue: WebsiteFetchPayload[], customFetcher?: (url: string) => Promise<WebsiteFetchPayload>) {
  const dir = mkdtempSync(join(tmpdir(), 'origread-website-service-'))
  dirs.push(dir)
  const preferenceRepository = new WebsiteParsePreferenceRepository(join(dir, 'website-parse-preferences.json'))
  const ruleRepository = new WebsiteRuleRepository(join(dir, 'website-rules.json'))
  const fetcher = customFetcher ?? (async () => {
    const next = queue.shift()
    if (!next) throw new Error('No queued response')
    return next
  })
  return {
    preferenceRepository,
    ruleRepository,
    service: new WebsiteSourceService(ruleRepository, preferenceRepository, fetcher)
  }
}

function websiteFeed(): FeedRecord {
  return {
    id: 'website-feed', groupId: 'group-1', name: 'Automatic website',
    url: 'https://news.example.com/', sourcePageUrl: 'https://news.example.com/', sourceType: 'website',
    icon: null, isNotification: false, isFullContent: false, isBrowser: false, dynamicRendering: false,
    createdAt: 1, updatedAt: 1
  }
}

function payload(html: string): WebsiteFetchPayload {
  return { status: 200, finalUrl: 'https://news.example.com/', html }
}

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests/fixtures/website-samples', name), 'utf8')
}

function changedStructureHtml(): string {
  return `<html><body><main><div class="stream">
    <div class="entry"><h3><a class="headline" href="/posts/2026/08/05/cache-rebuilt-2001.html">缓存失效后重新识别文章一</a></h3></div>
    <div class="entry"><h3><a class="headline" href="/posts/2026/08/05/cache-rebuilt-2002.html">缓存失效后重新识别文章二</a></h3></div>
    <div class="entry"><h3><a class="headline" href="/posts/2026/08/05/cache-rebuilt-2003.html">缓存失效后重新识别文章三</a></h3></div>
    <div class="entry"><h3><a class="headline" href="/posts/2026/08/05/cache-rebuilt-2004.html">缓存失效后重新识别文章四</a></h3></div>
  </div></main></body></html>`
}

function cards(): string {
  return Array.from({ length: 5 }, (_, index) => `<article><a class="title" href="/news/${100 + index}.html">足够长的新闻文章标题 ${index + 1}</a></article>`).join('')
}

