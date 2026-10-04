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

export interface JsonArticleBatch {
  rule: JsonRule
  articles: JsonParsedArticle[]
}

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

  async fetch(feed: FeedRecord, fetchedAt = Date.now(), boundRule?: JsonRule | null): Promise<JsonParsedArticle[]> {
    return (await this.fetchResolved(feed, fetchedAt, boundRule)).articles
  }

  /** 旧来源逐条验证真实响应，仅唯一有效候选可以成为持久绑定。 */
  async fetchResolved(feed: FeedRecord, fetchedAt: number, boundRule?: JsonRule | null): Promise<JsonArticleBatch> {
    if (boundRule) return { rule: boundRule, articles: await this.executeRule(feed.url, boundRule, { fetchedAt }) }
    const configured = this.ruleRepository.findRulesForEndpoint(feed.url)
    const candidates = configured.length > 0 ? configured : [createWordPressRuleFromEndpoint(feed.url)].filter((rule): rule is JsonRule => rule !== null)
    const successes: JsonArticleBatch[] = []
    if (candidates.length === 0) throw new Error(`未找到 ${feed.url} 对应的 JSON 来源规则，请重新探测来源`)
    const failures: Error[] = []
    for (const rule of candidates) {
      try {
        successes.push({ rule, articles: await this.executeRule(feed.url, rule, { fetchedAt }) })
      } catch (error) {
        // 此处仅验证无绑定旧数据，保存各候选真实失败以供最终错误诊断。
        failures.push(new Error(`${rule.name}：${error instanceof Error ? error.message : String(error)}`, { cause: error }))
      }
    }
    if (successes.length === 0) throw new AggregateError(failures, `JSON 来源规则均验证失败，请重新探测来源：${feed.url}；${failures.map((error) => error.message).join('；')}`)
    if (successes.length > 1) throw new Error(`JSON 来源匹配多条有效规则，请在来源设置重新探测并选择：${feed.url}`)
    return successes[0]!
  }

  /** 来源修复展示全部成功候选；取消立即终止，不沿用订阅发现的首项选择。 */
  async probeAll(inputUrl: string, signal: AbortSignal): Promise<JsonSourceProbeResult[]> {
    const normalized = normalizeHttpUrl(inputUrl)
    const rules = [...this.ruleRepository.findRules(normalized), ...createWordPressCandidates(normalized)]
    const direct = createWordPressRuleFromEndpoint(normalized)
    if (direct) rules.unshift(direct)
    const unique = new Map(rules.map((rule) => [`${rule.id}\u0000${this.requestEndpoint(normalized, rule)}`, rule]))
    const successes: JsonSourceProbeResult[] = []
    const failures: Error[] = []
    for (const rule of unique.values()) {
      signal.throwIfAborted()
      try {
        successes.push(await this.probeRule(normalized, rule, signal))
      } catch (error) {
        // 取消立即结束；候选失败保留规则名称与原始原因，全部失败时一起报告。
        signal.throwIfAborted()
        failures.push(new Error(`${rule.name}：${error instanceof Error ? error.message : String(error)}`, { cause: error }))
      }
    }
    signal.throwIfAborted()
    if (successes.length === 0) throw new AggregateError(failures, `未找到可用 JSON 规则：${failures.map((error) => error.message).join('；')}`)
    return successes
  }

  /** 内嵌 JSON 沿用页面地址，API 使用规则声明的相对或绝对接口地址。 */
  private requestEndpoint(inputUrl: string, rule: JsonRule): string {
    return rule.sourceKind === 'API' ? this.ruleRepository.resolveEndpoint(inputUrl, rule.endpoint) : inputUrl
  }

  private async tryProbeRule(inputUrl: string, rule: JsonRule, signal?: AbortSignal): Promise<JsonSourceProbeResult | null> {
    try {
      return await this.probeRule(inputUrl, rule, signal)
    } catch (error) {
      // 原订阅发现继续已有候选顺序；取消始终中止，修复探测由调用方保留全部失败原因。
      if (signal?.aborted) throw signal.reason ?? error
      return null
    }
  }

  /** 探测和确认来源刷新共用同一地址计算与文章解析。 */
  private async probeRule(inputUrl: string, rule: JsonRule, signal?: AbortSignal): Promise<JsonSourceProbeResult> {
    signal?.throwIfAborted()
    const sourceUrl = this.requestEndpoint(inputUrl, rule)
    const articles = await this.executeRule(sourceUrl, rule, { fetchedAt: Date.now(), signal })
    return { rule, endpointUrl: sourceUrl, sourcePageUrl: inputUrl, title: rule.name, articles }
  }

  private async executeRule(
    sourceUrl: string,
    rule: JsonRule,
    options: { fetchedAt: number; signal?: AbortSignal }
  ): Promise<JsonParsedArticle[]> {
    const { fetchedAt, signal } = options
    if (rule.sourceKind === 'API') {
      const content = await this.fetcher(sourceUrl, signal)
      return this.parser.parse(content, rule, { baseUrl: sourceUrl, fetchedAt })
    }

    const html = await this.fetcher(sourceUrl, signal)
    const jsonContent = rule.sourceKind === 'NEXT_DATA'
      ? extractNextData(html)
      : extractNuxtData(html)
    if (!jsonContent) throw new Error('网页中未找到对应的内嵌 JSON 数据')
    return this.parser.parse(jsonContent, rule, { baseUrl: sourceUrl, fetchedAt })
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
