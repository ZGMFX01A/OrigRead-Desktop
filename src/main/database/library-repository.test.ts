import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from './database'
import { LibraryRepository } from './library-repository'
import { DEFAULT_GROUP_ID } from './migrations'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LibraryRepository', () => {
  it('creates schema and default group', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    expect(database.schemaVersion).toBe(2)
    expect(repository.listGroups()).toEqual([
      { id: DEFAULT_GROUP_ID, name: 'Default', sortOrder: 0, isDefault: true }
    ])
    expect(repository.snapshot()).toEqual({ groups: 1, feeds: 0, articles: 0, unread: 0, starred: 0 })

    database.close()
  })

  it('preserves read and starred state when a feed refresh upserts the same article', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    const article = createArticle(feed.id)

    repository.upsertFeed(feed)
    repository.upsertArticle(article)
    repository.setArticleUnread(article.id, false)
    repository.setArticleStarred(article.id, true)

    repository.upsertArticle({
      ...article,
      title: 'Updated title from source',
      description: 'Updated description',
      isUnread: true,
      isStarred: false,
      updatedAt: article.updatedAt + 1
    })

    const [updated] = repository.listArticles()
    expect(updated?.title).toBe('Updated title from source')
    expect(updated?.isUnread).toBe(false)
    expect(updated?.isStarred).toBe(true)
    expect(repository.snapshot()).toMatchObject({ feeds: 1, articles: 1, unread: 0, starred: 1 })

    database.close()
  })

  it('persists library state after closing and reopening the database file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'origread-desktop-'))
    tempDirectories.push(directory)
    const databasePath = join(directory, 'origread.db')
    const feed = createFeed()
    const article = createArticle(feed.id)

    const firstDatabase = new DesktopDatabase(databasePath)
    const firstRepository = new LibraryRepository(firstDatabase.connection)
    firstRepository.upsertFeed(feed)
    firstRepository.upsertArticle(article)
    firstRepository.setArticleStarred(article.id, true)
    firstDatabase.close()

    const secondDatabase = new DesktopDatabase(databasePath)
    const secondRepository = new LibraryRepository(secondDatabase.connection)
    expect(secondRepository.snapshot()).toMatchObject({ feeds: 1, articles: 1, unread: 1, starred: 1 })
    expect(secondRepository.listArticles()[0]?.id).toBe(article.id)
    secondDatabase.close()
  })
})

function createFeed(): FeedRecord {
  const now = Date.now()
  return {
    id: 'feed-1',
    groupId: DEFAULT_GROUP_ID,
    name: 'Example',
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

function createArticle(feedId: string): ArticleRecord {
  const now = Date.now()
  return {
    id: 'article-1',
    feedId,
    title: 'Example article',
    url: 'https://example.com/article',
    author: null,
    publishedAt: now,
    description: 'Description',
    contentHtml: '<p>Body</p>',
    fullContentHtml: null,
    imageUrl: null,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

