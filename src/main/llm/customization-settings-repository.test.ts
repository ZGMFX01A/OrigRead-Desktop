import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from '../../shared/llm-customization'
import { LlmCustomizationSettingsRepository } from './customization-settings-repository'

describe('LlmCustomizationSettingsRepository', () => {
  it('persists Skills switch and trimmed Custom Instructions with an 8000 character boundary', () => {
    const database = new DatabaseSync(':memory:')
    database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
    try {
      const repository = new LlmCustomizationSettingsRepository(database)
      expect(repository.current()).toEqual({ skillsEnabled: true, customInstructions: '' })
      expect(repository.update({ skillsEnabled: false, customInstructions: '  Prefer concise answers.  ' })).toEqual({
        skillsEnabled: false,
        customInstructions: 'Prefer concise answers.'
      })
      expect(() => repository.update({ customInstructions: 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 1) })).toThrow()
    } finally {
      database.close()
    }
  })
})


it.each(['{broken', 'null', '[]', '{"skillsEnabled":"false"}', '{"customInstructions":123}'])('backs up corrupt customization without changing it: %s', (raw) => {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  try {
    database.prepare('INSERT INTO app_settings VALUES (?,?,0)').run('llm.customization', raw)
    const repository = new LlmCustomizationSettingsRepository(database)
    expect(() => repository.current()).toThrow(/损坏.*corrupt/)
    expect(() => repository.update({ customInstructions: 'replacement' })).toThrow(/损坏/)
    expect(database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.customization')).toEqual({ value: raw })
    expect(database.prepare("SELECT value FROM app_settings WHERE key LIKE 'llm.customization.corrupt.%'").all()).toEqual([{ value: raw }])
  } finally { database.close() }
})
