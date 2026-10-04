import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { JsonRule, JsonRuleBundle } from '../../../shared/json-source'
import { JSON_RULE_SCHEMA_VERSION, normalizeJsonRule } from '../../../shared/json-source'
import { validateJsonPath } from './simple-json-path'
import { sourceUrlComparisonKey } from '../../../shared/source-url-normalizer'

// 规则仅填写域名；协议与路径通过 endpoint 独立配置。
const HOST_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
// 沿用规则包已有的单次文章上限，避免导入后改变抓取规模。
const MAX_JSON_RULE_ITEMS = 200

export class JsonRuleRepository {
  constructor(private readonly ruleFile: string) {}

  listRules(): JsonRule[] {
    return this.loadRules().sort((a, b) => a.name.localeCompare(b.name))
  }

  findRules(url: string): JsonRule[] {
    return this.findConfiguredRules(url).filter((rule) => rule.enabled)
  }

  findConfiguredRules(url: string): JsonRule[] {
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      return []
    }
    return this.loadRules().filter((rule) =>
      rule.hosts.some((expected) => {
        const normalized = expected.toLowerCase()
        return host === normalized || host.endsWith(`.${normalized}`)
      })
    )
  }

  findRuleForEndpoint(endpointUrl: string): JsonRule | null {
    // 旧订阅只能按精确 endpoint 确认一次规则，不能任意选择同域目录中的第一条。
    const matches = this.findRulesForEndpoint(endpointUrl)
    if (matches.length > 1) throw new Error('JSON 来源匹配多条规则，请重新检测并确认订阅规则')
    return matches[0] ?? null
  }

  /** API 按完整接口地址匹配；Next/Nuxt 的 endpoint 是占位符，始终读取原页面。 */
  findRulesForEndpoint(endpointUrl: string): JsonRule[] {
    return this.findRules(endpointUrl).filter((rule) => rule.sourceKind !== 'API'
      || sourceUrlComparisonKey(this.resolveEndpoint(endpointUrl, rule.endpoint)) === sourceUrlComparisonKey(endpointUrl))
  }

  resolveEndpoint(inputUrl: string, endpoint: string): string {
    return new URL(endpoint, inputUrl).toString()
  }

  importRules(content: string): number {
    const incoming = this.decodeBundle(content)
    incoming.rules.forEach((rule) => this.validateRule(rule))
    const merged = new Map(this.loadRules().map((rule) => [rule.id, rule]))
    incoming.rules.forEach((rule) => merged.set(rule.id, normalizeJsonRule(rule)))
    this.writeRules([...merged.values()])
    return incoming.rules.length
  }

  validateBackup(content: string): void {
    const incoming = this.decodeBundle(content)
    incoming.rules.forEach((rule) => this.validateRule(rule))
  }

  restoreBackup(content: string): number {
    const incoming = this.decodeBundle(content)
    incoming.rules.forEach((rule) => this.validateRule(rule))
    this.writeRules(incoming.rules.map(normalizeJsonRule))
    return incoming.rules.length
  }

  validateCandidate(rule: JsonRule): void {
    this.validateRule(rule)
  }

  saveRule(rule: JsonRule): void {
    this.validateRule(rule)
    const merged = new Map(this.loadRules().map((item) => [item.id, item]))
    merged.set(rule.id, normalizeJsonRule(rule))
    this.writeRules([...merged.values()])
  }

  exportRules(): string {
    return JSON.stringify({ schemaVersion: JSON_RULE_SCHEMA_VERSION, rules: this.listRules() }, null, 2)
  }

  setEnabled(ruleId: string, enabled: boolean): void {
    this.writeRules(this.loadRules().map((rule) => rule.id === ruleId ? { ...rule, enabled } : rule))
  }

  deleteRule(ruleId: string): void {
    this.writeRules(this.loadRules().filter((rule) => rule.id !== ruleId))
  }

  exportTemplate(): string {
    return JSON.stringify({
      schemaVersion: JSON_RULE_SCHEMA_VERSION,
      rules: [{
        id: 'example-json-api',
        name: 'Example JSON API',
        version: 1,
        enabled: true,
        hosts: ['example.com'],
        sourceKind: 'API',
        endpoint: '/api/posts',
        itemsPath: '$.data.items[*]',
        titlePath: '$.title',
        linkPath: '$.url',
        datePath: '$.publishedAt',
        authorPath: '$.author.name',
        descriptionPath: '$.summary',
        contentPath: '$.content',
        imagePath: '$.cover',
        idPath: '$.id',
        dateFormat: null,
        maxItems: 50
      }]
    }, null, 2)
  }

  /** 导入、编辑和恢复使用相同校验顺序，错误直接向调用方报告。 */
  private validateRule(rule: JsonRule): void {
    this.validateDateTimezone(rule)
    this.validateIdentity(rule)
    this.validateHosts(rule.hosts)
    this.validateEndpoint(rule)
    this.validatePaths(rule)
  }

  /** 无时区日期由规则声明 UTC 或沿用旧规则的本地时间语义。 */
  private validateDateTimezone(rule: JsonRule): void {
    if (rule.dateTimeZone !== undefined && rule.dateTimeZone !== null && rule.dateTimeZone !== 'UTC') {
      throw new Error('dateTimeZone 仅支持 UTC 或空值（本地时间）')
    }
  }

  /** 稳定规则身份和显示名称均不得为空。 */
  private validateIdentity(rule: JsonRule): void {
    if (typeof rule.id !== 'string' || typeof rule.name !== 'string') {
      throw new Error('规则 id 和名称必须是字符串')
    }
    if (!rule.id.trim()) throw new Error('规则 id 不能为空')
    if (!rule.name.trim()) throw new Error('规则名称不能为空')
  }

  /** 域名限定规则适用范围，禁止将完整地址混入 hosts。 */
  private validateHosts(hosts: string[]): void {
    if (!Array.isArray(hosts)) throw new Error('hosts 必须是域名数组')
    if (hosts.length === 0) throw new Error('规则至少需要一个 hosts')
    for (const host of hosts) {
      if (typeof host !== 'string') throw new Error('hosts 必须是域名数组')
      if (!HOST_REGEX.test(host)) throw new Error(`hosts 只能填写纯域名：${host}`)
    }
  }

  /** 明确声明 JSON 获取方式和接口地址，避免套用无效规则。 */
  private validateEndpoint(rule: JsonRule): void {
    if (!['API', 'NEXT_DATA', 'NUXT_DATA'].includes(rule.sourceKind)) {
      throw new Error(`不支持的 JSON 来源类型：${String(rule.sourceKind)}`)
    }
    if (typeof rule.endpoint !== 'string') throw new Error('endpoint 必须是字符串')
    if (!rule.endpoint.trim()) throw new Error('endpoint 不能为空')
  }

  /** 必填和可选 JSONPath 都必须符合解析器语法，条数限制保留原有规则。 */
  private validatePaths(rule: JsonRule): void {
    for (const requiredPath of [rule.itemsPath, rule.titlePath, rule.linkPath]) {
      if (typeof requiredPath !== 'string') throw new Error('必填 JSONPath 必须是字符串')
    }
    if (!Number.isInteger(rule.maxItems) || rule.maxItems < 1 || rule.maxItems > MAX_JSON_RULE_ITEMS) {
      throw new Error('maxItems 必须在 1 到 200 之间')
    }
    ;[rule.itemsPath, rule.titlePath, rule.linkPath].forEach(validateJsonPath)
    ;[
      rule.datePath,
      rule.authorPath,
      rule.descriptionPath,
      rule.contentPath,
      rule.imagePath,
      rule.idPath
    ].filter((path): path is string => Boolean(path)).forEach(validateJsonPath)
  }

  private decodeBundle(content: string): JsonRuleBundle {
    const parsed = JSON.parse(content) as Partial<JsonRuleBundle>
    const schemaVersion = parsed.schemaVersion ?? JSON_RULE_SCHEMA_VERSION
    if (schemaVersion !== JSON_RULE_SCHEMA_VERSION) {
      throw new Error(`不支持的 JSON 规则版本：${schemaVersion}`)
    }
    if (!Array.isArray(parsed.rules)) throw new Error('JSON 规则文件缺少 rules')
    return {
      schemaVersion: JSON_RULE_SCHEMA_VERSION,
      rules: parsed.rules.map((rule) => normalizeJsonRule(rule as JsonRule))
    }
  }

  private loadRules(): JsonRule[] {
    try {
      if (!existsSync(this.ruleFile)) return []
      const bundle = this.decodeBundle(readFileSync(this.ruleFile, 'utf8'))
      return bundle.rules
    } catch {
      return []
    }
  }

  private writeRules(rules: JsonRule[]): void {
    writeFileSync(
      this.ruleFile,
      JSON.stringify({ schemaVersion: JSON_RULE_SCHEMA_VERSION, rules }, null, 2),
      'utf8'
    )
  }
}
