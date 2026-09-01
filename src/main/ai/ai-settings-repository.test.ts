import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS } from '../../shared/ai'
import { MemorySecretStore } from '../security/secret-store'
import { AiSettingsRepository } from './ai-settings-repository'

function createRepository(): { database: DatabaseSync; repository: AiSettingsRepository } {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  return { database, repository: new AiSettingsRepository(database, new MemorySecretStore()) }
}

describe('AiSettingsRepository provider capabilities', () => {
  it('upgrades legacy provider settings with safe capability defaults', () => {
    const { database, repository } = createRepository()
    try {
      database.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(
        'ai.settings',
        JSON.stringify({
          enabled: true,
          defaultProviderId: 'legacy',
          outputLanguage: 'zh-CN',
          summaryLength: 'STANDARD',
          providers: [{ id: 'legacy', name: 'Legacy', enabled: true, endpoint: 'https://example.com/v1', defaultModel: 'model', models: ['model'] }]
        }),
        1
      )

      expect(repository.current().providers[0]).toMatchObject({
        streamingCapabilityOverride: 'AUTO',
        toolCallingCapabilityOverride: 'AUTO',
        reasoningCapabilityOverride: 'AUTO',
        outputTokenLimitStyle: 'AUTO',
        contextWindowTokens: DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
        strictStreamTermination: true
      })
    } finally {
      database.close()
    }
  })

  it('persists provider overrides and clamps impossible context windows', () => {
    const { database, repository } = createRepository()
    try {
      const id = repository.current().providers[0]!.id
      let settings = repository.updateProvider({
        id,
        streamingCapabilityOverride: 'DISABLED',
        toolCallingCapabilityOverride: 'ENABLED',
        reasoningCapabilityOverride: 'ENABLED',
        outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
        contextWindowTokens: 1_000,
        strictStreamTermination: false
      })
      expect(settings.providers[0]).toMatchObject({
        streamingCapabilityOverride: 'DISABLED',
        toolCallingCapabilityOverride: 'ENABLED',
        reasoningCapabilityOverride: 'ENABLED',
        outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
        contextWindowTokens: 4_096,
        strictStreamTermination: false
      })

      settings = repository.updateProvider({ id, contextWindowTokens: 9_000_000 })
      expect(settings.providers[0]!.contextWindowTokens).toBe(4_000_000)
    } finally {
      database.close()
    }
  })

  it('exposes only credential metadata in settings while keeping the secret outside app settings', () => {
    const { database, repository } = createRepository()
    try {
      const id = repository.current().providers[0]!.id
      const settings = repository.updateProvider({ id, apiKey: 'secret-value-123' })
      expect(settings.providers[0]).toMatchObject({ hasApiKey: true, apiKeyLength: 16 })
      expect(repository.getApiKey(id)).toBe('secret-value-123')

      const row = database.prepare('SELECT value FROM app_settings WHERE key=?').get('ai.settings') as { value: string }
      expect(row.value).not.toContain('secret-value-123')
      expect(row.value).not.toContain('hasApiKey')
      expect(row.value).not.toContain('apiKeyLength')
    } finally {
      database.close()
    }
  })

  it('resets endpoint-specific capability overrides when endpoint changes', () => {
    const { database, repository } = createRepository()
    try {
      const id = repository.current().providers[0]!.id
      repository.updateProvider({
        id,
        models: ['old-model'],
        defaultModel: 'old-model',
        streamingCapabilityOverride: 'DISABLED',
        toolCallingCapabilityOverride: 'ENABLED',
        reasoningCapabilityOverride: 'ENABLED',
        outputTokenLimitStyle: 'MAX_COMPLETION_TOKENS',
        contextWindowTokens: 8_192,
        strictStreamTermination: false
      })

      const provider = repository.updateProvider({ id, endpoint: 'https://new.example.com/v1' }).providers[0]!
      expect(provider.models).toEqual([])
      expect(provider).toMatchObject({
        defaultModel: 'old-model',
        streamingCapabilityOverride: 'AUTO',
        toolCallingCapabilityOverride: 'AUTO',
        reasoningCapabilityOverride: 'AUTO',
        outputTokenLimitStyle: 'AUTO',
        contextWindowTokens: 8_192,
        strictStreamTermination: false
      })
    } finally {
      database.close()
    }
  })
})
