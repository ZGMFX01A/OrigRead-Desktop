import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  normalizeDesktopSettingsPatch,
  type DesktopSettings,
  type DesktopSettingsPatch
} from '../../shared/settings'

const DESKTOP_SETTINGS_KEY = 'desktop.settings'

export class SettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  current(): DesktopSettings {
    const row = this.database
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(DESKTOP_SETTINGS_KEY) as { value: string } | undefined
    if (!row) return { ...DEFAULT_DESKTOP_SETTINGS }

    try {
      return normalizeDesktopSettings(JSON.parse(row.value))
    } catch {
      return { ...DEFAULT_DESKTOP_SETTINGS }
    }
  }

  update(patchValue: DesktopSettingsPatch): DesktopSettings {
    const patch = normalizeDesktopSettingsPatch(patchValue)
    const next = normalizeDesktopSettings({ ...this.current(), ...patch })
    this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(DESKTOP_SETTINGS_KEY, JSON.stringify(next), Date.now())
    return next
  }
}

