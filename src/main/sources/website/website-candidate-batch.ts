import type * as cheerio from 'cheerio'
import type { FeedRecord } from '../../../shared/library'
import type { WebsiteParseCandidate, WebsiteRule } from '../../../shared/website'
import { automaticRuleHistoryScore, shouldRunAutomaticFullScan } from './automatic-rule-stability-scorer'
import { detectAutomaticWebsiteLists, isReusableAutomaticWebsiteRule } from './automatic-website-list-detector'
import { ConfigurableWebsiteParser } from './configurable-website-parser'
import { rejectedWebsiteCandidate, scoreWebsiteCandidate } from './website-candidate-scorer'
import type { WebsiteParsePreferenceRepository, WebsiteParsePreference } from './website-parse-preference-repository'
import type { WebsiteRuleRepository } from './website-rule-repository'
import { MAX_AUTOMATIC_HTML_CHARS, WebsitePageTooComplexError } from './website-source-support'

export interface CandidateBatch { candidates: WebsiteParseCandidate[]; automaticFullScan: boolean }
export interface WebsiteCandidateContext {
  feed: FeedRecord; $: cheerio.CheerioAPI; baseUrl: string; fetchedAt: number
  forceAutomaticFullScan?: boolean; includeRejectedAutomatic?: boolean; htmlLength?: number
}

/** 健康手动规则优先；全部失效时保留失败诊断，再进入既有自动 DOM 识别。 */
export class WebsiteCandidateBatch {
  constructor(private readonly rules: WebsiteRuleRepository, private readonly preferences: WebsiteParsePreferenceRepository) {}

  build(options: WebsiteCandidateContext): CandidateBatch {
    const manual = this.rules.findRules(options.feed.url).map((rule) => this.parseRule(rule, options))
    if (manual.some((candidate) => candidate.diagnostics.state === 'AVAILABLE')) return { candidates: manual, automaticFullScan: false }
    const preference = this.preferences.get(options.feed.id)
    const cached = preference?.cachedAutomaticRule
    const reusable = cached && isReusableAutomaticWebsiteRule(cached)
    if (!reusable && (options.htmlLength ?? 0) > MAX_AUTOMATIC_HTML_CHARS) throw new WebsitePageTooComplexError()
    if (reusable) {
      const candidate = this.parseRule(cached, options, preference)
      if (candidate.diagnostics.state === 'AVAILABLE') return this.reuseOrRescan(candidate, manual, { ...options, preference })
      this.preferences.clearAutomaticRule(options.feed.id)
    } else if (cached) {
      this.preferences.clearAutomaticRule(options.feed.id)
    }
    return { candidates: [...manual, ...this.detect(options, preference)], automaticFullScan: true }
  }

  /** 缓存健康时按既有周期复查，失败手动规则继续留在候选诊断中。 */
  private reuseOrRescan(cached: WebsiteParseCandidate, manual: WebsiteParseCandidate[], context: WebsiteCandidateContext & {
    preference: WebsiteParsePreference | null
  }): CandidateBatch {
    const preference = context.preference
    if (!context.forceAutomaticFullScan && !shouldRunAutomaticFullScan(preference)) return { candidates: [...manual, cached], automaticFullScan: false }
    const detected = this.detect(context, preference)
    const merged = new Map([...detected, cached].map((candidate) => [candidate.rule.id, candidate]))
    return { candidates: [...manual, ...merged.values()], automaticFullScan: true }
  }

  private detect(options: WebsiteCandidateContext, preference: WebsiteParsePreference | null): WebsiteParseCandidate[] {
    return detectAutomaticWebsiteLists(options.$, options.baseUrl, options.feed.url, options.fetchedAt,
      (ruleId) => automaticRuleHistoryScore(preference, ruleId), options.includeRejectedAutomatic ?? false)
  }

  private parseRule(rule: WebsiteRule, options: WebsiteCandidateContext, preference: WebsiteParsePreference | null = null): WebsiteParseCandidate {
    try {
      const articles = new ConfigurableWebsiteParser(rule).parse(options.$, options.baseUrl, options.feed.url, options.fetchedAt)
      return { rule, articles, diagnostics: {
        ...scoreWebsiteCandidate(articles, options.fetchedAt), regionScore: rule.automaticRegionScore,
        historyScore: rule.id.startsWith('auto-dom:') ? automaticRuleHistoryScore(preference, rule.id) : 0
      } }
    } catch (error) {
      // 单个规则失效会产生显式拒绝诊断，不能阻断其他手动或自动候选。
      return { rule, articles: [], diagnostics: rejectedWebsiteCandidate(error instanceof Error ? error.message : 'Parsing failed') }
    }
  }
}
