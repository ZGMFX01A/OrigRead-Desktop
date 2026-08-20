import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  BUILT_IN_WEBSITE_RULES,
  normalizeWebsiteRule,
  WEBSITE_RULE_SCHEMA_VERSION,
  type WebsiteRule,
  type WebsiteRuleBundle
} from '../../../shared/website'
import { compileAndroidRegex } from './website-dom'

const HOST_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

export class WebsiteRuleRepository {
  constructor(private readonly ruleFile: string) {}

  listRules(): WebsiteRule[] {
    const merged = new Map<string, WebsiteRule>()
    for (const rule of BUILT_IN_WEBSITE_RULES) merged.set(rule.id, rule)
    // 用户保存的状态覆盖同 id 内置规则；这样内置规则仍默认可用，但禁用状态可以持久化。
    for (const rule of this.loadCustomRules()) merged.set(rule.id, rule)
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  findRules(url: string): WebsiteRule[] {
    return this.findConfiguredRules(url).filter((rule) => rule.enabled)
  }

  /** 返回匹配地址的全部规则，包含已停用规则，供来源设置页展示真实启用状态。 */
  findConfiguredRules(url: string): WebsiteRule[] {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch { return [] }
    return this.listRules().filter((rule) => rule.hosts.some((expected) => {
      const normalized = expected.toLowerCase()
      return host === normalized || host.endsWith(`.${normalized}`)
    }))
  }

  findRule(url: string): WebsiteRule | null {
    return this.findRules(url)[0] ?? null
  }

  findRuleById(ruleId: string): WebsiteRule | null {
    return this.listRules().find((rule) => rule.id === ruleId && rule.enabled) ?? null
  }

  importRules(content: string): number {
    const incoming = this.decodeBundle(content)
    const userRules = incoming.rules.filter((rule) => !BUILT_IN_WEBSITE_RULES.some((builtIn) => builtIn.id === rule.id))
    userRules.forEach((rule) => this.validateRule(rule))
    const merged = new Map(this.loadCustomRules().map((rule) => [rule.id, rule]))
    userRules.forEach((rule) => merged.set(rule.id, rule))
    this.writeCustomRules([...merged.values()])
    return userRules.length
  }

  validateBackup(content: string): void {
    this.decodeBundle(content).rules
      .filter((rule) => !BUILT_IN_WEBSITE_RULES.some((builtIn) => builtIn.id === rule.id))
      .forEach((rule) => this.validateRule(rule))
  }

  restoreBackup(content: string): number {
    const incoming = this.decodeBundle(content)
    const userRules = incoming.rules.filter((rule) => !BUILT_IN_WEBSITE_RULES.some((builtIn) => builtIn.id === rule.id))
    userRules.forEach((rule) => this.validateRule(rule))
    this.writeCustomRules(userRules)
    return userRules.length
  }

  validateCandidate(rule: WebsiteRule): void {
    this.validateRule(rule)
  }

  saveRule(rule: WebsiteRule): void {
    if (BUILT_IN_WEBSITE_RULES.some((builtIn) => builtIn.id === rule.id)) {
      throw new Error(`内置规则不能作为用户规则保存：${rule.id}`)
    }
    this.saveCustomRule(rule)
  }

  saveCustomRule(rule: WebsiteRule): void {
    this.validateRule(rule)
    const merged = new Map(this.loadCustomRules().map((item) => [item.id, item]))
    merged.set(rule.id, normalizeWebsiteRule(rule))
    this.writeCustomRules([...merged.values()])
  }

  setEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.listRules().find((item) => item.id === ruleId)
    if (!rule) throw new Error(`未找到规则：${ruleId}`)
    this.saveCustomRule({ ...rule, enabled })
  }

  deleteRule(ruleId: string): void {
    const custom = this.loadCustomRules().filter((rule) => rule.id !== ruleId)
    const builtIn = BUILT_IN_WEBSITE_RULES.find((rule) => rule.id === ruleId)
    if (builtIn) {
      custom.push({ ...builtIn, enabled: false })
      this.writeCustomRules(custom)
      return
    }
    if (custom.length === this.loadCustomRules().length) throw new Error(`未找到规则：${ruleId}`)
    this.writeCustomRules(custom)
  }

  exportRules(): string {
    const rules = this.loadCustomRules().filter((rule) => !BUILT_IN_WEBSITE_RULES.some((builtIn) => builtIn.id === rule.id))
    return JSON.stringify({ schemaVersion: WEBSITE_RULE_SCHEMA_VERSION, rules }, null, 2)
  }

  exportTemplate(): string {
    const template = normalizeWebsiteRule({
      id: 'example-news-site',
      name: 'Example News Site',
      hosts: ['news.example.com'],
      articleSelectors: ['.news-list .news-item', 'article.news-item'],
      titleSelector: 'a.title',
      linkSelector: 'a.title',
      dateRules: [{ selector: '.time', pattern: 'yyyy-MM-dd HH:mm' }],
      imageSelector: 'img',
      contentSelectors: ['article .article-content', 'main article'],
      includeUrlRegex: '^https?://news\\.example\\.com/.*$',
      excludeTitleRegexes: ['.*广告.*']
    })
    return JSON.stringify({ schemaVersion: WEBSITE_RULE_SCHEMA_VERSION, rules: [template] }, null, 2)
  }

  private validateRule(rule: WebsiteRule): void {
    if (!rule.id.trim()) throw new Error('规则 id 不能为空')
    if (!rule.name.trim()) throw new Error('规则名称不能为空')
    if (rule.hosts.length === 0) throw new Error('规则至少需要一个 hosts')
    for (const host of rule.hosts) {
      if (!HOST_REGEX.test(host)) throw new Error(`hosts 只能填写纯域名，不能包含协议、路径或 Markdown 链接：${host}`)
    }
    if (!rule.articleSelectors.some((selector) => selector.trim())) throw new Error('articleSelectors 不能为空')
    if (!rule.titleSelector.trim()) throw new Error('titleSelector 不能为空')
    if (!rule.linkSelector.trim()) throw new Error('linkSelector 不能为空')
    if (rule.contentSelectors.some((selector) => !selector.trim())) throw new Error('contentSelectors 不能包含空选择器')
    if (!Number.isInteger(rule.maxItems) || rule.maxItems < 1 || rule.maxItems > 200) throw new Error('maxItems 必须在 1 到 200 之间')
    if (!['NONE', 'URL_ID_RANGE'].includes(rule.cleanupMode)) throw new Error(`不支持的 cleanupMode：${String(rule.cleanupMode)}`)
    if (rule.includeUrlRegex) compileAndroidRegex(rule.includeUrlRegex)
    rule.excludeTitleRegexes.forEach(compileAndroidRegex)
    if (rule.urlIdRegex) compileAndroidRegex(rule.urlIdRegex)
  }

  private decodeBundle(content: string): WebsiteRuleBundle {
    const parsed = JSON.parse(content) as Partial<WebsiteRuleBundle>
    const schemaVersion = parsed.schemaVersion ?? WEBSITE_RULE_SCHEMA_VERSION
    if (schemaVersion !== WEBSITE_RULE_SCHEMA_VERSION) throw new Error(`不支持的规则版本：${schemaVersion}`)
    if (!Array.isArray(parsed.rules)) throw new Error('网站规则文件缺少 rules')
    return { schemaVersion: WEBSITE_RULE_SCHEMA_VERSION, rules: parsed.rules.map((rule) => normalizeWebsiteRule(rule)) }
  }

  private loadCustomRules(): WebsiteRule[] {
    try {
      if (!existsSync(this.ruleFile)) return []
      return this.decodeBundle(readFileSync(this.ruleFile, 'utf8')).rules
    } catch {
      return []
    }
  }

  private writeCustomRules(rules: WebsiteRule[]): void {
    writeFileSync(this.ruleFile, JSON.stringify({ schemaVersion: WEBSITE_RULE_SCHEMA_VERSION, rules }, null, 2), 'utf8')
  }
}

