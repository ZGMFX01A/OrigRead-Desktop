import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AiSettingsRepository } from './ai-settings-repository'
import { TranslationSettingsRepository } from '../translation/translation-settings-repository'
import { MemorySecretStore } from '../security/secret-store'

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  return database
}

describe('system language defaults', () => {
  it('uses the OS locale for first-run AI and translation target languages', () => {
    const database = createDatabase()
    const secrets = new MemorySecretStore()
    const ai = new AiSettingsRepository(database, secrets, 'en-US')
    const translation = new TranslationSettingsRepository(database, secrets, 'en-US')

    expect(ai.current().outputLanguage).toBe('en-US')
    expect(translation.current().targetLanguage).toBe('en-US')
    database.close()
  })

  it('keeps explicit user languages when the OS locale later differs', () => {
    const database = createDatabase()
    const secrets = new MemorySecretStore()
    const ai = new AiSettingsRepository(database, secrets, 'en-US')
    const translation = new TranslationSettingsRepository(database, secrets, 'en-US')
    ai.setOutputLanguage('ja-JP')
    translation.setTargetLanguage('de-DE')

    expect(new AiSettingsRepository(database, secrets, 'zh-CN').current().outputLanguage).toBe('ja-JP')
    expect(new TranslationSettingsRepository(database, secrets, 'zh-CN').current().targetLanguage).toBe('de-DE')
    database.close()
  })
})
