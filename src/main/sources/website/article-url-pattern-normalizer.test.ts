import { describe, expect, it } from 'vitest'
import { normalizeArticleUrlPattern } from './article-url-pattern-normalizer'

describe('normalizeArticleUrlPattern', () => {
  it('normalizes numeric date slug uuid and query ids like Android', () => {
    const normalize = (url: string) => normalizeArticleUrlPattern(url, 'example.com')?.key
    expect(normalize('https://www.example.com/news/123456.html')).toBe('example.com/news/{number}.html')
    expect(normalize('https://example.com/news/2026/08/05/origread-release-notes'))
      .toBe('example.com/news/{year}/{month}/{day}/{slug}')
    expect(normalize('https://example.com/posts/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('example.com/posts/{uuid}')
    expect(normalize('https://example.com/article?id=98765&utm_source=test'))
      .toBe('example.com/article?id={number}')
    expect(normalize('https://example.com/article?preview')).toBe('example.com/article?preview')
  })

  it('accepts same-site subdomains and rejects external links', () => {
    expect(normalizeArticleUrlPattern('https://news.example.com/article/123', 'www.example.com')?.key)
      .toBe('example.com/article/{number}')
    expect(normalizeArticleUrlPattern('https://external.example.net/article/123', 'example.com')).toBeNull()
  })
})

