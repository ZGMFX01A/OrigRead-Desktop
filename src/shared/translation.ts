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
  accountId?: number
  sourceHash?: string
  cacheKey?: string
  expiresAt?: number
  showTranslation?: boolean
  cacheWriteFailed?: boolean
}

export interface TranslationOwner { accountId: number; feedId: string; articleId: string }
export interface ListTranslationSource extends TranslationOwner { title: string; description: string }
export interface ListTranslationItem extends ListTranslationSource {
  translatedTitle: string
  translatedDescription: string
  target: TranslationTarget
  language: string
  cacheKey: string | null
  expiresAt: number
  showTranslation: boolean
  cacheWriteFailed: boolean
}
export interface ListTranslationRequest {
  requestId: string
  accountId: number
  articleIds: string[]
  target?: TranslationTarget
}
export interface ListTranslationProgress {
  requestId: string
  completed: number
  total: number
  items: ListTranslationItem[]
}
export interface ListTranslationSnapshot {
  settings: TranslationSettings
  items: ListTranslationItem[]
}
export const LIST_TRANSLATION_LIMIT = 50
export function translationTargetKey(target: TranslationTarget): string {
  return target.type === 'traditional' ? `traditional:${target.provider}` : `ai:${target.providerId}:${target.model}`
}
/** Same limits as Android; never pass body HTML as a list preview. */
export function listTranslationExcerpt(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join('')
}

export interface TranslationProviderTestResult {
  ok: boolean
  value: string | null
  error: string | null
}

export interface DeepLUsage {
  characterCount: number
  characterLimit: number
  remainingCharacters: number
  usagePercent: number
}

export const TRANSLATION_PROVIDER_TYPES: TranslationProviderType[] = [
  'ML_KIT', 'MICROSOFT', 'DEEPL', 'GOOGLE_CLOUD', 'DLX'
]

