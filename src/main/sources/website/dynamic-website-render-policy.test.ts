import { describe, expect, it } from 'vitest'
import { isAllowedDynamicNavigation, requiresInteractiveVerification } from './dynamic-website-render-policy'

describe('dynamic website render policy', () => {
  it('allows HTTP(S) same-site and subdomain navigation only', () => {
    expect(isAllowedDynamicNavigation('https://www.example.com/news', 'https://example.com/article/1')).toBe(true)
    expect(isAllowedDynamicNavigation('https://example.com/', 'https://m.example.com/article/1')).toBe(true)
    expect(isAllowedDynamicNavigation('https://example.com/', 'https://external.example.net/article/1')).toBe(false)
    expect(isAllowedDynamicNavigation('https://example.com/', 'file:///c:/secret.txt')).toBe(false)
    expect(isAllowedDynamicNavigation('https://example.com/', 'javascript:alert(1)')).toBe(false)
  })

  it('detects the same WeChat interactive captcha path as Android', () => {
    expect(requiresInteractiveVerification('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?foo=1')).toBe(true)
    expect(requiresInteractiveVerification('https://mp.weixin.qq.com/s/abc')).toBe(false)
    expect(requiresInteractiveVerification('https://example.com/wappoc_appmsgcaptcha')).toBe(false)
  })
})

