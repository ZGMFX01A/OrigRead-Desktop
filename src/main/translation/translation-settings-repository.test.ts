import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { TranslationSettingsRepository } from './translation-settings-repository'

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  return database
}

describe('TranslationSettingsRepository desktop defaults', () => {
  it('never exposes ML Kit as the Desktop default translation target', () => {
    const database = createDatabase()
    const repository = new TranslationSettingsRepository(database, new MemorySecretStore())

    const settings = repository.current()

    expect(settings.defaultProvider).toBe('MICROSOFT')
    expect(settings.defaultTarget).toEqual({ type: 'traditional', provider: 'MICROSOFT' })
    expect(settings.providers.find((provider) => provider.type === 'ML_KIT')?.enabled).toBe(false)
    database.close()
  })

  it('migrates a legacy Android ML Kit default to an enabled Desktop provider', () => {
    const database = createDatabase()
    database.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(
      'translation.settings',
      JSON.stringify({
        defaultProvider: 'ML_KIT',
        defaultTarget: { type: 'traditional', provider: 'ML_KIT' },
        targetLanguage: 'zh-CN',
        displayMode: 'TRANSLATED',
        providers: [
          { type: 'ML_KIT', enabled: true, endpoint: '', region: '' },
          { type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', region: '' }
        ]
      }),
      Date.now()
    )

    const settings = new TranslationSettingsRepository(database, new MemorySecretStore()).current()

    expect(settings.defaultProvider).toBe('DEEPL')
    expect(settings.defaultTarget).toEqual({ type: 'traditional', provider: 'DEEPL' })
    expect(settings.providers.find((provider) => provider.type === 'ML_KIT')?.enabled).toBe(false)
    database.close()
  })
})
