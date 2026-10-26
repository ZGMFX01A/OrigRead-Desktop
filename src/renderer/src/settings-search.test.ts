import { describe, expect, it } from 'vitest'
import { searchSettings } from './settings-search'
import { withSettingsSearchMessages } from './settings-search-messages'

const english: Record<string, string> = {
  settings: 'Settings', settingsGeneral: 'General', settingsReading: 'Reading',
  readerFont: 'Reading font', readerFontSize: 'Article font size',
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
    const before = searchSettings('font size', t)[0]
    const after = searchSettings('font size', key => zh[key] ?? key)[0]
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
})
