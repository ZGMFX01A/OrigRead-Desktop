export type CandidateState =
  | 'AVAILABLE'
  | 'INVALID_CONTENT'
  | 'NETWORK_UNAVAILABLE'
  | 'TIMEOUT'
  | 'NEEDS_INPUT'
  | 'UNSUPPORTED'

export type WebsiteCleanupMode = 'NONE' | 'URL_ID_RANGE'
export const WEBSITE_RULE_SCHEMA_VERSION = 1

export interface WebsiteDateRule {
  selector: string
  pattern: string
}

export interface WebsiteRule {
  id: string
  name: string
  version: number
  enabled: boolean
  hosts: string[]
  articleSelectors: string[]
  titleSelector: string
  linkSelector: string
  linkAttribute: string
  dateRules: WebsiteDateRule[]
  imageSelector: string | null
  imageAttributes: string[]
  contentSelectors: string[]
  includeUrlRegex: string | null
  automaticUrlPattern: string | null
  automaticDateExtraction: boolean
  automaticRegionScore: number
  excludeTitleRegexes: string[]
  maxItems: number
  cleanupMode: WebsiteCleanupMode
  urlIdRegex: string | null
}

export interface WebsiteRuleBundle {
  schemaVersion: number
  rules: WebsiteRule[]
}

export interface WebsiteParsedArticle {
  stableId: string
  title: string
  link: string
  author: string | null
  publishedAt: number
  descriptionHtml: string
  imageUrl: string | null
}

export interface WebsiteParseDiagnostics {
  score: number
  linkQualityScore: number
  regionScore: number
  historyScore: number
  state: CandidateState
  articleCount: number
  validTitleRate: number
  validLinkRate: number
  uniqueLinkRate: number
  parsedDateRate: number
  chronologicalRate: number
  reasons: string[]
}

export interface WebsiteParseCandidate {
  rule: WebsiteRule
  articles: WebsiteParsedArticle[]
  diagnostics: WebsiteParseDiagnostics
}

export interface WebsiteInspectionResult {
  title: string
  sourceUrl: string
  finalUrl: string
  description: string
  iconUrl: string | null
  candidate: WebsiteParseCandidate
  candidates: WebsiteParseCandidate[]
}

export function defaultWebsiteRule(input: Partial<WebsiteRule> & Pick<WebsiteRule, 'id' | 'name' | 'hosts' | 'articleSelectors' | 'titleSelector'>): WebsiteRule {
  return {
    id: input.id,
    name: input.name,
    version: input.version ?? 1,
    enabled: input.enabled ?? true,
    hosts: input.hosts,
    articleSelectors: input.articleSelectors,
    titleSelector: input.titleSelector,
    linkSelector: input.linkSelector ?? input.titleSelector,
    linkAttribute: input.linkAttribute ?? 'href',
    dateRules: input.dateRules ?? [],
    imageSelector: input.imageSelector ?? null,
    imageAttributes: input.imageAttributes ?? ['data-original', 'src'],
    contentSelectors: input.contentSelectors ?? [],
    includeUrlRegex: input.includeUrlRegex ?? null,
    automaticUrlPattern: input.automaticUrlPattern ?? null,
    automaticDateExtraction: input.automaticDateExtraction ?? false,
    automaticRegionScore: input.automaticRegionScore ?? 0,
    excludeTitleRegexes: input.excludeTitleRegexes ?? [],
    maxItems: input.maxItems ?? 50,
    cleanupMode: input.cleanupMode ?? 'NONE',
    urlIdRegex: input.urlIdRegex ?? null
  }
}

export function normalizeWebsiteRule(input: Partial<WebsiteRule>): WebsiteRule {
  if (typeof input.id !== 'string' || typeof input.name !== 'string') {
    throw new Error('规则 id 和名称必须是字符串')
  }
  if (!Array.isArray(input.hosts) || !Array.isArray(input.articleSelectors) || typeof input.titleSelector !== 'string') {
    throw new Error('网站规则缺少 hosts、articleSelectors 或 titleSelector')
  }
  return defaultWebsiteRule({
    ...input,
    id: input.id,
    name: input.name,
    hosts: input.hosts,
    articleSelectors: input.articleSelectors,
    titleSelector: input.titleSelector
  })
}

/** 与 Android WebsiteRuleRepository 当前唯一内置规则保持一致。 */
export const BUILT_IN_WEBSITE_RULES: WebsiteRule[] = [
  defaultWebsiteRule({
    id: 'ithome-home',
    name: 'IT之家首页',
    hosts: ['ithome.com'],
    articleSelectors: ['ul.nl li.n'],
    titleSelector: 'a[href]',
    dateRules: [
      { selector: 'b', pattern: 'HH:mm' },
      { selector: 'i', pattern: 'MM-dd' }
    ],
    includeUrlRegex: '^https?://(?:www\\.)?ithome\\.com/0/\\d+/\\d+\\.htm(?:\\?.*)?$',
    excludeTitleRegexes: [
      '(?i).*Win(?:dows)?\\s*11/10/7.*系统镜像下载.*',
      '.*系统镜像下载.*'
    ],
    cleanupMode: 'URL_ID_RANGE',
    urlIdRegex: '/(\\d+)\\.htm'
  })
]

