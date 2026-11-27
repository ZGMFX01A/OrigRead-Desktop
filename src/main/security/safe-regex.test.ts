import { describe, expect, it } from 'vitest'
import { assertSafeRegexPattern, compileSafeRegex, MAX_REGEX_PATTERN_LENGTH } from './safe-regex'
import { BUILT_IN_WEBSITE_RULES } from '../../shared/website'
import { compileAndroidRegex } from '../sources/website/website-dom'

describe('safe regex structural validation', () => {
  it.each(['news|updates', '^Sponsored\\b', '\\d{4}-\\d{2}-\\d{2}', '<h1[^>]*>(.*?)</h1>'])('accepts %s', pattern => {
    expect(() => assertSafeRegexPattern(pattern)).not.toThrow()
  })
  it.each([String.raw`\p{(a+)+$`, '(a{0,1}a{0,1})+$', '^a+a+$', '^.*.*X', '(a?)+$', '(a+)+$', '([a-zA-Z]+)*$', '(a|aa)+$', '(a+|b)+', '(.*a){2,}', '([a-z]+){2,}', 'a{1000,}', '(a)\\1', '(?=(a+)+)a', '(?=a+)a', '[', 'x'.repeat(513)])('rejects %s', pattern => {
    expect(() => compileSafeRegex(pattern)).toThrow()
  })
  it('accepts every built-in website pattern and preserves title exclusion semantics', () => {
    for (const rule of BUILT_IN_WEBSITE_RULES) {
      for (const pattern of [rule.includeUrlRegex,rule.urlIdRegex,...rule.excludeTitleRegexes]) if (pattern) expect(() => compileAndroidRegex(pattern)).not.toThrow()
      for (const pattern of rule.excludeTitleRegexes) expect(compileAndroidRegex(pattern).test('Windows 11/10/7 系统镜像下载')).toBe(true)
    }
  })
  it('limits length and preserves flags', () => {
    expect(MAX_REGEX_PATTERN_LENGTH).toBe(512)
    expect(compileSafeRegex('news', 'i').test('NEWS')).toBe(true)
    expect(compileAndroidRegex('(?ims)^news.')).toHaveProperty('dotAll', true)
    expect(() => compileAndroidRegex('(?i)(a+)+')).toThrow()
    expect(() => compileSafeRegex('a', 'ii')).toThrow()
  })
})
