import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { WebSearchRepository } from './web-search-repository'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const secrets = new MemorySecretStore()
  return { database, secrets, repository: new WebSearchRepository(database, secrets) }
}

describe('WebSearchRepository', () => {
  it('keeps secrets outside app_settings and normalizes default provider/result limits', () => {
    const { database, repository } = setup()
    try {
      expect(repository.current()).toEqual({ mode: 'OFF', providers: [], defaultProviderId: null, maxResults: 5 })
      const tavily = repository.addProvider('TAVILY').providers[0]!
      const exa = repository.addProvider('EXA').providers.find((provider) => provider.kind === 'EXA')!
      expect(repository.current().defaultProviderId).toBe(tavily.id)

      repository.updateProvider({ id: tavily.id, apiKey: 'tvly-secret', enabled: false })
      expect(repository.current().defaultProviderId).toBe(exa.id)
      expect(repository.updateSettings({ mode: 'AUTO', maxResults: 999 }).maxResults).toBe(20)
      expect(repository.current().providers.find((provider) => provider.id === tavily.id)).toMatchObject({ hasApiKey: true, apiKeyLength: 11 })
      expect(repository.getApiKey(tavily.id)).toBe('tvly-secret')

      const stored = database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.web-search') as { value: string }
      expect(stored.value).not.toContain('tvly-secret')
      expect(stored.value).not.toContain('hasApiKey')
      expect(stored.value).not.toContain('apiKeyLength')
    } finally { database.close() }
  })

  it('supports optional-key Keenable and rejects dangling secret restore references', () => {
    const source = setup()
    const target = setup()
    try {
      const keenable = source.repository.addProvider('KEENABLE').providers[0]!
      expect(source.repository.isConfigured(keenable.id)).toBe(true)
      source.repository.updateProvider({ id: keenable.id, apiKey: 'optional-key' })
      const settings = source.repository.exportStoredSettings()
      const apiKeys = source.repository.exportApiKeys()
      expect(apiKeys).toEqual({ [keenable.id]: 'optional-key' })
      expect(target.repository.restore(settings, apiKeys).providers[0]).toMatchObject({ kind: 'KEENABLE', hasApiKey: true })
      expect(() => target.repository.restore(settings, { missing: 'secret' })).toThrow('不存在的 Provider')
    } finally {
      source.database.close()
      target.database.close()
    }
  })
})
