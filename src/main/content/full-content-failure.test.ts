import { describe, expect, it } from 'vitest'
import {
  classifyFullContentHtml,
  classifyFullContentHttpStatus,
  shouldAttemptDynamicArticleContent
} from './full-content-failure'

describe('FullContent failure and dynamic policy', () => {
  it('classifies dynamic shells, restrictions and HTTP errors', () => {
    expect(classifyFullContentHtml('<div id="app"></div><noscript>Please enable JavaScript</noscript>')).toBe('DYNAMIC_CONTENT')
    expect(classifyFullContentHtml('<h1>Verify you are human</h1>')).toBe('ACCESS_RESTRICTED')
    expect(classifyFullContentHttpStatus(403)).toBe('ACCESS_RESTRICTED')
    expect(classifyFullContentHttpStatus(500)).toBe('PAGE_UNAVAILABLE')
  })

  it('only attempts dynamic fallback for Android-equivalent conditions', () => {
    expect(shouldAttemptDynamicArticleContent('<div id="app"></div>', 'DYNAMIC_CONTENT', true)).toBe(true)
    expect(shouldAttemptDynamicArticleContent('<h1>Verify you are human</h1>', 'ACCESS_RESTRICTED', true, false)).toBe(false)
    expect(shouldAttemptDynamicArticleContent('<h1>Verify you are human</h1>', 'ACCESS_RESTRICTED', true, true)).toBe(true)
    expect(shouldAttemptDynamicArticleContent(`<article>${'长静态正文'.repeat(200)}</article><script src="/app.js"></script>`, 'NO_CONTENT', true)).toBe(false)
    expect(shouldAttemptDynamicArticleContent('<div id="__next"></div><script src="/app.js"></script>', 'NO_CONTENT', true)).toBe(true)
  })
})
