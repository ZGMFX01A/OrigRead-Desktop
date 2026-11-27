import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from './database'
import { SettingsRepository } from './settings-repository'
import { DEFAULT_DESKTOP_SETTINGS, UI_FONT_SCALE_OPTIONS } from '../../shared/settings'

describe('SettingsRepository', () => {
  it('returns defaults and persists validated settings', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toEqual(DEFAULT_DESKTOP_SETTINGS)

    expect(repository.update({
      language: 'zh',
      theme: 'dark',
      layoutMode: 'two-pane',
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
      readerBackgroundCustom: '#E4F6EA',
      ttsVoiceURI: 'voice://reader-e2e',
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 640,
      syncIntervalMinutes: 60,
      syncOnStart: true,
      autoCheckUpdates: false
    })).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      language: 'zh',
      theme: 'dark',
      layoutMode: 'two-pane',
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
    expect(repository.current().layoutMode).toBe('two-pane')
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
      layoutMode: 'three-pane',
      workspaceCollapsed: true,
      workspaceWidth: 500,
      sourcePaneWidth: 260,
      articlePaneWidth: 380,
      sourcePaneCollapsed: false,
      articlePaneCollapsed: false
    })
    database.close()
  })

  it.each(['replace', 'top', 'bottom'] as const)('migrates legacy AI summary placement %s to right', (legacyPlacement) => {
    const database = new DesktopDatabase(':memory:')
    database.connection.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run('desktop.settings', JSON.stringify({
      aiSummaryPlacement: legacyPlacement,
      aiSummaryPanelSize: 470
    }), Date.now())
    const repository = new SettingsRepository(database.connection)

    expect(repository.current()).toMatchObject({
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 470
    })
    database.close()
  })

  it('reads legacy pane defaults but rejects out-of-range writes', () => {
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
    expect(() => repository.update({ sourcePaneWidth: 100, articlePaneWidth: 999 })).toThrow(TypeError)
    expect(repository.current()).toMatchObject({ sourcePaneWidth: 260, articlePaneWidth: 380 })
    database.close()
  })

  it('rejects invalid boolean patches instead of silently coercing IPC input', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new SettingsRepository(database.connection)

    expect(() => repository.update({ workspaceCollapsed: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ layoutMode: 'invalid' } as never)).toThrow(TypeError)
    expect(() => repository.update({ sourcePaneCollapsed: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ articlePaneCollapsed: 1 } as never)).toThrow(TypeError)
    expect(() => repository.update({ readerIndentParagraphs: 'yes' } as never)).toThrow(TypeError)
    expect(() => repository.update({ syncIntervalMinutes: 10 } as never)).toThrow(TypeError)
    expect(() => repository.update({ autoCheckUpdates: 'yes' } as never)).toThrow(TypeError)
    database.close()
  })
  it.each(UI_FONT_SCALE_OPTIONS)('persists UI font scale %i and independent thumbnail visibility', (uiFontScale) => {
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new SettingsRepository(database.connection)
      repository.update({ readerFontSize: 19, sourcePaneWidth: 300, articlePaneWidth: 440 })
      repository.update({ uiFontScale, showArticleThumbnails: true, showArticleSummaries: false })

      const reloaded = new SettingsRepository(database.connection)
      expect(reloaded.current()).toMatchObject({
        uiFontScale, showArticleThumbnails: true, showArticleSummaries: false,
        readerFontSize: 19, sourcePaneWidth: 300, articlePaneWidth: 440
      })
      reloaded.update({ showArticleThumbnails: false, showArticleSummaries: true })
      expect(repository.current()).toMatchObject({ uiFontScale, showArticleThumbnails: false, showArticleSummaries: true, readerFontSize: 19 })
    } finally {
      database.close()
    }
  })

  it.each([
    {},
    { uiFontScale: '125', showArticleThumbnails: 'true', showArticleSummaries: 'true', readerIndentParagraphs: 'true' },
    { uiFontScale: 200, showArticleThumbnails: 1, showArticleSummaries: 1, readerIndentParagraphs: 1 },
    { uiFontScale: null, showArticleThumbnails: null, showArticleSummaries: null, readerIndentParagraphs: null }
  ])('uses appearance defaults when stored settings are old or malformed: %j', (appearance) => {
    const database = new DesktopDatabase(':memory:')
    try {
      database.connection.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('desktop.settings', JSON.stringify({ ...appearance, readerFontSize: 21 }), Date.now())
      expect(new SettingsRepository(database.connection).current()).toMatchObject({
        uiFontScale: 100, showArticleThumbnails: false, showArticleSummaries: true, readerIndentParagraphs: false, readerFontSize: 21
      })
    } finally {
      database.close()
    }
  })

  it.each([
    { uiFontScale: '125' }, { uiFontScale: null }, { uiFontScale: undefined },
    { uiFontScale: 105 }, { uiFontScale: 0 }, { uiFontScale: -100 },
    { uiFontScale: Number.NaN }, { uiFontScale: Number.POSITIVE_INFINITY },
    { showArticleThumbnails: 'true' }, { showArticleThumbnails: 1 },
    { showArticleThumbnails: null }, { showArticleThumbnails: undefined },
    { showArticleSummaries: 'true' }, { showArticleSummaries: 1 },
    { showArticleSummaries: null },
    { readerIndentParagraphs: 'true' }, { readerIndentParagraphs: 1 },
    { readerIndentParagraphs: null }
  ])('rejects malformed appearance patch %# without changing saved settings', (invalidPatch) => {
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new SettingsRepository(database.connection)
      const before = repository.update({ uiFontScale: 125, showArticleThumbnails: true, readerIndentParagraphs: false, theme: 'light' })
      expect(() => repository.update({ theme: 'dark', ...invalidPatch } as never)).toThrow(TypeError)
      expect(new SettingsRepository(database.connection).current()).toEqual(before)
    } finally {
      database.close()
    }
  })

  it('persists and round-trips reader paragraph indent setting', () => {
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new SettingsRepository(database.connection)
      expect(repository.current().readerIndentParagraphs).toBe(false)
      repository.update({ readerIndentParagraphs: true })
      expect(repository.current().readerIndentParagraphs).toBe(true)

      const reloaded = new SettingsRepository(database.connection)
      expect(reloaded.current().readerIndentParagraphs).toBe(true)
      reloaded.update({ readerIndentParagraphs: false })
      expect(repository.current().readerIndentParagraphs).toBe(false)
    } finally {
      database.close()
    }
  })

})



describe('explicit desktop language preferences', () => {
  it.each(['es', 'pt-BR', 'de', 'fr', 'ja'] as const)('persists %s rather than falling back to the system language', language => {
    const database = new DesktopDatabase(':memory:')
    try {
      const repository = new SettingsRepository(database.connection)
      expect(repository.update({ language }).language).toBe(language)
      expect(new SettingsRepository(database.connection).current().language).toBe(language)
    } finally {
      database.close()
    }
  })
})


it.each([
  {language:'invalid'}, {theme: false}, {workspaceWidth:999}, {sourcePaneWidth:999}, {articlePaneWidth:100},
  {readerFontSize:25}, {readerLineHeight:NaN}, {readerContentWidth:'800'}, {readerFontId:null},
  {readerBackground:'invalid'}, {readerBackgroundCustom:'red'}, {ttsVoiceURI:3}, {aiSummaryPlacement:'top'},
  {aiSummaryPanelSize:999}
])('rejects invalid settings atomically: %j', patch => {
  const database = new DesktopDatabase(':memory:')
  try {
    const repository = new SettingsRepository(database.connection)
    const before = repository.current()
    expect(() => repository.update({...patch, syncOnStart:true} as never)).toThrow(TypeError)
    expect(repository.current()).toEqual(before)
  } finally { database.close() }
})

it('preserves corrupt stored JSON instead of replacing it on update', () => {
  const database = new DesktopDatabase(':memory:')
  try {
    database.connection.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run('desktop.settings', '{broken', 1)
    const repository = new SettingsRepository(database.connection)
    expect(() => repository.current()).toThrow()
    expect(() => repository.update({theme:'dark'})).toThrow()
    expect(database.connection.prepare('SELECT value FROM app_settings WHERE key=?').get('desktop.settings')).toEqual({value:'{broken'})
  } finally { database.close() }
})
