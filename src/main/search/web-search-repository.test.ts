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

describe('Search transport security', () => {
  it.each(['TAVILY', 'EXA'] as const)('rejects public HTTP for %s on save and restore', (kind) => {
    const { database, repository } = setup()
    try {
      const added = repository.addProvider(kind).providers[0]!
      expect(() => repository.updateProvider({ id: added.id, endpoint: 'http://search.example.com' })).toThrow('HTTPS')
      repository.updateProvider({ id: added.id, endpoint: 'http://127.0.0.1:1234/search' })
      expect(repository.current().providers[0]!.endpoint).toBe('http://127.0.0.1:1234/search')
      const backup = repository.exportStoredSettings()
      backup.providers[0]!.endpoint = 'http://search.example.com'
      expect(() => repository.restore(backup)).toThrow('HTTPS')
    } finally { database.close() }
  })
  it('allows keyless SearXNG over configured HTTP', () => {
    const { database, repository } = setup()
    try {
      const added = repository.addProvider('SEARXNG').providers[0]!
      expect(repository.updateProvider({ id: added.id, endpoint: 'http://search.example.com' }).providers[0]!.endpoint).toBe('http://search.example.com/')
    } finally { database.close() }
  })
})


it.each(['{broken', 'null', '{}', '{"mode":"OFF","providers":[{}]}'])('preserves corrupt search settings: %s', (raw) => {
  const { database, repository } = setup()
  try {
    database.prepare('INSERT INTO app_settings VALUES (?,?,0)').run('llm.web-search', raw)
    expect(() => repository.current()).toThrow(/损坏.*web_search.corrupt/)
    expect(() => repository.addProvider('TAVILY')).toThrow(/损坏/)
    expect(database.prepare("SELECT value FROM app_settings WHERE key='llm.web-search'").get()).toEqual({ value: raw })
    expect(database.prepare("SELECT value FROM app_settings WHERE key LIKE 'web_search.corrupt.%'").all()).toEqual([{ value: raw }])
  } finally { database.close() }
})
it('rolls back settings and credentials when either restore store fails', () => {
  const { database, repository, secrets } = setup()
  try {
    const provider = repository.addProvider('TAVILY').providers[0]!
    repository.updateProvider({ id: provider.id, apiKey: 'old-key' })
    const originalSettings = repository.exportStoredSettings()
    const settings = { ...originalSettings, mode: 'AUTO' }
    const snapshot = secrets.snapshot()
    database.exec("CREATE TRIGGER fail_search BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'settings blocked'); END")
    expect(() => repository.restore(settings, { [provider.id]: 'new-key' })).toThrow('settings blocked')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.exportStoredSettings()).toEqual(originalSettings)
    database.exec('DROP TRIGGER fail_search')
    const put = secrets.put.bind(secrets)
    secrets.put = (key, value) => { put(key, value); throw new Error('secret blocked') }
    expect(() => repository.restore(settings, { [provider.id]: 'new-key' })).toThrow('secret blocked')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.exportStoredSettings()).toEqual(originalSettings)
  } finally { database.close() }
})

it('attempts secret recovery even when database rollback fails, and reports both failures', () => {
  const { database, repository, secrets } = setup()
  try {
    const provider = repository.addProvider('TAVILY').providers[0]!
    repository.updateProvider({ id: provider.id, apiKey: 'old-key' })
    const settings = repository.exportStoredSettings()
    const snapshot = secrets.snapshot()
    const put = secrets.put.bind(secrets)
    secrets.put = (key, value) => { put(key, value); throw new Error('secret write blocked') }
    const exec = database.exec.bind(database)
    database.exec = (sql) => {
      if (sql.startsWith('ROLLBACK TO')) throw new Error('database rollback blocked')
      return exec(sql)
    }
    let failure: unknown
    try { repository.restore(settings, { [provider.id]: 'new-key' }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(['secret write blocked', 'database rollback blocked'])
    expect(secrets.snapshot()).toEqual(snapshot)
  } finally { database.close() }
})
