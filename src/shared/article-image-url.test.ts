import { describe, expect, it } from 'vitest'
import { resolveArticleImageUrl } from './article-image-url'

describe('article image URLs', () => {
  it('keeps HTTP(S) metadata and signed query parameters intact', () => {
    expect(resolveArticleImageUrl(' https://cdn.example/image.jpg?token=a%2Fb&size=80 ')).toBe('https://cdn.example/image.jpg?token=a%2Fb&size=80')
    expect(resolveArticleImageUrl('http://cdn.example/image.jpg')).toBe('http://cdn.example/image.jpg')
  })

  it('resolves relative and protocol-relative images against the article before the feed', () => {
    const context = { articleUrl: 'https://news.example/posts/story', sourcePageUrl: 'https://source.example/', feedUrl: 'https://feed.example/rss' }
    expect(resolveArticleImageUrl('cover.jpg', context)).toBe('https://news.example/posts/cover.jpg')
    expect(resolveArticleImageUrl('/cover.jpg', context)).toBe('https://news.example/cover.jpg')
    expect(resolveArticleImageUrl('//cdn.example/cover.jpg', context)).toBe('https://cdn.example/cover.jpg')
  })

  it('falls back to the source page and then the feed when earlier bases are unusable', () => {
    expect(resolveArticleImageUrl('cover.jpg', { articleUrl: 'about:blank', sourcePageUrl: 'https://source.example/news/', feedUrl: 'https://feed.example/rss' }))
      .toBe('https://source.example/news/cover.jpg')
    expect(resolveArticleImageUrl('../cover.jpg', { articleUrl: null, sourcePageUrl: 'file:///tmp/page', feedUrl: 'https://feed.example/news/rss' }))
      .toBe('https://feed.example/cover.jpg')
  })

  it.each([null, undefined, '', '   ', 'cover.jpg', '//cdn.example/cover.jpg'])('requires a usable URL or a remote base for %s', value => {
    expect(resolveArticleImageUrl(value)).toBeNull()
  })

  it.each(['data:image/png;base64,AAAA', 'javascript:alert(1)', 'file:///tmp/image.png', 'blob:https://example.com/image', 'ftp://example.com/image', 'https://[invalid', 'https://exam\nple.com/image'])(
    'rejects unsafe or malformed image metadata %s even with a valid base', value => {
      expect(resolveArticleImageUrl(value, { articleUrl: 'https://example.com/article' })).toBeNull()
    }
  )
})
