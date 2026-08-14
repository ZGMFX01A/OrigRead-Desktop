import { describe, expect, it } from 'vitest'
import { resolveBrandName, resolveDesktopLanguage } from './locale'

describe('desktop locale', () => {
  it('uses Chinese UI and brand for Chinese locales', () => {
    expect(resolveDesktopLanguage('zh-CN')).toBe('zh')
    expect(resolveDesktopLanguage('zh_TW')).toBe('zh')
    expect(resolveBrandName('zh-Hans')).toBe('原读')
  })

  it('falls back to English for non-Chinese locales', () => {
    expect(resolveDesktopLanguage('en-US')).toBe('en')
    expect(resolveDesktopLanguage('ja-JP')).toBe('en')
    expect(resolveBrandName('en-GB')).toBe('OrigRead')
  })
})

