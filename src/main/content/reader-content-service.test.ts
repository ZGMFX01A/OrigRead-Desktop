import { afterEach, describe, expect, it } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { ReaderContentService } from './reader-content-service'

const databases: DesktopDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('ReaderContentService', () => {
  it('prefers stored full content over source content and sanitizes it', () => {
    const repository = createRepository()
    const feed = createFeed()
    repository.upsertFeed(feed)
    repository.upsertArticle(createArticle({
      contentHtml: '<p>Feed content</p>',
      fullContentHtml: '<article><script>bad()</script><p>Full body</p><a href="/more">More</a></article>'
    }))

    const result = new ReaderContentService(repository).get('article-1')

    expect(result.mode).toBe('full')
    expect(result.html).toContain('Full body')
    expect(result.html).toContain('href="https://example.com/more"')
    expect(result.html).not.toContain('<script')
  })

  it('can explicitly return feed content after full content has been stored', () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed())
    repository.upsertArticle(createArticle({
      contentHtml: '<p>Feed content</p>',
      fullContentHtml: '<article><p>Full body</p></article>'
    }))
    const service = new ReaderContentService(repository)

    expect(service.get('article-1', true)).toMatchObject({ mode: 'full' })
    const feedContent = service.get('article-1', false)
    expect(feedContent.mode).toBe('content')
    expect(feedContent.html).toContain('Feed content')
    expect(feedContent.html).not.toContain('Full body')
  })

  it('uses source content then escaped plain description as fallbacks', () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed())
    repository.upsertArticle(createArticle({ contentHtml: '<p>Embedded feed body</p>' }))
    repository.upsertArticle(createArticle({
      id: 'article-2',
      url: 'https://example.com/article-2',
      contentHtml: null,
      fullContentHtml: null,
      description: '<not html> & summary'
    }))
    const service = new ReaderContentService(repository)

    expect(service.get('article-1')).toMatchObject({ mode: 'content' })
    const fallback = service.get('article-2')
    expect(fallback.mode).toBe('description')
    expect(fallback.html).toContain('&lt;not html&gt; &amp; summary')
    expect(fallback.html).not.toContain('<not html>')
  })

  it('treats substantial embedded WeChat RSS content as full content', () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed())
    const contentHtml = Array.from({ length: 8 }, (_, index) =>
      `<p>第${index + 1}段：这是由 RSS content:encoded 直接提供的公众号正文，包含足够完整的上下文、论述和文章内容，不需要再次访问微信原网页。</p>`
    ).join('')
    repository.upsertArticle(createArticle({
      url: 'https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=abc',
      contentHtml
    }))

    const result = new ReaderContentService(repository).get('article-1')
    expect(result.mode).toBe('full')
    expect(result.html).toContain('公众号正文')
  })
})

function createRepository(): LibraryRepository {
  const database = new DesktopDatabase(':memory:')
  databases.push(database)
  return new LibraryRepository(database.connection)
}

function createFeed(): FeedRecord {
  const now = 1_786_000_000_000
  return {
    id: 'feed-1',
    groupId: DEFAULT_GROUP_ID,
    name: 'Reader feed',
    url: 'https://example.com/feed.xml',
    sourcePageUrl: 'https://example.com/',
    sourceType: 'rss',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

function createArticle(overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  const now = 1_786_000_000_000
  return {
    id: 'article-1',
    feedId: 'feed-1',
    title: 'Reader article',
    url: 'https://example.com/article-1',
    author: null,
    publishedAt: now,
    description: 'Summary',
    contentHtml: null,
    fullContentHtml: null,
    imageUrl: null,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

