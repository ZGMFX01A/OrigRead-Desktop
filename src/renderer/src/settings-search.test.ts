import { describe, expect, it } from 'vitest'
import { searchSettings } from './settings-search'
import { withSettingsSearchMessages } from './settings-search-messages'
import { withAppearanceMessages } from './appearance-messages'

const english: Record<string, string> = {
  settings: 'Settings', settingsGeneral: 'General', settingsReading: 'Reading',
  readerFont: 'Reading font', readerFontSize: 'Article font size',
  uiFontScale: 'UI text size', uiFontScaleDescription: 'Adjust interface text without changing article text',
  showArticleThumbnails: 'Show article thumbnails', showArticleThumbnailsDescription: 'Show available images in the article list',
  readerFontSizeDescription: 'Choose a comfortable size for article text',
  aiSettingsTitle: 'AI reading', aiTabSearch: 'Web search',
  webSearchProviders: 'Search services'
}
const t = (key: string): string => english[key] ?? key

describe('desktop settings search', () => {
  it('ignores whitespace and returns an empty list for unknown settings', () => {
    expect(searchSettings(' \n\t ', t)).toEqual([])
    expect(searchSettings('this-setting-does-not-exist', t)).toEqual([])
  })

  it('ranks an exact setting title before keywords and category matches', () => {
    const results = searchSettings(' ARTICLE FONT SIZE ', t)
    expect(results[0]?.item.id).toBe('readerFontSize')
    expect(results[0]?.breadcrumb).toBe('Settings › General › Reading')
  })

  it('opens the actual AI search tab for a provider keyword without requiring a chat model', () => {
    const result = searchSettings('ｄｅｅｐｓｅｅｋ', t)[0]
    expect(result?.item).toMatchObject({ page: 'ai', aiView: 'search', anchor: 'webSearchProviders' })
  })

  it('resolves titles from the current language instead of reusing a previous search snapshot', () => {
    const zh: Record<string, string> = {
      ...english, settings: '设置', settingsGeneral: '通用', settingsReading: '阅读',
      readerFontSize: '正文字号', readerFontSizeDescription: '设置文章文字大小'
    }
    const before = searchSettings('article font size', t)[0]
    const after = searchSettings('article font size', key => zh[key] ?? key)[0]
    expect(before?.title).toBe('Article font size')
    expect(after?.title).toBe('正文字号')
    expect(after?.breadcrumb).toBe('设置 › 通用 › 阅读')
    expect(searchSettings('正文字号', key => zh[key] ?? key)[0]?.item.id).toBe('readerFontSize')
  })

  it('does not advertise Android-only settings and leaves conditional controls in their settings sections', () => {
    expect(searchSettings('ML Kit', t)).toEqual([])
    expect(searchSettings('Bionic reading', t)).toEqual([])
    expect(searchSettings('RSSHub', t).find(result => result.item.id === 'rssHubAddInstance')?.item)
      .toMatchObject({ page: 'rsshub', anchor: 'rssHubAddInstance' })
    expect(searchSettings('backup password', t)[0]?.item.anchor).toBe('backupIncludeSecrets')
  })

  it('adds localized search messages without replacing existing resource text', () => {
    const resources = withSettingsSearchMessages({
      en: { translation: { existing: 'Keep me' } },
      zh: { translation: { existing: '保留' } }
    })
    expect(resources.en.translation).toMatchObject({ existing: 'Keep me', settingsSearchPlaceholder: 'Search settings' })
    expect(resources.zh.translation).toMatchObject({ existing: '保留', settingsSearchPlaceholder: '搜索设置项' })
  })
  it('keeps interface and article font size searches on their separate controls', () => {
    const localized = withAppearanceMessages({ en: { translation: english }, zh: { translation: {
      settings: '设置', settingsGeneral: '通用', settingsReading: '阅读',
      readerFontSize: '正文字号', readerFontSizeDescription: '设置文章文字大小'
    } } })
    const en = (key: string): string => (localized.en.translation as Record<string, string>)[key] ?? key
    const zh = (key: string): string => (localized.zh.translation as Record<string, string>)[key] ?? key
    expect(searchSettings('UI text size', en)[0]?.item.anchor).toBe('uiFontScale')
    expect(searchSettings('Article font size', en)[0]?.item.anchor).toBe('readerFontSize')
    expect(searchSettings('界面字号', zh)[0]?.item.anchor).toBe('uiFontScale')
    expect(searchSettings('正文字号', zh)[0]?.item.anchor).toBe('readerFontSize')
    expect(searchSettings('显示文章缩略图', zh)[0]?.item.anchor).toBe('showArticleThumbnails')
  })

  it.each([
    ['2K', 'uiFontScale'], ['DPI', 'uiFontScale'], ['UI font size', 'uiFontScale'],
    ['界面字体', 'uiFontScale'], ['缩略图', 'showArticleThumbnails'], ['article images', 'showArticleThumbnails']
  ])('finds %s at its actual general settings control', (query, anchor) => {
    const result = searchSettings(query, t)[0]
    expect(result?.item).toMatchObject({ page: 'general', anchor })
    expect(result?.breadcrumb).toBe('Settings › General')
  })

  it.each([
    ['zh', '界面字号', '显示文章缩略图'],
    ['en', 'UI text size', 'Show article thumbnails'],
    ['es', 'Tamaño del texto de la interfaz', 'Mostrar miniaturas de artículos'],
    ['pt-BR', 'Tamanho do texto da interface', 'Mostrar miniaturas dos artigos'],
    ['de', 'Textgröße der Oberfläche', 'Artikelvorschaubilder anzeigen'],
    ['fr', 'Taille du texte de l’interface', 'Afficher les miniatures des articles'],
    ['ja', '画面の文字サイズ', '記事のサムネイルを表示']
  ])('adds localized appearance labels for %s without replacing unrelated text', (language, scaleTitle, thumbnailTitle) => {
    const resources = withAppearanceMessages({ [language]: { translation: { existing: 'Keep me' } } })
    expect(resources[language]?.translation).toMatchObject({
      existing: 'Keep me', uiFontScale: scaleTitle, showArticleThumbnails: thumbnailTitle,
      uiFontScale100: expect.stringContaining('100%'), uiFontScale110: '110%',
      uiFontScale125: '125%', uiFontScale150: '150%',
      uiFontScaleDescription: expect.any(String), showArticleThumbnailsDescription: expect.any(String)
    })
  })

})
