import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from './database'
import { SettingsRepository } from './settings-repository'

describe('SettingsRepository', () => {
  it('returns defaults and persists validated settings', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toEqual({
      language: 'system',
      workspaceCollapsed: false,
      workspaceWidth: 420,
      readerFontSize: 17,
      readerLineHeight: 1.85,
      readerContentWidth: 760,
      syncIntervalMinutes: 30,
      syncOnStart: false
    })

    expect(repository.update({
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 999,
      readerFontSize: 25,
      readerLineHeight: 1.72,
      readerContentWidth: 880,
      syncIntervalMinutes: 60,
      syncOnStart: true
    })).toEqual({
      language: 'zh',
      workspaceCollapsed: true,
      workspaceWidth: 560,
      readerFontSize: 22,
      readerLineHeight: 1.72,
      readerContentWidth: 880,
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

