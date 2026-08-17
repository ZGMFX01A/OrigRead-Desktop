export type AiSummaryLength = 'BRIEF' | 'STANDARD' | 'DETAILED'
export type AiSummaryStatus = 'GENERATED' | 'NOT_NEEDED'
export type AiArticleForm = 'flash' | 'release' | 'news' | 'review' | 'guide' | 'research' | 'report' | 'analysis' | 'opinion' | 'interview' | 'other'
export type AiSummarySkipReason = 'local_source_already_concise' | 'source_already_concise' | 'low_compression_value' | 'insufficient_content'

export interface AiProviderProfile {
  id: string
  name: string
  enabled: boolean
  endpoint: string
  defaultModel: string
  models: string[]
  hasApiKey: boolean
}

export interface AiSettingsPatch {
  enabled?: boolean
  defaultProviderId?: string
  outputLanguage?: string
  summaryLength?: AiSummaryLength
}

export interface AiSettings {
  enabled: boolean
  providers: AiProviderProfile[]
  defaultProviderId: string
  outputLanguage: string
  summaryLength: AiSummaryLength
}

export interface AiProviderPatch {
  id: string
  name?: string
  enabled?: boolean
  endpoint?: string
  defaultModel?: string
  models?: string[]
  apiKey?: string
}

export interface AiSummaryDocument {
  articleId: string
  providerId: string
  providerName: string
  model: string
  outputLanguage: string
  length: AiSummaryLength
  summary: string
  reasoning: string | null
  status: AiSummaryStatus
  articleForm: AiArticleForm | null
  domain: string | null
  skipReason: AiSummarySkipReason | null
}

export interface AiSummaryRequestOptions {
  providerId?: string
  model?: string
  length?: AiSummaryLength
}

export type AiSummaryProgressStage = 'PREPARING' | 'REQUESTING' | 'FINALIZING'

export interface AiSummaryProgress {
  articleId: string
  stage: AiSummaryProgressStage
}

export interface AiProviderTestResult {
  ok: boolean
  error: string | null
}

export const DEFAULT_AI_PROVIDER_ID = 'default'

