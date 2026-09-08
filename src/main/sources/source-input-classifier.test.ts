import { describe, expect, it } from 'vitest'
import { isKnownRssHubEndpoint, sourceInputHint } from './source-input-classifier'

describe('source input classifier', () => {
  it('uses URL shape only as an RSS versus JSON probe-order hint', () => {
    expect(sourceInputHint('https://example.com/feed.xml')).toBe('RSS_LIKELY')
    expect(sourceInputHint('https://example.com/api/feed.xml')).toBe('RSS_LIKELY')
    expect(sourceInputHint('https://example.com/wp-json/wp/v2/posts')).toBe('JSON_LIKELY')
    expect(sourceInputHint('https://example.com/api/v1/feed')).toBe('JSON_LIKELY')
    expect(sourceInputHint('https://example.com/blog')).toBe('GENERIC')
  })

  it('recognizes only routes below official or configured RSSHub instance bases', () => {
    expect(isKnownRssHubEndpoint('https://rsshub.app/bilibili/user/video/2267573')).toBe(true)
    expect(isKnownRssHubEndpoint('https://rsshub.app')).toBe(false)
    expect(isKnownRssHubEndpoint('https://rsshub.app/healthz')).toBe(false)
    expect(isKnownRssHubEndpoint('https://hub.example.com/rsshub/telegram/channel/demo', ['https://hub.example.com/rsshub'])).toBe(true)
    expect(isKnownRssHubEndpoint('https://hub.example.com/telegram/channel/demo', ['https://hub.example.com/rsshub'])).toBe(false)
  })
})
