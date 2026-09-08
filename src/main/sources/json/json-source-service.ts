import type { FeedRecord } from '../../../shared/library'
import type { JsonParsedArticle, JsonRule, JsonSourceProbeResult } from '../../../shared/json-source'
import { extractNextData, extractNuxtData } from './embedded-json-extractor'
import { JsonArticleParser } from './json-article-parser'
import { JsonRuleRepository } from './json-rule-repository'
import {
  createWordPressCandidates,
  createWordPressRuleFromEndpoint
} from './wordpress-json-rule-factory'

export type JsonTextFetcher = (url: string, signal?: AbortSignal) => Promise<string>

export class JsonSourceService {
  constructor(
    private readonly ruleRepository: JsonRuleRepository,
    private readonly parser: JsonArticleParser = new JsonArticleParser(),
    private readonly fetcher: JsonTextFetcher = fetchJsonText
  ) {}

  async probe(inputUrl: string, signal?: AbortSignal): Promise<JsonSourceProbeResult | null> {
    signal?.throwIfAborted()
    const normalized = normalizeHttpUrl(inputUrl)

    const directRule = createWordPressRuleFromEndpoint(normalized)
    if (directRule) {
      const result = await this.tryProbeRule(normalized, directRule, signal)
      if (result) return result
    }

    for (const rule of this.ruleRepository.findRules(normalized)) {
      const result = await this.tryProbeRule(normalized, rule, signal)
      if (result) return result
    }

    for (const rule of createWordPressCandidates(normalized)) {
      const result = await this.tryProbeRule(normalized, rule, signal)
      if (result) return result
    }

    return null
  }

  async fetch(feed: FeedRecord, fetchedAt = Date.now()): Promise<JsonParsedArticle[]> {
    const rule =
      this.ruleRepository.findRuleForEndpoint(feed.url) ??
      createWordPressRuleFromEndpoint(feed.url)
    if (!rule) throw new Error(`未找到 ${feed.url} 对应的 JSON 来源规则`)
    return this.executeRule(feed.url, rule, fetchedAt)
  }

  private async tryProbeRule(inputUrl: string, rule: JsonRule, signal?: AbortSignal): Promise<JsonSourceProbeResult | null> {
    try {
      signal?.throwIfAborted()
      const sourceUrl = rule.sourceKind === 'API'
        ? this.ruleRepository.resolveEndpoint(inputUrl, rule.endpoint)
        : inputUrl
      const articles = await this.executeRule(sourceUrl, rule, Date.now(), signal)
      return {
        rule,
        endpointUrl: sourceUrl,
        sourcePageUrl: inputUrl,
        title: rule.name,
        articles
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      return null
    }
  }

  private async executeRule(
    sourceUrl: string,
    rule: JsonRule,
    fetchedAt: number,
    signal?: AbortSignal
  ): Promise<JsonParsedArticle[]> {
    if (rule.sourceKind === 'API') {
      const content = await this.fetcher(sourceUrl, signal)
      return this.parser.parse(content, rule, sourceUrl, fetchedAt)
    }

    const html = await this.fetcher(sourceUrl, signal)
    const jsonContent = rule.sourceKind === 'NEXT_DATA'
      ? extractNextData(html)
      : extractNuxtData(html)
    if (!jsonContent) throw new Error('网页中未找到对应的内嵌 JSON 数据')
    return this.parser.parse(jsonContent, rule, sourceUrl, fetchedAt)
  }
}

export async function fetchJsonText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      : AbortSignal.timeout(8_000),
    headers: {
      Accept: 'application/json, text/html;q=0.9, */*;q=0.8'
    }
  })
  if (!response.ok) throw new Error(`JSON API 请求失败：HTTP ${response.status}`)
  return response.text()
}

function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Only http and https source URLs are supported')
  }
  return url.toString()
}
