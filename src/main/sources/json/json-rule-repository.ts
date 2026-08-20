import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { JsonRule, JsonRuleBundle } from '../../../shared/json-source'
import { JSON_RULE_SCHEMA_VERSION, normalizeJsonRule } from '../../../shared/json-source'
import { validateJsonPath } from './simple-json-path'

const HOST_REGEX = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

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
    const rules = this.findRules(endpointUrl)
    return (
      rules.find((rule) => this.resolveEndpoint(endpointUrl, rule.endpoint) === endpointUrl) ??
      rules[0] ??
      null
    )
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

  private validateRule(rule: JsonRule): void {
    if (typeof rule.id !== 'string' || typeof rule.name !== 'string') {
      throw new Error('规则 id 和名称必须是字符串')
    }
    if (!rule.id.trim()) throw new Error('规则 id 不能为空')
    if (!rule.name.trim()) throw new Error('规则名称不能为空')
    if (!Array.isArray(rule.hosts)) throw new Error('hosts 必须是域名数组')
    if (rule.hosts.length === 0) throw new Error('规则至少需要一个 hosts')
    for (const host of rule.hosts) {
      if (typeof host !== 'string') throw new Error('hosts 必须是域名数组')
      if (!HOST_REGEX.test(host)) throw new Error(`hosts 只能填写纯域名：${host}`)
    }
    if (!['API', 'NEXT_DATA', 'NUXT_DATA'].includes(rule.sourceKind)) {
      throw new Error(`不支持的 JSON 来源类型：${String(rule.sourceKind)}`)
    }
    if (typeof rule.endpoint !== 'string') throw new Error('endpoint 必须是字符串')
    if (!rule.endpoint.trim()) throw new Error('endpoint 不能为空')
    for (const requiredPath of [rule.itemsPath, rule.titlePath, rule.linkPath]) {
      if (typeof requiredPath !== 'string') throw new Error('必填 JSONPath 必须是字符串')
    }
    if (!Number.isInteger(rule.maxItems) || rule.maxItems < 1 || rule.maxItems > 200) {
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
