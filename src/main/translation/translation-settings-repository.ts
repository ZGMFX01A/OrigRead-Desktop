import type { DatabaseSync } from 'node:sqlite'
import type { TranslationProviderPatch, TranslationProviderSettings, TranslationProviderType, TranslationSettings, TranslationTarget } from '../../shared/translation'
import { TRANSLATION_PROVIDER_TYPES } from '../../shared/translation'
import type { SecretStore } from '../security/secret-store'

const SETTINGS_KEY = 'translation.settings'
type StoredProvider = Omit<TranslationProviderSettings, 'hasApiKey' | 'desktopSupported'>
interface StoredSettings extends Omit<TranslationSettings, 'providers'> { providers: StoredProvider[] }

export class TranslationSettingsRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly secrets: SecretStore,
    private readonly defaultTargetLanguage = 'zh-CN'
  ) {}

  current(): TranslationSettings {
    const stored = normalizeSettings(this.read() ?? defaults(this.defaultTargetLanguage), this.defaultTargetLanguage)
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
    const normalized = normalizeSettings(value, this.defaultTargetLanguage)
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
    // ML Kit 只存在于 Android。Desktop 为了兼容共享备份 schema 保留类型，
    // 但永远不把它作为可启用/可默认的本地翻译服务。
    case 'ML_KIT': return { type, enabled: false, endpoint: '', region: '' }
    case 'MICROSOFT': return { type, enabled: false, endpoint: 'https://api.cognitive.microsofttranslator.com', region: '' }
    case 'DEEPL': return { type, enabled: false, endpoint: 'https://api-free.deepl.com/v2/translate', region: '' }
    case 'GOOGLE_CLOUD': return { type, enabled: false, endpoint: 'https://translation.googleapis.com/language/translate/v2', region: '' }
    case 'DLX': return { type, enabled: false, endpoint: '', region: '' }
  }
}
function defaults(defaultTargetLanguage = 'zh-CN'): StoredSettings {
  return { defaultProvider: 'MICROSOFT', defaultTarget: { type: 'traditional', provider: 'MICROSOFT' }, targetLanguage: defaultTargetLanguage, displayMode: 'TRANSLATED', providers: TRANSLATION_PROVIDER_TYPES.map(defaultProvider) }
}
function normalizeSettings(value: Partial<StoredSettings>, defaultTargetLanguage = 'zh-CN'): StoredSettings {
  const incoming = new Map((Array.isArray(value.providers) ? value.providers : []).map((item) => [item.type, item]))
  const providers = TRANSLATION_PROVIDER_TYPES.map((type) => {
    const provider = { ...defaultProvider(type), ...incoming.get(type), type }
    return type === 'ML_KIT' ? { ...provider, enabled: false } : provider
  })
  const enabledDesktopProvider = providers.find((provider) => provider.type !== 'ML_KIT' && provider.enabled)?.type ?? 'MICROSOFT'
  const requestedDefaultProvider = TRANSLATION_PROVIDER_TYPES.includes(value.defaultProvider as TranslationProviderType)
    ? value.defaultProvider as TranslationProviderType
    : enabledDesktopProvider
  const defaultProviderType = requestedDefaultProvider === 'ML_KIT' ? enabledDesktopProvider : requestedDefaultProvider
  const normalizedTarget = normalizeTarget(value.defaultTarget, defaultProviderType)
  const defaultTarget = normalizedTarget.type === 'traditional' && normalizedTarget.provider === 'ML_KIT'
    ? { type: 'traditional' as const, provider: defaultProviderType }
    : normalizedTarget
  return { defaultProvider: defaultProviderType, defaultTarget, targetLanguage: value.targetLanguage === undefined ? defaultTargetLanguage : String(value.targetLanguage), displayMode: value.displayMode === 'BILINGUAL' ? 'BILINGUAL' : 'TRANSLATED', providers }
}
function normalizeTarget(value: unknown, fallback: TranslationProviderType): TranslationTarget {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const target = value as Partial<TranslationTarget> & Record<string, unknown>
    if (target.type === 'traditional' && TRANSLATION_PROVIDER_TYPES.includes(target.provider as TranslationProviderType)) return { type: 'traditional', provider: target.provider as TranslationProviderType }
    if (target.type === 'ai' && typeof target.providerId === 'string' && typeof target.model === 'string') return { type: 'ai', providerId: target.providerId, providerName: String(target.providerName ?? 'AI'), model: target.model }
  }
  return { type: 'traditional', provider: fallback }
}

