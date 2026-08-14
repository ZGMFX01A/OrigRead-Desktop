export type TranslationProviderType = 'ML_KIT' | 'MICROSOFT' | 'DEEPL' | 'GOOGLE_CLOUD' | 'DLX'
export type TranslationDisplayMode = 'TRANSLATED' | 'BILINGUAL'

export interface TranslationProviderSettings {
  type: TranslationProviderType
  enabled: boolean
  endpoint: string
  region: string
  hasApiKey: boolean
  desktopSupported: boolean
}

export interface TranslationSettingsPatch {
  defaultTarget?: TranslationTarget
  targetLanguage?: string
  displayMode?: TranslationDisplayMode
}

export type TranslationTarget =
  | { type: 'traditional'; provider: TranslationProviderType }
  | { type: 'ai'; providerId: string; providerName: string; model: string }

export interface TranslationSettings {
  defaultProvider: TranslationProviderType
  defaultTarget: TranslationTarget
  targetLanguage: string
  displayMode: TranslationDisplayMode
  providers: TranslationProviderSettings[]
}

export interface TranslationProviderPatch {
  type: TranslationProviderType
  enabled?: boolean
  endpoint?: string
  region?: string
  apiKey?: string
}

export interface TranslationDocument {
  articleId: string
  target: TranslationTarget
  targetLanguage: string
  sourceLanguage: string | null
  displayMode: TranslationDisplayMode
  translatedTitle: string
  translatedContent: string
}

export interface TranslationProviderTestResult {
  ok: boolean
  value: string | null
  error: string | null
}

export const TRANSLATION_PROVIDER_TYPES: TranslationProviderType[] = [
  'ML_KIT', 'MICROSOFT', 'DEEPL', 'GOOGLE_CLOUD', 'DLX'
]

