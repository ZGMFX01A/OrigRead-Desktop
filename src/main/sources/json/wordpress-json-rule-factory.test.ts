import { describe, expect, it } from 'vitest'
import {
  createWordPressCandidates,
  createWordPressRule,
  createWordPressRuleFromEndpoint
} from './wordpress-json-rule-factory'

describe('WordPressJsonRuleFactory Android parity', () => {
  it('creates subdirectory candidate before root candidate', () => {
    const candidates = createWordPressCandidates('https://example.com/news/')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]!.endpoint).toBe('https://example.com/news/wp-json/wp/v2/posts?_embed=1&per_page=30')
    expect(candidates[1]!.endpoint).toBe('https://example.com/wp-json/wp/v2/posts?_embed=1&per_page=30')
  })

  it('builds standard posts endpoint from a page url', () => {
    expect(createWordPressRule('https://example.com/category/news').endpoint)
      .toBe('https://example.com/wp-json/wp/v2/posts?_embed=1&per_page=30')
  })

  it('restores only a WordPress posts endpoint', () => {
    const endpoint = 'https://example.com/news/wp-json/wp/v2/posts?_embed=1&per_page=30'
    expect(createWordPressRuleFromEndpoint(endpoint)?.endpoint).toBe(endpoint)
    expect(createWordPressRuleFromEndpoint('https://example.com/api/posts')).toBeNull()
  })
})
