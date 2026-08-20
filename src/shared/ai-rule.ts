export type AiGeneratedRuleKind = 'WEBSITE' | 'JSON'

export type AiRuleGenerationStage =
  | 'PREPARING'
  | 'FETCHING_SOURCE'
  | 'ANALYZING_SOURCE'
  | 'GENERATING_CANDIDATE'
  | 'VALIDATING_CANDIDATE'
  | 'REPAIRING_CANDIDATE'
  | 'FETCHING_CONTENT'
  | 'GENERATING_CONTENT'
  | 'VALIDATING_CONTENT'
  | 'COMPLETED'
  | 'FAILED'

export interface AiRuleGenerationOptions {
  providerId?: string
  model?: string
  requestId?: string
}

export interface AiRuleGenerationProgress {
  requestId: string
  stage: AiRuleGenerationStage
  attempt: number
  detail: string | null
  at: number
}

export interface AiGeneratedRulePreview {
  previewId: string
  kind: AiGeneratedRuleKind
  name: string
  ruleJson: string
  articleCount: number
  score: number
  sampleTitles: string[]
  providerName: string
  model: string
  targetUrl: string
  finalUrl: string
  attempts: number
  sourceKind: string | null
  contentStatus: 'VERIFIED' | 'SKIPPED' | 'FAILED'
  contentMessage: string | null
  contentSampleCount: number
}
