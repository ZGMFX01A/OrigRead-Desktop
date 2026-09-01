import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_LLM_CUSTOMIZATION_SETTINGS,
  normalizeLlmCustomizationSettings,
  normalizeLlmCustomizationSettingsPatch,
  type LlmCustomizationSettings,
  type LlmCustomizationSettingsPatch
} from '../../shared/llm-customization'

const SETTINGS_KEY = 'llm.customization'

export class LlmCustomizationSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(): LlmCustomizationSettings {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return { ...DEFAULT_LLM_CUSTOMIZATION_SETTINGS }
    try { return normalizeLlmCustomizationSettings(JSON.parse(row.value)) } catch { return { ...DEFAULT_LLM_CUSTOMIZATION_SETTINGS } }
  }

  update(value: LlmCustomizationSettingsPatch): LlmCustomizationSettings {
    const patch = normalizeLlmCustomizationSettingsPatch(value)
    const next = normalizeLlmCustomizationSettings({ ...this.current(), ...patch })
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(next), Date.now())
    return next
  }
}
