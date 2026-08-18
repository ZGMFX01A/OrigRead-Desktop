import * as cheerio from 'cheerio'
import type { FeedRecord } from '../../../shared/library'
import type {
  WebsiteInspectionResult,
  WebsiteParseCandidate,
  WebsiteParsedArticle,
  WebsiteRule
} from '../../../shared/website'
import { automaticRuleHistoryScore, shouldRunAutomaticFullScan } from './automatic-rule-stability-scorer'
import {
  detectAutomaticWebsiteLists,
  isReusableAutomaticWebsiteRule
} from './automatic-website-list-detector'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import { isSafeDynamicFallback, rankingScore, rejectedWebsiteCandidate, scoreWebsiteCandidate } from './website-candidate-scorer'
import { javaStringHash, resolveHttpUrl, unsignedHex } from './website-dom'
import { WebsiteParsePreferenceRepository, type WebsiteParsePreference } from './website-parse-preference-repository'
import { WebsiteRuleRepository } from './website-rule-repository'
import type { DynamicWebsiteRenderer } from './dynamic-website-render-policy'
import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'

const MAX_AUTOMATIC_HTML_CHARS = 750_000

export class WebsitePageTooComplexError extends Error {
  constructor() {
    super('页面过大，已超过自动 DOM 识别资源上限')
    this.name = 'WebsitePageTooComplexError'
  }
}

export interface WebsiteFetchPayload {
  status: number
  finalUrl: string
  html: string
}

export type WebsiteFetcher = (url: string) => Promise<WebsiteFetchPayload>

interface CandidateBatch {
  candidates: WebsiteParseCandidate[]
  automaticFullScan: boolean
}

interface CandidateSelection {
  candidate: WebsiteParseCandidate
  batch: CandidateBatch
}

export class WebsiteSourceService {
  private readonly selectedRuleIds = new Map<string, string>()

  constructor(
    private readonly ruleRepository: WebsiteRuleRepository,
    private readonly preferenceRepository: WebsiteParsePreferenceRepository,
    private readonly fetcher: WebsiteFetcher = defaultWebsiteFetcher,
    private readonly dynamicRenderer: DynamicWebsiteRenderer | null = null
  ) {}

  async inspect(url: string, fetchedAt = Date.now()): Promise<WebsiteInspectionResult> {
    const payload = await this.request(url)
    return this.buildInspection(url, payload.finalUrl, payload.html, fetchedAt)
  }

  async inspectDynamic(url: string, fetchedAt = Date.now()): Promise<WebsiteInspectionResult> {
    if (!this.dynamicRenderer) throw new Error('动态 Chromium 渲染器不可用')
    const rendered = await this.dynamicRenderer.render(url)
    return this.buildInspection(url, rendered.finalUrl, rendered.html, fetchedAt, true)
  }

  async evaluateCandidates(feed: FeedRecord, fetchedAt = Date.now()): Promise<WebsiteParseCandidate[]> {
    const payload = await this.request(feed.url)
    this.ensureAutomaticParsingAllowed(feed, payload.html)
    const $ = cheerio.load(payload.html)
    return this.buildCandidateBatch(feed, $, payload.finalUrl, fetchedAt, true).candidates
      .sort((left, right) => Number(right.diagnostics.state === 'AVAILABLE') - Number(left.diagnostics.state === 'AVAILABLE') || rankingScore(right.diagnostics) - rankingScore(left.diagnostics))
  }

  async fetchArticles(feed: FeedRecord, fetchedAt = Date.now()): Promise<WebsiteParsedArticle[]> {
    if (this.preferenceRepository.get(feed.id)?.dynamicRenderingEnabled === true) {
      if (!this.dynamicRenderer) throw new Error('动态 Chromium 渲染器不可用')
      const rendered = await this.dynamicRenderer.render(feed.url)
      const $ = cheerio.load(rendered.html)
      return this.parseAndRecordSelection(feed, $, rendered.finalUrl, fetchedAt, true)
    }
    const payload = await this.request(feed.url)
    this.ensureAutomaticParsingAllowed(feed, payload.html)
    const $ = cheerio.load(payload.html)
    return this.parseAndRecordSelection(feed, $, payload.finalUrl, fetchedAt)
  }

  getParsePreference(feedId: string) {
    return this.preferenceRepository.get(feedId)
  }

  getRuleName(ruleId: string | null): string | null {
    if (!ruleId) return null
    if (ruleId.startsWith('auto-dom:')) return 'Smart detection'
    return this.ruleRepository.findRuleById(ruleId)?.name ?? null
  }

  setPreferredRule(feedId: string, ruleId: string | null, ruleName: string | null = null): void {
    this.preferenceRepository.setPreferredRule(feedId, ruleId, ruleName)
  }

  setDynamicRenderingEnabled(feedId: string, enabled: boolean): void {
    this.preferenceRepository.setDynamicRenderingEnabled(feedId, enabled)
  }

  hasRule(url: string): boolean {
    return this.ruleRepository.findRules(url).length > 0
  }

  findObsoleteArticleIds(
    feed: FeedRecord,
    existingArticles: Array<{ id: string; url: string | null; isStarred: boolean }>,
    fetchedArticles: WebsiteParsedArticle[]
  ): string[] {
    const selectedRuleId = this.selectedRuleIds.get(feed.id)
    this.selectedRuleIds.delete(feed.id)
    if (selectedRuleId?.startsWith('auto-dom:')) return []
    const rule = selectedRuleId ? this.ruleRepository.findRuleById(selectedRuleId) : this.ruleRepository.findRule(feed.url)
    return rule ? new ConfigurableWebsiteParser(rule).findObsoleteArticleIds(existingArticles, fetchedArticles) : []
  }

  private async request(url: string): Promise<WebsiteFetchPayload> {
    const payload = await this.fetcher(url)
    if (payload.status < 200 || payload.status >= 300) throw new Error(`网站请求失败：HTTP ${payload.status}`)
    return payload
  }

  private buildInspection(
    sourceUrl: string,
    baseUrl: string,
    html: string,
    fetchedAt: number,
    allowLowConfidenceFallback = false
  ): WebsiteInspectionResult {
    const probeFeed = probeFeedRecord(sourceUrl, fetchedAt)
    this.ensureAutomaticParsingAllowed(probeFeed, html)
    const $ = cheerio.load(html)
    const selection = this.selectBestCandidate(probeFeed, $, baseUrl, fetchedAt, true, allowLowConfidenceFallback)
    const title = $('title').first().text().trim() || safeHost(sourceUrl) || baseUrl
    const description = $('meta[name="description"]').first().attr('content') ?? ''
    const iconUrl = findIconUrl($, baseUrl)
    return {
      title,
      sourceUrl,
      finalUrl: baseUrl,
      description,
      iconUrl,
      candidate: selection.candidate,
      candidates: selection.batch.candidates
    }
  }

  private ensureAutomaticParsingAllowed(feed: FeedRecord, html: string): void {
    const hasManualRule = this.ruleRepository.findRules(feed.url).length > 0
    const cached = this.preferenceRepository.get(feed.id)?.cachedAutomaticRule
    const hasReusableCache = cached ? isReusableAutomaticWebsiteRule(cached) : false
    if (!hasManualRule && !hasReusableCache && html.length > MAX_AUTOMATIC_HTML_CHARS) throw new WebsitePageTooComplexError()
  }

  private parseAndRecordSelection(
    feed: FeedRecord,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    fetchedAt: number,
    allowLowConfidenceFallback = false
  ): WebsiteParsedArticle[] {
    const selection = this.selectBestCandidate(feed, $, baseUrl, fetchedAt, false, allowLowConfidenceFallback)
    const candidate = selection.candidate
    this.selectedRuleIds.set(feed.id, candidate.rule.id)
    if (isReusableAutomaticWebsiteRule(candidate.rule)) {
      const cachedId = this.preferenceRepository.get(feed.id)?.cachedAutomaticRule?.id
      if (cachedId !== candidate.rule.id) this.preferenceRepository.saveAutomaticRule(feed.id, candidate.rule)
      this.preferenceRepository.recordAutomaticSelection(
        feed.id,
        candidate.rule.id,
        new Set(selection.batch.candidates.map((item) => item.rule.id)),
        selection.batch.automaticFullScan,
        fetchedAt
      )
    }
    this.preferenceRepository.saveLastSelection(feed.id, candidate)
    return candidate.articles
  }

  private selectBestCandidate(
    feed: FeedRecord,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    fetchedAt: number,
    forceAutomaticFullScan = false,
    allowLowConfidenceFallback = false
  ): CandidateSelection {
    const batch = this.buildCandidateBatch(feed, $, baseUrl, fetchedAt, forceAutomaticFullScan, allowLowConfidenceFallback)
    const accepted = batch.candidates.filter((candidate) => candidate.diagnostics.state === 'AVAILABLE')
    const preferredRuleId = this.preferenceRepository.get(feed.id)?.preferredRuleId
    const selected = accepted.find((candidate) => candidate.rule.id === preferredRuleId)
      ?? accepted.reduce<WebsiteParseCandidate | null>((best, candidate) => !best || rankingScore(candidate.diagnostics) > rankingScore(best.diagnostics) ? candidate : best, null)
      ?? (allowLowConfidenceFallback
        ? batch.candidates.filter((candidate) => isSafeDynamicFallback(candidate.diagnostics))
          .reduce<WebsiteParseCandidate | null>((best, candidate) => !best || rankingScore(candidate.diagnostics) > rankingScore(best.diagnostics) ? candidate : best, null)
        : null)
    if (!selected) throw new Error(`当前网站的解析规则均未通过健康检查：${feed.url}`)
    return { candidate: selected, batch }
  }

  private buildCandidateBatch(
    feed: FeedRecord,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    fetchedAt: number,
    forceAutomaticFullScan: boolean,
    includeRejectedAutomatic = false
  ): CandidateBatch {
    const rules = this.ruleRepository.findRules(feed.url)
    if (rules.length > 0) {
      return { candidates: rules.map((rule) => this.parseRuleCandidate(rule, $, baseUrl, feed, fetchedAt)), automaticFullScan: false }
    }

    const preference = this.preferenceRepository.get(feed.id)
    const cachedRule = preference?.cachedAutomaticRule
    if (cachedRule) {
      if (isReusableAutomaticWebsiteRule(cachedRule)) {
        const cachedCandidate = this.parseRuleCandidate(cachedRule, $, baseUrl, feed, fetchedAt, preference)
        if (cachedCandidate.diagnostics.state === 'AVAILABLE' && !forceAutomaticFullScan && !shouldRunAutomaticFullScan(preference)) {
          return { candidates: [cachedCandidate], automaticFullScan: false }
        }
        if (cachedCandidate.diagnostics.state === 'AVAILABLE') {
          const detected = this.detectAutomaticCandidates($, baseUrl, feed, fetchedAt, preference, includeRejectedAutomatic)
          const merged = new Map<string, WebsiteParseCandidate>()
          for (const candidate of [...detected, cachedCandidate]) if (!merged.has(candidate.rule.id)) merged.set(candidate.rule.id, candidate)
          return { candidates: [...merged.values()], automaticFullScan: true }
        }
      }
      this.preferenceRepository.clearAutomaticRule(feed.id)
    }
    return { candidates: this.detectAutomaticCandidates($, baseUrl, feed, fetchedAt, preference, includeRejectedAutomatic), automaticFullScan: true }
  }

  private detectAutomaticCandidates(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    feed: FeedRecord,
    fetchedAt: number,
    preference: WebsiteParsePreference | null,
    includeRejected = false
  ): WebsiteParseCandidate[] {
    return detectAutomaticWebsiteLists(
      $,
      baseUrl,
      feed.url,
      fetchedAt,
      (ruleId) => automaticRuleHistoryScore(preference, ruleId),
      includeRejected
    )
  }

  private parseRuleCandidate(
    rule: WebsiteRule,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    feed: FeedRecord,
    fetchedAt: number,
    preference: WebsiteParsePreference | null = null
  ): WebsiteParseCandidate {
    try {
      const articles = new ConfigurableWebsiteParser(rule).parse($, baseUrl, feed.url, fetchedAt)
      const diagnostics = scoreWebsiteCandidate(articles, fetchedAt)
      diagnostics.regionScore = rule.automaticRegionScore
      diagnostics.historyScore = rule.id.startsWith('auto-dom:') ? automaticRuleHistoryScore(preference, rule.id) : 0
      return { rule, articles, diagnostics }
    } catch (error) {
      return { rule, articles: [], diagnostics: rejectedWebsiteCandidate(error instanceof Error ? error.message : 'Parsing failed') }
    }
  }
}

async function defaultWebsiteFetcher(url: string): Promise<WebsiteFetchPayload> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(8_000),
    headers: {
      'user-agent': DESKTOP_BROWSER_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  })
  return { status: response.status, finalUrl: response.url || url, html: await response.text() }
}

function probeFeedRecord(url: string, now: number): FeedRecord {
  return {
    id: `website-probe:${unsignedHex(javaStringHash(url))}`,
    groupId: 'website-probe',
    name: 'Website Probe',
    url,
    sourcePageUrl: url,
    sourceType: 'website',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

function findIconUrl($: cheerio.CheerioAPI, baseUrl: string): string | null {
  for (const link of $('link[href]').toArray()) {
    const rel = ($(link).attr('rel') ?? '').trim().toLowerCase()
    if (!/^(shortcut\s+)?icon$/.test(rel)) continue
    const href = $(link).attr('href')
    if (!href) continue
    const resolved = resolveHttpUrl(baseUrl, href)
    if (resolved) return resolved
  }
  return null
}

