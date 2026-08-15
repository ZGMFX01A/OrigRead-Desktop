import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from './database'
import { SettingsRepository } from './settings-repository'
import { DEFAULT_DESKTOP_SETTINGS } from '../../shared/settings'

describe('SettingsRepository', () => {
  it('returns defaults and persists validated settings', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toEqual(DEFAULT_DESKTOP_SETTINGS)

    expect(repository.update({
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 999,
      readerFontSize: 25,
      readerFontId: 'serif',
      readerLineHeight: 1.72,
      readerContentWidth: 880,
      ttsVoiceURI: 'voice://reader-e2e',
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 999,
      syncIntervalMinutes: 60,
      syncOnStart: true
    })).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 560,
      readerFontSize: 22,
      readerFontId: 'serif',
      readerLineHeight: 1.72,
      readerContentWidth: 880,
      ttsVoiceURI: 'voice://reader-e2e',
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 640,
      syncIntervalMinutes: 60,
      syncOnStart: true
    })
    expect(repository.current().workspaceCollapsed).toBe(true)
    database.close()
  })

  it('rejects invalid boolean patches instead of silently coercing IPC input', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(() => repository.update({ workspaceCollapsed: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ syncIntervalMinutes: 10 } as never)).toThrow(TypeError)
    database.close()
  })
})

