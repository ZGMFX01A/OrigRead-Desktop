import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretStore } from '../security/secret-store'
import {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_PROVIDER_KINDS,
  normalizeWebSearchMaxResults,
  webSearchProviderDefinition,
  type PersistentWebSearchMode,
  type WebSearchProviderKind,
  type WebSearchProviderPatch,
  type WebSearchProviderProfile,
  type WebSearchSettings
} from '../../shared/web-search'

const SETTINGS_KEY = 'llm.web-search'
const MAX_PROVIDER_NAME_LENGTH = 80
const MAX_PROVIDER_ENDPOINT_LENGTH = 2_000

interface StoredWebSearchProviderProfile {
  id: string
  kind: WebSearchProviderKind
  name: string
  endpoint: string
  enabled: boolean
}

interface StoredWebSearchSettings {
  mode: PersistentWebSearchMode
  providers: StoredWebSearchProviderProfile[]
  defaultProviderId: string | null
  maxResults: number
}

export class WebSearchRepository {
  constructor(private readonly database: DatabaseSync, private readonly secrets: SecretStore) {}

  current(): WebSearchSettings {
    return this.toPublic(this.read() ?? defaultSettings())
  }

  addProvider(kind: WebSearchProviderKind): WebSearchSettings {
    if (!WEB_SEARCH_PROVIDER_KINDS.includes(kind)) throw new Error('不支持的 Web Search Provider')
    const definition = webSearchProviderDefinition(kind)
    const current = this.toStored(this.current())
    const provider: StoredWebSearchProviderProfile = {
      id: randomUUID(),
      kind,
      name: definition.defaultName,
      endpoint: definition.defaultEndpoint,
      enabled: true
    }
    return this.save({
      ...current,
      providers: [...current.providers, provider],
      defaultProviderId: current.defaultProviderId ?? provider.id
    })
  }

  removeProvider(providerId: string): WebSearchSettings {
    const current = this.toStored(this.current())
    if (!current.providers.some((provider) => provider.id === providerId)) return this.toPublic(current)
    this.secrets.delete(secretKey(providerId))
    const providers = current.providers.filter((provider) => provider.id !== providerId)
    return this.save({
      ...current,
      providers,
      defaultProviderId: normalizeDefaultProviderId(providers, current.defaultProviderId === providerId ? null : current.defaultProviderId)
    })
  }

  updateProvider(patch: WebSearchProviderPatch): WebSearchSettings {
    const current = this.toStored(this.current())
    const existing = current.providers.find((provider) => provider.id === patch.id)
    if (!existing) throw new Error('Web Search Provider 不存在')
    if (patch.apiKey !== undefined) this.secrets.put(secretKey(existing.id), patch.apiKey)
    const provider: StoredWebSearchProviderProfile = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name.trim().slice(0, MAX_PROVIDER_NAME_LENGTH) || webSearchProviderDefinition(existing.kind).defaultName }),
      ...(patch.endpoint === undefined ? {} : { endpoint: normalizeEndpoint(patch.endpoint) }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled })
    }
    const providers = current.providers.map((item) => item.id === provider.id ? provider : item)
    return this.save({
      ...current,
      providers,
      defaultProviderId: normalizeDefaultProviderId(providers, current.defaultProviderId)
    })
  }

  updateSettings(patch: Partial<Pick<WebSearchSettings, 'mode' | 'defaultProviderId' | 'maxResults'>>): WebSearchSettings {
    const current = this.toStored(this.current())
    const mode: PersistentWebSearchMode = patch.mode === 'OFF' ? 'OFF' : patch.mode === 'AUTO' ? 'AUTO' : current.mode
    const defaultProviderId = patch.defaultProviderId === undefined
      ? current.defaultProviderId
      : normalizeDefaultProviderId(current.providers, patch.defaultProviderId)
    return this.save({
      ...current,
      mode,
      defaultProviderId,
      maxResults: patch.maxResults === undefined ? current.maxResults : normalizeWebSearchMaxResults(patch.maxResults)
    })
  }

  getApiKey(providerId: string): string {
    return this.secrets.get(secretKey(providerId))
  }

  configuredProviders(): WebSearchProviderProfile[] {
    return this.current().providers.filter((provider) => this.isConfigured(provider.id))
  }

  isConfigured(providerId: string): boolean {
    const provider = this.current().providers.find((item) => item.id === providerId)
    if (!provider || !provider.enabled || !provider.endpoint.trim()) return false
    return !webSearchProviderDefinition(provider.kind).requiresApiKey || provider.hasApiKey
  }

  exportStoredSettings(): StoredWebSearchSettings {
    return this.toStored(this.current())
  }

  exportApiKeys(): Record<string, string> {
    return Object.fromEntries(this.current().providers.flatMap((provider) => {
      const apiKey = this.getApiKey(provider.id)
      return apiKey ? [[provider.id, apiKey]] : []
    }))
  }

  restore(settings: unknown, apiKeys?: Record<string, string>): WebSearchSettings {
    const normalized = normalizeStoredSettings(settings)
    const providerIds = new Set(normalized.providers.map((provider) => provider.id))
    if (apiKeys && Object.keys(apiKeys).some((providerId) => !providerIds.has(providerId))) {
      throw new Error('Web Search 凭据引用了不存在的 Provider')
    }
    const restored = this.save(normalized)
    if (apiKeys) {
      for (const provider of restored.providers) this.secrets.put(secretKey(provider.id), apiKeys[provider.id] ?? '')
    }
    return this.current()
  }

  private save(settings: StoredWebSearchSettings): WebSearchSettings {
    const normalized = normalizeStoredSettings(settings)
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(normalized), Date.now())
    return this.toPublic(normalized)
  }

  private read(): StoredWebSearchSettings | null {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return null
    try { return normalizeStoredSettings(JSON.parse(row.value)) } catch { return null }
  }

  private toPublic(settings: StoredWebSearchSettings): WebSearchSettings {
    return {
      ...settings,
      providers: settings.providers.map((provider) => ({
        ...provider,
        hasApiKey: this.secrets.contains(secretKey(provider.id)),
        apiKeyLength: this.secrets.get(secretKey(provider.id)).length
      }))
    }
  }

  private toStored(settings: WebSearchSettings): StoredWebSearchSettings {
    return {
      mode: settings.mode,
      defaultProviderId: settings.defaultProviderId,
      maxResults: settings.maxResults,
      providers: settings.providers.map(({ hasApiKey: _hasApiKey, apiKeyLength: _apiKeyLength, ...provider }) => provider)
    }
  }
}

function defaultSettings(): StoredWebSearchSettings {
  return { mode: 'OFF', providers: [], defaultProviderId: null, maxResults: DEFAULT_WEB_SEARCH_MAX_RESULTS }
}

function normalizeStoredSettings(value: unknown): StoredWebSearchSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultSettings()
  const record = value as Partial<StoredWebSearchSettings>
  const providers = Array.isArray(record.providers)
    ? record.providers.flatMap((item) => normalizeStoredProvider(item) ? [normalizeStoredProvider(item)!] : [])
    : []
  const defaultProviderId = normalizeDefaultProviderId(providers, typeof record.defaultProviderId === 'string' ? record.defaultProviderId : null)
  return {
    mode: record.mode === 'OFF' ? 'OFF' : 'AUTO',
    providers,
    defaultProviderId,
    maxResults: normalizeWebSearchMaxResults(Number(record.maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS))
  }
}

function normalizeStoredProvider(value: unknown): StoredWebSearchProviderProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<StoredWebSearchProviderProfile>
  if (typeof record.id !== 'string' || !record.id.trim()) return null
  if (typeof record.kind !== 'string' || !WEB_SEARCH_PROVIDER_KINDS.includes(record.kind as WebSearchProviderKind)) return null
  const kind = record.kind as WebSearchProviderKind
  const definition = webSearchProviderDefinition(kind)
  return {
    id: record.id.trim().slice(0, 512),
    kind,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, MAX_PROVIDER_NAME_LENGTH) : definition.defaultName,
    endpoint: normalizeEndpoint(typeof record.endpoint === 'string' ? record.endpoint : definition.defaultEndpoint),
    enabled: record.enabled !== false
  }
}

function normalizeDefaultProviderId(providers: StoredWebSearchProviderProfile[], requested: string | null): string | null {
  if (requested && providers.some((provider) => provider.id === requested && provider.enabled)) return requested
  return providers.find((provider) => provider.enabled)?.id ?? providers[0]?.id ?? null
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim().slice(0, MAX_PROVIDER_ENDPOINT_LENGTH)
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Web Search Endpoint 只支持 HTTP/HTTPS')
  return url.toString()
}

function secretKey(providerId: string): string {
  return `web-search:${providerId}:api-key`
}
