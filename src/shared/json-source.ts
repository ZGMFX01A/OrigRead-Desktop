export type JsonSourceKind = 'API' | 'NEXT_DATA' | 'NUXT_DATA'

export interface JsonRuleBundle {
  schemaVersion: number
  rules: JsonRule[]
  /** 完整配置备份额外保留按来源确认的规则；手动规则导出不包含此映射。 */
  subscriptions?: Record<string, JsonSourceBinding>
}

export interface JsonSourceBinding {
  sourcePageUrl: string
  endpointUrl: string
  rule: JsonRule
  /** 与 Android 备份一致，记录规则是否来自用户规则目录。 */
  importedRule: boolean
}

export interface JsonRule {
  id: string
  name: string
  version: number
  enabled: boolean
  hosts: string[]
  sourceKind: JsonSourceKind
  endpoint: string
  itemsPath: string
  titlePath: string
  linkPath: string
  datePath: string | null
  authorPath: string | null
  descriptionPath: string | null
  contentPath?: string | null
  imagePath: string | null
  idPath: string | null
  dateFormat: string | null
  /** WordPress date_gmt 等无时区字符串由规则明确声明 UTC。 */
  dateTimeZone?: 'UTC' | null
  maxItems: number
}

export interface JsonParsedArticle {
  stableId: string
  title: string
  link: string
  author: string | null
  publishedAt: number
  descriptionHtml: string
  contentHtml?: string | null
  imageUrl: string | null
}

export interface JsonSourceProbeResult {
  rule: JsonRule
  endpointUrl: string
  sourcePageUrl: string
  title: string
  articles: JsonParsedArticle[]
}

// 规则包格式版本；新增可选时区字段不改变已有包的读取方式。
export const JSON_RULE_SCHEMA_VERSION = 1

/** 补齐旧规则包的可选字段，显式提供的解析行为保持原样。 */
export function normalizeJsonRule(value: JsonRule): JsonRule {
  return {
    ...value,
    ...normalizeJsonPaths(value),
    version: value.version ?? 1,
    enabled: value.enabled ?? true,
    sourceKind: value.sourceKind ?? 'API',
    dateFormat: value.dateFormat ?? null,
    dateTimeZone: value.dateTimeZone ?? null,
    maxItems: value.maxItems ?? 50
  }
}

/** 没有配置的可选 JSONPath 使用空值，避免误读其他字段。 */
function normalizeJsonPaths(value: JsonRule): Pick<JsonRule,
  'datePath' | 'authorPath' | 'descriptionPath' | 'contentPath' | 'imagePath' | 'idPath'> {
  return {
    datePath: value.datePath ?? null,
    authorPath: value.authorPath ?? null,
    descriptionPath: value.descriptionPath ?? null,
    contentPath: value.contentPath ?? null,
    imagePath: value.imagePath ?? null,
    idPath: value.idPath ?? null
  }
}
