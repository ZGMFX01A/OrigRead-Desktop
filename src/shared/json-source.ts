export type JsonSourceKind = 'API' | 'NEXT_DATA' | 'NUXT_DATA'

export interface JsonRuleBundle {
  schemaVersion: number
  rules: JsonRule[]
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
  imagePath: string | null
  idPath: string | null
  dateFormat: string | null
  maxItems: number
}

export interface JsonParsedArticle {
  stableId: string
  title: string
  link: string
  author: string | null
  publishedAt: number
  descriptionHtml: string
  imageUrl: string | null
}

export interface JsonSourceProbeResult {
  rule: JsonRule
  endpointUrl: string
  sourcePageUrl: string
  title: string
  articles: JsonParsedArticle[]
}

export const JSON_RULE_SCHEMA_VERSION = 1

export function normalizeJsonRule(value: JsonRule): JsonRule {
  return {
    ...value,
    version: value.version ?? 1,
    enabled: value.enabled ?? true,
    sourceKind: value.sourceKind ?? 'API',
    datePath: value.datePath ?? null,
    authorPath: value.authorPath ?? null,
    descriptionPath: value.descriptionPath ?? null,
    imagePath: value.imagePath ?? null,
    idPath: value.idPath ?? null,
    dateFormat: value.dateFormat ?? null,
    maxItems: value.maxItems ?? 50
  }
}
