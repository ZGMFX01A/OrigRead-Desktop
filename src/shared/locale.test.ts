import { describe, expect, it } from 'vitest'
import { resolveBrandName, resolveDesktopLanguage } from './locale'

describe('desktop locale', () => {
  it('uses Chinese UI and brand for Chinese locales', () => {
    expect(resolveDesktopLanguage('zh-CN')).toBe('zh')
    expect(resolveDesktopLanguage('zh_TW')).toBe('zh')
    expect(resolveBrandName('zh-Hans')).toBe('原读')
  })

  it('uses available translations and defaults to English for unknown locales', () => {
    expect(resolveDesktopLanguage('en-US')).toBe('en')
    expect(resolveDesktopLanguage('ja-JP')).toBe('ja')
    expect(resolveDesktopLanguage('es-ES')).toBe('es')
    expect(resolveDesktopLanguage('pt-PT')).toBe('pt-BR')
    expect(resolveDesktopLanguage('de-DE')).toBe('de')
    expect(resolveDesktopLanguage('fr-FR')).toBe('fr')
    expect(resolveDesktopLanguage('ko-KR')).toBe('en')
    expect(resolveBrandName('en-GB')).toBe('OrigRead')
  })
})

