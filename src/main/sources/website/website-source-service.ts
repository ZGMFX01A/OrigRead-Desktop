import { defaultWebsiteFetcher, probeFeedRecord, safeHost, isWebsiteHealthCheckFailure, findIconUrl, MAX_AUTOMATIC_HTML_CHARS } from './website-source-support'
export { WebsitePageTooComplexError } from './website-source-support'
import { WebsitePageTooComplexError } from './website-source-support'
import { WebsiteCandidateBatch, type CandidateBatch } from './website-candidate-batch'
import * as cheerio from 'cheerio'
import type { FeedRecord } from '../../../shared/library'
import type { WebsiteInspectionResult, WebsiteParseCandidate, WebsiteParsedArticle } from '../../../shared/website'
import { defaultWebsiteRule } from '../../../shared/website'

import { isReusableAutomaticWebsiteRule } from './automatic-website-list-detector'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import { isSafeDynamicFallback, rankingScore, rejectedWebsiteCandidate } from './website-candidate-scorer'
import { javaStringHash, unsignedHex } from './website-dom'
import { WebsiteParsePreferenceRepository } from './website-parse-preference-repository'
import { WebsiteRuleRepository } from './website-rule-repository'
import type { DynamicWebsiteRenderer } from './dynamic-website-render-policy'

export interface WebsiteFetchPayload {
  status: number
  finalUrl: string
  html: string
}

export type WebsiteFetcher = (url: string, signal?: AbortSignal) => Promise<WebsiteFetchPayload>

interface CandidateSelection {
  candidate: WebsiteParseCandidate
  batch: CandidateBatch
}

export class WebsiteSourceService {
  private readonly candidateBatch: WebsiteCandidateBatch
  private readonly fetcher: WebsiteFetcher
  private readonly dynamicRenderer: DynamicWebsiteRenderer | null
  private readonly selectedRuleIds = new Map<string, string>()

  constructor(
    private readonly ruleRepository: WebsiteRuleRepository,
    private readonly preferenceRepository: WebsiteParsePreferenceRepository,
    options: { fetcher?: WebsiteFetcher; dynamicRenderer?: DynamicWebsiteRenderer | null } = {}
  ) {
    this.fetcher = options.fetcher ?? defaultWebsiteFetcher
    this.dynamicRenderer = options.dynamicRenderer ?? null
    this.candidateBatch = new WebsiteCandidateBatch(ruleRepository, preferenceRepository)
  }

  async inspect(url: string, fetchedAt = Date.now(), signal?: AbortSignal): Promise<WebsiteInspectionResult> {
    const payload = await this.request(url, signal)
    return this.buildInspection(url, payload.finalUrl, { html: payload.html, fetchedAt })
  }

  async inspectDynamic(url: string, fetchedAt = Date.now(), signal?: AbortSignal): Promise<WebsiteInspectionResult> {
    if (!this.dynamicRenderer) throw new Error('动态 Chromium 渲染器不可用')
    const rendered = await this.dynamicRenderer.render(url, signal)
    try {
      return this.buildInspection(url, rendered.finalUrl, { html: rendered.html, fetchedAt, allowLowConfidenceFallback: true })
    } catch (error) {
      if (!isWebsiteHealthCheckFailure(error)) throw error
      // 与 Android 的“最后兜底仍允许用户尝试添加”保持一致：Chromium 已经成功渲染页面，
      // 只是自动规则没有提取出健康列表时，保留一个明确的低可信候选。后续刷新仍会重新
      // 运行真实解析；这里不伪造文章，也不把它当作健康候选推荐。
      return this.buildDynamicMetadataFallback(url, rendered.finalUrl, rendered.html)
    }
  }

  async evaluateCandidates(feed: FeedRecord, fetchedAt = Date.now()): Promise<WebsiteParseCandidate[]> {
    const payload = await this.request(feed.url)
    this.ensureAutomaticParsingAllowed(feed, payload.html)
    const $ = cheerio.load(payload.html)
    return this.candidateBatch.build({ feed, $, baseUrl: payload.finalUrl, fetchedAt, forceAutomaticFullScan: true, htmlLength: payload.html.length }).candidates
      .sort((left, right) => Number(right.diagnostics.state === 'AVAILABLE') - Number(left.diagnostics.state === 'AVAILABLE') || rankingScore(right.diagnostics) - rankingScore(left.diagnostics))
  }

  async fetchArticles(feed: FeedRecord, fetchedAt = Date.now()): Promise<WebsiteParsedArticle[]> {
    if (this.preferenceRepository.get(feed.id)?.dynamicRenderingEnabled === true) {
      if (!this.dynamicRenderer) throw new Error('动态 Chromium 渲染器不可用')
      const rendered = await this.dynamicRenderer.render(feed.url)
      const $ = cheerio.load(rendered.html)
      return this.parseAndRecordSelection(feed, $, { baseUrl: rendered.finalUrl, fetchedAt, allowLowConfidenceFallback: true, htmlLength: rendered.html.length })
    }
    const payload = await this.request(feed.url)
    this.ensureAutomaticParsingAllowed(feed, payload.html)
    const $ = cheerio.load(payload.html)
    return this.parseAndRecordSelection(feed, $, { baseUrl: payload.finalUrl, fetchedAt, htmlLength: payload.html.length })
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

  private async request(url: string, signal?: AbortSignal): Promise<WebsiteFetchPayload> {
    const payload = await this.fetcher(url, signal)
    if (payload.status < 200 || payload.status >= 300) throw new Error(`网站请求失败：HTTP ${payload.status}`)
    return payload
  }

  private buildInspection(
    sourceUrl: string,
    baseUrl: string,
    options: { html: string; fetchedAt: number; allowLowConfidenceFallback?: boolean }
  ): WebsiteInspectionResult {
    const { html, fetchedAt, allowLowConfidenceFallback = false } = options
    const probeFeed = probeFeedRecord(sourceUrl, fetchedAt)
    this.ensureAutomaticParsingAllowed(probeFeed, html)
    const $ = cheerio.load(html)
    const selection = this.selectBestCandidate(probeFeed, $, { baseUrl, fetchedAt, forceAutomaticFullScan: true, allowLowConfidenceFallback, htmlLength: html.length })
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

  private buildDynamicMetadataFallback(sourceUrl: string, baseUrl: string, html: string): WebsiteInspectionResult {
    const $ = cheerio.load(html)
    const host = safeHost(sourceUrl)
    const rule = defaultWebsiteRule({
      id: `dynamic-fallback:${unsignedHex(javaStringHash(sourceUrl))}`,
      name: 'Dynamic Chromium fallback',
      hosts: host ? [host] : [],
      articleSelectors: [],
      titleSelector: 'a[href]'
    })
    const candidate: WebsiteParseCandidate = {
      rule,
      articles: [],
      diagnostics: rejectedWebsiteCandidate('动态渲染完成，但未识别出稳定的文章列表')
    }
    return {
      title: $('title').first().text().trim() || host || baseUrl,
      sourceUrl,
      finalUrl: baseUrl,
      description: $('meta[name="description"]').first().attr('content') ?? '',
      iconUrl: findIconUrl($, baseUrl),
      candidate,
      candidates: [candidate]
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
    options: { baseUrl: string; fetchedAt: number; allowLowConfidenceFallback?: boolean; htmlLength: number }
  ): WebsiteParsedArticle[] {
    const fetchedAt = options.fetchedAt
    const selection = this.selectBestCandidate(feed, $, options)
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
    options: { baseUrl: string; fetchedAt: number; forceAutomaticFullScan?: boolean; allowLowConfidenceFallback?: boolean; htmlLength: number }
  ): CandidateSelection {
    const batch = this.candidateBatch.build({ feed, $, ...options, includeRejectedAutomatic: options.allowLowConfidenceFallback })
    const accepted = batch.candidates.filter((candidate) => candidate.diagnostics.state === 'AVAILABLE')
    const preferredRuleId = this.preferenceRepository.get(feed.id)?.preferredRuleId
    const selected = accepted.find((candidate) => candidate.rule.id === preferredRuleId)
      ?? accepted.reduce<WebsiteParseCandidate | null>((best, candidate) => !best || rankingScore(candidate.diagnostics) > rankingScore(best.diagnostics) ? candidate : best, null)
      ?? (options.allowLowConfidenceFallback
        ? batch.candidates.filter((candidate) => isSafeDynamicFallback(candidate.diagnostics))
          .reduce<WebsiteParseCandidate | null>((best, candidate) => !best || rankingScore(candidate.diagnostics) > rankingScore(best.diagnostics) ? candidate : best, null)
        : null)
    if (!selected) throw new Error(`当前网站的解析规则均未通过健康检查：${feed.url}`)
    return { candidate: selected, batch }
  }

}
