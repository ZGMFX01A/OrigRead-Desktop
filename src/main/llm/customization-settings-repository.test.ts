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
