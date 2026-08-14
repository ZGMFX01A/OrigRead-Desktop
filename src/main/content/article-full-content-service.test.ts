import { describe, expect, it } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import type { DynamicWebsiteRenderer } from '../sources/website/dynamic-website-render-policy'
import { ArticleFullContentService } from './article-full-content-service'
import { ContentExtractionService } from './content-extraction-service'
import {
  ReadabilityContentExtractor,
  StructuredMetadataContentExtractor,
  WeChatArticleContentExtractor,
  WebsiteRuleContentExtractor
} from './content-extractors'
import { DynamicArticleContentService } from './dynamic-article-content-service'

describe('ArticleFullContentService', () => {
  it('extracts static content once and then reads the DB cache', async () => {
    const { database, repository } = createLibrary()
    let fetches = 0
    const extraction = createExtractionService()
    const dynamic = new DynamicArticleContentService(rendererThatThrows(), extraction)
    const service = new ArticleFullContentService(repository, extraction, dynamic, async (url) => {
      fetches += 1
      return {
        status: 200,
        finalUrl: url,
        html: `<html><head><meta name="author" content="Tester"></head><body><article><h1>Article title</h1><p>${'Static article body with enough useful information. '.repeat(20)}</p></article></body></html>`
      }
    })

    const first = await service.readOrFetch('article-1')
    const second = await service.readOrFetch('article-1')

    expect(first.ok).toBe(true)
    expect(first.content?.mode).toBe('full')
    expect(first.content?.html).toContain('Static article body')
    expect(second.ok).toBe(true)
    expect(fetches).toBe(1)
    expect(repository.getArticleById('article-1')?.fullContentHtml).toContain('Static article body')
    database.close()
  })

  it('uses dynamic rendering only after static extraction fails', async () => {
    const { database, repository } = createLibrary()
    let renders = 0
    const extraction = createExtractionService()
    const renderer: DynamicWebsiteRenderer = {
      async render(url) {
        renders += 1
        return {
          finalUrl: url,
          html: `<html><body><article><h1>Article title</h1><p>${'Rendered article body after JavaScript execution. '.repeat(20)}</p></article></body></html>`
        }
      }
    }
    const service = new ArticleFullContentService(
      repository,
      extraction,
      new DynamicArticleContentService(renderer, extraction),
      async (url) => ({ status: 200, finalUrl: url, html: '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>' })
    )

    const result = await service.readOrFetch('article-1')
    expect(result.ok).toBe(true)
    expect(result.content?.html).toContain('Rendered article body')
    expect(renders).toBe(1)
    database.close()
  })

  it('does not treat a Chromium verification page as article content', async () => {
    const { database, repository } = createLibrary()
    const extraction = createExtractionService()
    const renderer: DynamicWebsiteRenderer = {
      async render(url) { return { finalUrl: url, html: '<html><body>Verify you are human captcha</body></html>' } }
    }
    const service = new ArticleFullContentService(
      repository,
      extraction,
      new DynamicArticleContentService(renderer, extraction),
      async (url) => ({ status: 403, finalUrl: url, html: '<html><body>Access denied</body></html>' })
    )

    const result = await service.readOrFetch('article-1')
    expect(result).toEqual({ ok: false, content: null, failureReason: 'ACCESS_RESTRICTED' })
    expect(repository.getArticleById('article-1')?.fullContentHtml).toBeNull()
    database.close()
  })
})

describe('DynamicArticleContentService', () => {
  it('serializes hidden Chromium full-content work', async () => {
    let active = 0
    let maxActive = 0
    const renderer: DynamicWebsiteRenderer = {
      async render(url) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return {
          finalUrl: url,
          html: `<html><head><title>Dynamic fixture</title></head><body><article><h1>Dynamic fixture</h1><p>${'Dynamic serialized content. '.repeat(30)}</p><p>${'Second paragraph with useful content. '.repeat(30)}</p></article></body></html>`
        }
      }
    }
    const service = new DynamicArticleContentService(renderer, createExtractionService())
    const inputs = ['one', 'two'].map((id) => service.extract({
      url: `https://example.com/${id}`,
      expectedTitle: null,
      staticHtml: '<div id="app"></div>',
      staticFailureReason: 'DYNAMIC_CONTENT'
    }))
    const results = await Promise.all(inputs)
    expect(results.every(Boolean)).toBe(true)
    expect(maxActive).toBe(1)
  })
})

function createExtractionService(): ContentExtractionService {
  return new ContentExtractionService([
    new WeChatArticleContentExtractor(),
    new WebsiteRuleContentExtractor(() => []),
    new StructuredMetadataContentExtractor(),
    new ReadabilityContentExtractor()
  ])
}

function rendererThatThrows(): DynamicWebsiteRenderer {
  return { async render() { throw new Error('dynamic renderer should not be called') } }
}

function createLibrary(): { database: DesktopDatabase; repository: LibraryRepository } {
  const database = new DesktopDatabase(':memory:')
  const repository = new LibraryRepository(database.connection)
  const now = Date.now()
  const feed: FeedRecord = {
    id: 'feed-1', groupId: DEFAULT_GROUP_ID, name: 'Feed', url: 'https://example.com/feed', sourcePageUrl: 'https://example.com/',
    sourceType: 'rss', icon: null, isNotification: false, isFullContent: false, isBrowser: false, dynamicRendering: false,
    createdAt: now, updatedAt: now
  }
  const article: ArticleRecord = {
    id: 'article-1', feedId: feed.id, title: 'Article title', url: 'https://example.com/article', author: null,
    publishedAt: now, description: 'Summary', contentHtml: null, fullContentHtml: null, imageUrl: null,
    isUnread: true, isStarred: false, createdAt: now, updatedAt: now
  }
  repository.upsertFeed(feed)
  repository.upsertArticle(article)
  return { database, repository }
}
