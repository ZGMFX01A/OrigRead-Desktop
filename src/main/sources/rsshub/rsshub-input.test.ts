import { describe, expect, it } from 'vitest'
import { buildRssHubFeedUrl, normalizeRssHubRoutePath, parseExplicitRssHubInput } from './rsshub-input'

describe('Desktop RSSHub logical input', () => {
  it.each(['rsshub.app/zhihu/hot', '//rsshub.app/zhihu/hot'])(
    'recognizes a known instance before HTTP normalization: %s', (input) => {
      expect(parseExplicitRssHubInput(input)).toMatchObject({ routePath: '/zhihu/hot', preferredInstance: 'https://rsshub.app' })
    }
  )

  it.each([
    'https://rsshub.app/github/../zhihu/hot',
    'https://rsshub.app/github/%2e%2e/zhihu/hot',
    'https://rsshub.app/zhihu/hot#ignored',
    'rsshub://user:secret@zhihu/hot',
    'rsshub://zhihu:123/hot',
    'rsshub://zhihu/hot#',
    'rsshub://github/foo/../issue/demo',
    'rsshub://github/%2e%2e/secret',
    'rsshub://github/foo\t/bar',
    'rsshub://github/issue/hello world'
  ])('rejects unsafe or ambiguous input without silently rewriting it: %s', (input) => {
    expect(parseExplicitRssHubInput(input)).toBeNull()
  })

  it('keeps encoded slashes in route parameters, as Android does', () => {
    expect(normalizeRssHubRoutePath('/example/https%3A%2F%2Fexample.com')).toBe('/example/https%3A%2F%2Fexample.com')
  })

  it('rejects malformed percent escapes instead of storing an invalid logical route', () => {
    expect(normalizeRssHubRoutePath('/github/%ZZ')).toBeNull()
  })

  it('parses rsshub scheme without inventing a preferred instance', () => {
    expect(parseExplicitRssHubInput('rsshub://bilibili/user/dynamic/1161918898')).toEqual({
      originalInput: 'rsshub://bilibili/user/dynamic/1161918898',
      routePath: '/bilibili/user/dynamic/1161918898',
      preferredInstance: null
    })
  })

  it('parses official and configured instance URLs while preserving route query parameters', () => {
    expect(parseExplicitRssHubInput('https://rsshub.app/github/issue/DIYgod/RSSHub?filter_link=x')).toEqual({
      originalInput: 'https://rsshub.app/github/issue/DIYgod/RSSHub?filter_link=x',
      routePath: '/github/issue/DIYgod/RSSHub?filter_link=x',
      preferredInstance: 'https://rsshub.app'
    })
    expect(parseExplicitRssHubInput(
      'https://hub.example.com/rsshub/telegram/channel/demo',
      ['https://hub.example.com/rsshub']
    )).toEqual({
      originalInput: 'https://hub.example.com/rsshub/telegram/channel/demo',
      routePath: '/telegram/channel/demo',
      preferredInstance: 'https://hub.example.com/rsshub'
    })
  })

  it('rejects instance health endpoints and unsafe logical paths', () => {
    expect(parseExplicitRssHubInput('https://rsshub.app/healthz')).toBeNull()
    expect(parseExplicitRssHubInput('rsshub://../secret')).toBeNull()
    expect(normalizeRssHubRoutePath('/foo/%5Cbar')).toBeNull()
  })

  it('joins instance base paths with logical routes without losing the base path', () => {
    expect(buildRssHubFeedUrl('https://hub.example.com/rsshub/', '/telegram/channel/demo'))
      .toBe('https://hub.example.com/rsshub/telegram/channel/demo')
  })
})
