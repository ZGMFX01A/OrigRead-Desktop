import type { ConfigurationBackup, BackupFeed } from '../../shared/configuration-backup'
import type { JsonRuleBundle, JsonSourceBinding } from '../../shared/json-source'
import { normalizeJsonRule } from '../../shared/json-source'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import type { LibraryRepository } from '../database/library-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'

/** 完整备份包含当前规则目录和每个来源已经确认的快照，两者不能相互替代。 */
export function exportJsonSubscriptionBackup(library: LibraryRepository, rules: JsonRuleRepository): JsonRuleBundle {
  const bundle = JSON.parse(rules.exportRules()) as JsonRuleBundle
  const importedIds = new Set(bundle.rules.map((rule) => rule.id))
  const subscriptions: Record<string, JsonSourceBinding> = {}
  for (const feed of library.listFeeds().filter((feed) => feed.sourceType === 'json')) {
    const rule = library.getJsonFeedRule(feed.id)
    if (!rule) continue
    subscriptions[feed.id] = {
      sourcePageUrl: feed.sourcePageUrl ?? feed.url, endpointUrl: feed.url,
      rule, importedRule: importedIds.has(rule.id)
    }
  }
  return { ...bundle, subscriptions }
}

/** 所有绑定先校验来源归属、请求地址和规则，任何无效项都在恢复写入前报错。 */
export function validateJsonSubscriptionBackup(backup: ConfigurationBackup, rules: JsonRuleRepository): void {
  const feeds = new Map(backup.subscriptions.feeds.map((feed) => [feed.id, feed]))
  const byEndpoint = new Map<string, string>()
  for (const [feedId, binding] of subscriptionEntries(backup)) {
    const normalized = validateBinding(binding, feeds.get(feedId), rules)
    // 恢复按订阅地址身份合并 Feed，冲突检查必须使用同一比较规则。
    const endpoint = sourceUrlComparisonKey(normalized.endpointUrl)
    const serialized = JSON.stringify({ ...normalized, endpointUrl: endpoint,
      sourcePageUrl: sourceUrlComparisonKey(normalized.sourcePageUrl) })
    const existing = byEndpoint.get(endpoint)
    if (existing && existing !== serialized) throw new Error('备份中的同一 JSON 来源包含冲突规则绑定')
    byEndpoint.set(endpoint, serialized)
  }
}

/** 按恢复后的 Feed ID 保存规则及原页面，加入外层配置恢复事务。 */
export function restoreJsonSubscriptionBackup(backup: ConfigurationBackup, library: LibraryRepository, feedIdMap: Map<string, string>): void {
  for (const [oldId, binding] of subscriptionEntries(backup)) {
    const newId = feedIdMap.get(oldId)
    const feed = newId ? library.getFeedById(newId) : null
    if (!feed || feed.sourceType !== 'json') throw new Error('JSON 来源绑定缺少恢复后的目标来源')
    library.upsertFeedWithArticles({ ...feed, sourcePageUrl: binding.sourcePageUrl }, [], {
      jsonRule: normalizeJsonRule(binding.rule)
    })
  }
}

/** 旧备份没有来源映射；已提供的映射必须是对象，不能静默丢弃损坏数据。 */
function subscriptionEntries(backup: ConfigurationBackup): Array<[string, JsonSourceBinding]> {
  const value = (backup.jsonRules as Partial<JsonRuleBundle> | null)?.subscriptions
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份中的 JSON 来源绑定无效')
  return Object.entries(value)
}

/** 绑定不能跨来源或改写 endpoint；原页面仅用于相对接口和内嵌 JSON 的定位。 */
function validateBinding(binding: JsonSourceBinding, feed: BackupFeed | undefined, rules: JsonRuleRepository): JsonSourceBinding {
  if (!feed || feed.sourceType.toUpperCase() !== 'JSON') throw new Error('JSON 来源绑定不属于备份中的 JSON 来源')
  validateBindingShape(binding)
  httpUrl(binding.sourcePageUrl)
  if (httpUrl(binding.endpointUrl) !== httpUrl(feed.url)) throw new Error('JSON 来源绑定的请求地址与订阅不一致')
  const rule = normalizeJsonRule(binding.rule)
  rules.validateCandidate(rule)
  return { ...binding, rule }
}

/** 文件中声明的绑定必须具备规则和目录身份，不能把缺失字段当成确认结果。 */
function validateBindingShape(binding: JsonSourceBinding): void {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('备份中的 JSON 来源绑定无效')
  if (!binding.rule || typeof binding.rule !== 'object' || Array.isArray(binding.rule)) throw new Error('JSON 来源绑定缺少规则定义')
  if (typeof binding.importedRule !== 'boolean') throw new Error('JSON 来源绑定缺少规则目录身份')
}

/** 备份中的原页面和接口都必须是明确的 HTTP 地址。 */
function httpUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('JSON 来源绑定缺少 HTTP 地址')
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('JSON 来源绑定只支持 HTTP 地址')
  return url.toString()
}
