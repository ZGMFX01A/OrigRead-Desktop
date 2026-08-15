import type { DatabaseSync } from 'node:sqlite'
import type { TranslationProviderPatch, TranslationProviderSettings, TranslationProviderType, TranslationSettings, TranslationTarget } from '../../shared/translation'
import { TRANSLATION_PROVIDER_TYPES } from '../../shared/translation'
import type { SecretStore } from '../security/secret-store'

const SETTINGS_KEY = 'translation.settings'
type StoredProvider = Omit<TranslationProviderSettings, 'hasApiKey' | 'desktopSupported'>
interface StoredSettings extends Omit<TranslationSettings, 'providers'> { providers: StoredProvider[] }

export class TranslationSettingsRepository {
  constructor(private readonly database: DatabaseSync, private readonly secrets: SecretStore) {}

  current(): TranslationSettings {
    const stored = normalizeSettings(this.read() ?? defaults())
    return { ...stored, providers: stored.providers.map((provider) => ({
      ...provider,
      hasApiKey: this.secrets.contains(secretKey(provider.type)),
      desktopSupported: provider.type !== 'ML_KIT'
    })) }
  }
  setDefaultTarget(target: TranslationTarget): TranslationSettings {
    const current = this.toStored(this.current())
    const defaultProvider = target.type === 'traditional' ? target.provider : current.defaultProvider
    return this.save({ ...current, defaultTarget: target, defaultProvider })
  }
  setTargetLanguage(value: string): TranslationSettings { return this.save({ ...this.toStored(this.current()), targetLanguage: value }) }
  setDisplayMode(value: TranslationSettings['displayMode']): TranslationSettings {
    if (!['TRANSLATED','BILINGUAL'].includes(value)) throw new Error('无效的译文显示方式')
    return this.save({ ...this.toStored(this.current()), displayMode: value })
  }
  updateProvider(patch: TranslationProviderPatch): TranslationSettings {
    if (!TRANSLATION_PROVIDER_TYPES.includes(patch.type)) throw new Error('未知翻译 Provider')
    const current = this.toStored(this.current())
    if (patch.apiKey !== undefined) this.secrets.put(secretKey(patch.type), patch.apiKey)
    return this.save({ ...current, providers: current.providers.map((item) => item.type === patch.type ? {
      ...item,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint.trim() } : {}),
      ...(patch.region !== undefined ? { region: patch.region.trim() } : {})
    } : item) })
  }
  getApiKey(type: TranslationProviderType): string { return this.secrets.get(secretKey(type)) }
  replaceApiKeys(values: Partial<Record<TranslationProviderType, string>>): void {
    for (const type of TRANSLATION_PROVIDER_TYPES) this.secrets.delete(secretKey(type))
    for (const [type, value] of Object.entries(values)) if (value?.trim()) this.secrets.put(secretKey(type as TranslationProviderType), value)
  }
  restore(settings: StoredSettings, apiKeys?: Partial<Record<TranslationProviderType, string>>): TranslationSettings {
    this.save(settings)
    if (apiKeys) this.replaceApiKeys(apiKeys)
    return this.current()
  }
  private toStored(settings: TranslationSettings): StoredSettings {
    return { ...settings, providers: settings.providers.map(({ hasApiKey: _a, desktopSupported: _b, ...provider }) => provider) }
  }
  private save(value: StoredSettings): TranslationSettings {
    const normalized = normalizeSettings(value)
    this.database.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(normalized), Date.now())
    return this.current()
  }
  private read(): StoredSettings | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    try { return row ? JSON.parse(row.value) as StoredSettings : null } catch { return null }
  }
}

function secretKey(type: TranslationProviderType): string { return `translation:${type}:api-key` }
function defaultProvider(type: TranslationProviderType): StoredProvider {
  switch (type) {
    case 'ML_KIT': return { type, enabled: true, endpoint: '', region: '' }
    case 'MICROSOFT': return { type, enabled: false, endpoint: 'https://api.cognitive.microsofttranslator.com', region: '' }
    case 'DEEPL': return { type, enabled: false, endpoint: 'https://api-free.deepl.com/v2/translate', region: '' }
    case 'GOOGLE_CLOUD': return { type, enabled: false, endpoint: 'https://translation.googleapis.com/language/translate/v2', region: '' }
    case 'DLX': return { type, enabled: false, endpoint: '', region: '' }
  }
}
function defaults(): StoredSettings {
  return { defaultProvider: 'ML_KIT', defaultTarget: { type: 'traditional', provider: 'ML_KIT' }, targetLanguage: 'zh-CN', displayMode: 'TRANSLATED', providers: TRANSLATION_PROVIDER_TYPES.map(defaultProvider) }
}
function normalizeSettings(value: Partial<StoredSettings>): StoredSettings {
  const incoming = new Map((Array.isArray(value.providers) ? value.providers : []).map((item) => [item.type, item]))
  const providers = TRANSLATION_PROVIDER_TYPES.map((type) => ({ ...defaultProvider(type), ...incoming.get(type), type }))
  const defaultProviderType = TRANSLATION_PROVIDER_TYPES.includes(value.defaultProvider as TranslationProviderType) ? value.defaultProvider as TranslationProviderType : 'ML_KIT'
  const defaultTarget = normalizeTarget(value.defaultTarget, defaultProviderType)
  return { defaultProvider: defaultProviderType, defaultTarget, targetLanguage: value.targetLanguage === undefined ? 'zh-CN' : String(value.targetLanguage), displayMode: value.displayMode === 'BILINGUAL' ? 'BILINGUAL' : 'TRANSLATED', providers }
}
function normalizeTarget(value: unknown, fallback: TranslationProviderType): TranslationTarget {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const target = value as Partial<TranslationTarget> & Record<string, unknown>
    if (target.type === 'traditional' && TRANSLATION_PROVIDER_TYPES.includes(target.provider as TranslationProviderType)) return { type: 'traditional', provider: target.provider as TranslationProviderType }
    if (target.type === 'ai' && typeof target.providerId === 'string' && typeof target.model === 'string') return { type: 'ai', providerId: target.providerId, providerName: String(target.providerName ?? 'AI'), model: target.model }
  }
  return { type: 'traditional', provider: fallback }
}

