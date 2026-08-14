export type ArticleFilterRuleType = 'KEYWORD' | 'REGEX'

export interface ArticleFilterRule {
  id: string
  keyword: string
  feedId: string | null
  feedName: string | null
  type: ArticleFilterRuleType
  enabled: boolean
}

export interface ArticleFilterStats {
  totalFiltered: number
  lastFilteredAt: number | null
  lastMatchedRule: string | null
}

export interface ArticleFilterRuleBundle {
  schemaVersion: 1
  rules: ArticleFilterRule[]
  stats: ArticleFilterStats
}

export interface ArticleFilterSnapshot {
  rules: ArticleFilterRule[]
  stats: ArticleFilterStats
}

