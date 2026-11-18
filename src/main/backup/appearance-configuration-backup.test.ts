import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigurationBackup } from '../../shared/configuration-backup'
import { UI_FONT_SCALE_OPTIONS } from '../../shared/settings'
import { createConfigurationBackupFixture } from './configuration-backup-test-support'

const fixtures: ReturnType<typeof createConfigurationBackupFixture>[] = []
function createFixture() {
  const fixture = createConfigurationBackupFixture(mkdtempSync(join(tmpdir(), 'origread-appearance-backup-')))
  fixtures.push(fixture)
  return fixture
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

describe('desktop appearance configuration backup', () => {
  it.each(['es', 'pt-BR', 'de', 'fr', 'ja'] as const)('round-trips the explicit %s language preference between profiles', language => {
    const source = createFixture()
    source.settings.update({ language })
    const content = source.backup.exportBackup()
    expect(JSON.parse(content).preferences['origread.desktop.language']).toBe(language)
    const target = createFixture()
    target.backup.restoreBackup(content)
    expect(target.settings.current().language).toBe(language)
  })

  it.each(UI_FONT_SCALE_OPTIONS)('round-trips UI font scale %i and article thumbnails between profiles', (uiFontScale) => {
    const source = createFixture()
    source.settings.update({ uiFontScale, showArticleThumbnails: true, showArticleSummaries: false, readerIndentParagraphs: true, readerFontSize: 19 })
    const content = source.backup.exportBackup()
    const backup = JSON.parse(content) as ConfigurationBackup
    expect(backup.preferences).toMatchObject({
      'origread.desktop.uiFontScale': uiFontScale,
      'origread.desktop.showArticleThumbnails': true,
      'origread.desktop.showArticleSummaries': false,
      'origread.desktop.readerIndentParagraphs': true,
      'origread.desktop.readerFontSize': 19
    })

    const target = createFixture()
    target.backup.restoreBackup(content)
    expect(target.settings.current()).toMatchObject({ uiFontScale, showArticleThumbnails: true, showArticleSummaries: false, readerIndentParagraphs: true, readerFontSize: 19 })
    source.settings.update({ showArticleThumbnails: false, showArticleSummaries: true, readerIndentParagraphs: false })
    target.backup.restoreBackup(source.backup.exportBackup())
    expect(target.settings.current()).toMatchObject({ uiFontScale, showArticleThumbnails: false, showArticleSummaries: true, readerIndentParagraphs: false, readerFontSize: 19 })
  })

  it('restores old backups to 100% and hidden thumbnails instead of retaining the target profile preferences', () => {
    const source = createFixture()
    source.settings.update({ readerFontSize: 21 })
    const backup = JSON.parse(source.backup.exportBackup()) as ConfigurationBackup
    delete backup.preferences['origread.desktop.uiFontScale']
    delete backup.preferences['origread.desktop.showArticleThumbnails']
    delete backup.preferences['origread.desktop.showArticleSummaries']
    delete backup.preferences['origread.desktop.readerIndentParagraphs']
    const target = createFixture()
    target.settings.update({ uiFontScale: 150, showArticleThumbnails: true, showArticleSummaries: false, readerIndentParagraphs: true, readerFontSize: 15 })

    target.backup.restoreBackup(JSON.stringify(backup))
    expect(target.settings.current()).toMatchObject({
      uiFontScale: 100, showArticleThumbnails: false, showArticleSummaries: true, readerIndentParagraphs: false, readerFontSize: 21
    })
  })

  it.each([
    ['origread.desktop.language', 'xx'],
    ['origread.desktop.language', 'pt-PT'],
    ['origread.desktop.language', null],
    ['origread.desktop.language', 123],
    ['origread.desktop.uiFontScale', '125'],
    ['origread.desktop.uiFontScale', 105],
    ['origread.desktop.uiFontScale', null],
    ['origread.desktop.uiFontScale', -100],
    ['origread.desktop.showArticleThumbnails', 'true'],
    ['origread.desktop.showArticleThumbnails', 1],
    ['origread.desktop.showArticleThumbnails', null],
    ['origread.desktop.showArticleThumbnails', {}],
    ['origread.desktop.showArticleSummaries', 'true'],
    ['origread.desktop.showArticleSummaries', 1],
    ['origread.desktop.showArticleSummaries', null],
    ['origread.desktop.showArticleSummaries', {}],
    ['origread.desktop.readerIndentParagraphs', 'true'],
    ['origread.desktop.readerIndentParagraphs', 1],
    ['origread.desktop.readerIndentParagraphs', null],
    ['origread.desktop.readerIndentParagraphs', {}]
  ] as const)('rejects invalid %s preference %# before changing any settings', (key, value) => {
    const fixture = createFixture()
    const backup = JSON.parse(fixture.backup.exportBackup()) as ConfigurationBackup
    backup.preferences[key] = value
    backup.preferences['origread.desktop.theme'] = 'light'
    const before = fixture.settings.update({ uiFontScale: 150, showArticleThumbnails: true, readerIndentParagraphs: true, theme: 'dark' })
    const content = JSON.stringify(backup)

    expect(() => fixture.backup.inspect(content)).toThrow(/语言|界面字号|缩略图|文章摘要|段落缩进/)
    expect(() => fixture.backup.restoreBackup(content)).toThrow(/语言|界面字号|缩略图|文章摘要|段落缩进/)
    expect(fixture.settings.current()).toEqual(before)
  })
})
