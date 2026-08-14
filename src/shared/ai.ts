export type AiSummaryLength = 'BRIEF' | 'STANDARD' | 'DETAILED'

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
}

export interface AiProviderTestResult {
  ok: boolean
  error: string | null
}

export const DEFAULT_AI_PROVIDER_ID = 'default'

