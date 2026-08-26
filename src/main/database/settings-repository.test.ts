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
      theme: 'dark',
      workspaceCollapsed: true,
      workspaceWidth: 999,
      sourcePaneWidth: 999,
      articlePaneWidth: 100,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: true,
      readerFontSize: 25,
      readerFontId: 'serif',
      readerLineHeight: 1.72,
      readerContentWidth: 880,
      readerBackground: 'custom',
      readerBackgroundCustom: '#E4F6EA',
      ttsVoiceURI: 'voice://reader-e2e',
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 999,
      syncIntervalMinutes: 60,
      syncOnStart: true,
      autoCheckUpdates: false
    })).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      language: 'zh',
      theme: 'dark',
      workspaceCollapsed: true,
      workspaceWidth: 560,
      sourcePaneWidth: 320,
      articlePaneWidth: 320,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: true,
      readerFontSize: 22,
      readerFontId: 'serif',
      readerLineHeight: 1.72,
      readerContentWidth: 880,
      readerBackground: 'custom',
      readerBackgroundCustom: '#e4f6ea',
      ttsVoiceURI: 'voice://reader-e2e',
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 640,
      syncIntervalMinutes: 60,
      syncOnStart: true,
      autoCheckUpdates: false
    })
    expect(repository.current().workspaceCollapsed).toBe(true)
    expect(repository.current().theme).toBe('dark')
    expect(repository.current().readerBackground).toBe('custom')
    expect(repository.current().readerBackgroundCustom).toBe('#e4f6ea')
    expect(repository.current().autoCheckUpdates).toBe(false)
    database.close()
  })

  it('loads old settings with new pane defaults instead of migrating legacy workspace collapse', () => {
    const database = new DesktopDatabase(':memory:')
    database.connection.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run('desktop.settings', JSON.stringify({
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 500
    }), Date.now())
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toMatchObject({
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 500,
      sourcePaneWidth: 260,
      articlePaneWidth: 380,
      sourcePaneCollapsed: false,
      articlePaneCollapsed: false
    })
    database.close()
  })

  it('falls back for invalid pane widths and clamps finite out-of-range values', () => {
    const database = new DesktopDatabase(':memory:')
    database.connection.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run('desktop.settings', JSON.stringify({
      sourcePaneWidth: 'invalid',
      articlePaneWidth: null
    }), Date.now())
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toMatchObject({ sourcePaneWidth: 260, articlePaneWidth: 380 })
    expect(repository.update({ sourcePaneWidth: 100, articlePaneWidth: 999 })).toMatchObject({
      sourcePaneWidth: 220,
      articlePaneWidth: 480
    })
    database.close()
  })

  it('rejects invalid boolean patches instead of silently coercing IPC input', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(() => repository.update({ workspaceCollapsed: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ sourcePaneCollapsed: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ articlePaneCollapsed: 1 } as never)).toThrow(TypeError)
    expect(() => repository.update({ syncIntervalMinutes: 10 } as never)).toThrow(TypeError)
    expect(() => repository.update({ autoCheckUpdates: 'yes' } as never)).toThrow(TypeError)
    database.close()
  })
})

