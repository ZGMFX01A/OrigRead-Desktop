import type { DatabaseSync } from 'node:sqlite'
import type { AiProviderPatch, AiProviderProfile, AiSettings, AiSummaryLength } from '../../shared/ai'
import { DEFAULT_AI_PROVIDER_ID } from '../../shared/ai'
import type { SecretStore } from '../security/secret-store'

const SETTINGS_KEY = 'ai.settings'

interface StoredAiProvider extends Omit<AiProviderProfile, 'hasApiKey'> {}
interface StoredAiSettings extends Omit<AiSettings, 'providers'> { providers: StoredAiProvider[] }

export class AiSettingsRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly secrets: SecretStore,
    private readonly defaultOutputLanguage = 'zh-CN'
  ) {}

  current(): AiSettings {
    const stored = this.read() ?? defaultStoredAiSettings(this.defaultOutputLanguage)
    const normalized = normalizeSettings(stored, this.defaultOutputLanguage)
    return { ...normalized, providers: normalized.providers.map((provider) => ({
      ...provider,
      hasApiKey: this.secrets.contains(secretKey(provider.id))
    })) }
  }

  setEnabled(enabled: boolean): AiSettings { return this.save({ ...this.toStored(this.current()), enabled }) }
  setDefaultProvider(providerId: string): AiSettings {
    const current = this.toStored(this.current())
    if (!current.providers.some((item) => item.id === providerId)) throw new Error('AI Provider 不存在')
    return this.save({ ...current, defaultProviderId: providerId })
  }
  setOutputLanguage(value: string): AiSettings { return this.save({ ...this.toStored(this.current()), outputLanguage: value.trim() || 'zh-CN' }) }
  setSummaryLength(value: AiSummaryLength): AiSettings {
    if (!['BRIEF', 'STANDARD', 'DETAILED'].includes(value)) throw new Error('无效的摘要长度')
    return this.save({ ...this.toStored(this.current()), summaryLength: value })
  }

  addProvider(): AiSettings {
    const current = this.toStored(this.current())
    const id = `provider-${crypto.randomUUID()}`
    return this.save({ ...current, providers: [...current.providers, defaultProvider(id, `AI 服务 ${current.providers.length + 1}`)] })
  }

  updateProvider(patch: AiProviderPatch): AiSettings {
    const current = this.toStored(this.current())
    const existing = current.providers.find((item) => item.id === patch.id)
    if (!existing) throw new Error('AI Provider 不存在')
    if (patch.apiKey !== undefined) this.secrets.put(secretKey(patch.id), patch.apiKey)
    const endpointChanged = patch.endpoint !== undefined && patch.endpoint.trim() !== existing.endpoint
    const updated = current.providers.map((item) => item.id === patch.id ? normalizeProvider({
      ...item,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint } : {}),
      ...(patch.defaultModel !== undefined ? { defaultModel: patch.defaultModel } : {}),
      ...(endpointChanged ? { models: [] } : patch.models !== undefined ? { models: patch.models } : {})
    }) : item)
    return this.save({ ...current, providers: updated })
  }

  removeProvider(id: string): AiSettings {
    const current = this.toStored(this.current())
    if (current.providers.length <= 1) throw new Error('至少保留一个 AI Provider')
    this.secrets.delete(secretKey(id))
    const providers = current.providers.filter((item) => item.id !== id)
    return this.save({ ...current, providers, defaultProviderId: current.defaultProviderId === id ? providers[0]!.id : current.defaultProviderId })
  }

  getApiKey(id: string): string { return this.secrets.get(secretKey(id)) }
  replaceApiKeys(values: Record<string, string>): void {
    for (const provider of this.current().providers) this.secrets.delete(secretKey(provider.id))
    for (const [id, value] of Object.entries(values)) if (value.trim()) this.secrets.put(secretKey(id), value)
  }

  restore(settings: Omit<AiSettings, 'providers'> & { providers: Array<Omit<AiProviderProfile, 'hasApiKey'>> }, apiKeys?: Record<string, string>): AiSettings {
    const restored = this.save(normalizeSettings(settings, this.defaultOutputLanguage))
    if (apiKeys) this.replaceApiKeys(apiKeys)
    return this.current()
  }

  private toStored(settings: AiSettings): StoredAiSettings {
    return { ...settings, providers: settings.providers.map(({ hasApiKey: _ignored, ...provider }) => provider) }
  }
  private save(value: StoredAiSettings): AiSettings {
    const normalized = normalizeSettings(value, this.defaultOutputLanguage)
    this.database.prepare(`INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(SETTINGS_KEY, JSON.stringify(normalized), Date.now())
    return this.current()
  }
  private read(): StoredAiSettings | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    try { return row ? JSON.parse(row.value) as StoredAiSettings : null } catch { return null }
  }
}

function secretKey(id: string): string { return `ai:${id}:api-key` }
function defaultProvider(id = DEFAULT_AI_PROVIDER_ID, name = '默认服务'): StoredAiProvider {
  return { id, name, enabled: true, endpoint: 'https://api.openai.com/v1', defaultModel: '', models: [] }
}
function defaultStoredAiSettings(defaultOutputLanguage = 'zh-CN'): StoredAiSettings {
  return { enabled: false, providers: [defaultProvider()], defaultProviderId: DEFAULT_AI_PROVIDER_ID, outputLanguage: defaultOutputLanguage, summaryLength: 'STANDARD' }
}
function normalizeSettings(value: Partial<StoredAiSettings>, defaultOutputLanguage = 'zh-CN'): StoredAiSettings {
  const providers = Array.isArray(value.providers) && value.providers.length ? value.providers.map(normalizeProvider) : [defaultProvider()]
  const defaultProviderId = providers.some((item) => item.id === value.defaultProviderId) ? value.defaultProviderId! : providers[0]!.id
  const summaryLength: AiSummaryLength = ['BRIEF','STANDARD','DETAILED'].includes(String(value.summaryLength)) ? value.summaryLength as AiSummaryLength : 'STANDARD'
  return { enabled: value.enabled === true, providers, defaultProviderId, outputLanguage: String(value.outputLanguage ?? defaultOutputLanguage).trim() || defaultOutputLanguage, summaryLength }
}
function normalizeProvider(value: Partial<StoredAiProvider>): StoredAiProvider {
  const models = Array.isArray(value.models) ? [...new Set(value.models.map(String).map((item) => item.trim()).filter(Boolean))].sort() : []
  return {
    id: String(value.id ?? '').trim() || `provider-${crypto.randomUUID()}`,
    name: String(value.name ?? '').trim() || 'AI 服务',
    enabled: value.enabled !== false,
    endpoint: String(value.endpoint ?? '').trim(),
    defaultModel: String(value.defaultModel ?? '').trim(),
    models
  }
}

