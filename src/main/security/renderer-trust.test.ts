import { describe, expect, it } from 'vitest'
import { isAllowedRendererUrl } from './renderer-trust'

describe('isAllowedRendererUrl', () => {
  it('trusts only the configured development origin, not prefix/userinfo tricks', () => {
    const policy = { developmentUrl: 'http://localhost:5173/', productionUrl: 'file:///app/renderer/index.html' }
    expect(isAllowedRendererUrl('http://localhost:5173/', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173/settings', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173.evil.example/', policy)).toBe(false)
    expect(isAllowedRendererUrl('http://localhost:5173@evil.example/', policy)).toBe(false)
    expect(isAllowedRendererUrl('http://localhost:5174/', policy)).toBe(false)
  })

  it('trusts only the exact packaged renderer file in production', () => {
    const policy = { developmentUrl: null, productionUrl: 'file:///app/renderer/index.html' }
    expect(isAllowedRendererUrl('file:///app/renderer/index.html', policy)).toBe(true)
    expect(isAllowedRendererUrl('file:///app/renderer/index.html?x=1#reader', policy)).toBe(true)
    expect(isAllowedRendererUrl('file:///app/renderer/other.html', policy)).toBe(false)
    expect(isAllowedRendererUrl('file:///tmp/index.html', policy)).toBe(false)
    expect(isAllowedRendererUrl('https://example.com/', policy)).toBe(false)
  })
})
