import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from './database'
import { LibraryRepository } from './library-repository'
import { CURRENT_SCHEMA_VERSION, DEFAULT_GROUP_ID } from './migrations'
import { ORIGREAD_DESKTOP_RELEASE_FEED_URL } from '../../shared/origread-release'

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

    expect(database.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(repository.listGroups()).toEqual([
      { id: DEFAULT_GROUP_ID, accountId: 1, name: 'Default', sortOrder: 0, isDefault: true }
    ])
    expect(repository.snapshot()).toEqual({ groups: 1, feeds: 1, articles: 0, unread: 0, starred: 0 })
    expect(repository.findFeedByUrl(ORIGREAD_DESKTOP_RELEASE_FEED_URL)).toMatchObject({ name: 'OrigRead Desktop Releases', sourceType: 'rss' })

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
    expect(repository.getArticleById(article.id)?.updatedAt).toBe(article.updatedAt)

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
    expect(repository.snapshot()).toMatchObject({ feeds: 2, articles: 1, unread: 0, starred: 1 })

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
    expect(secondRepository.snapshot()).toMatchObject({ feeds: 2, articles: 1, unread: 1, starred: 1 })
    expect(secondRepository.listArticles()[0]?.id).toBe(article.id)
    secondDatabase.close()
  })

  it('clears only non-starred source articles, while deleting the source removes everything', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    repository.upsertFeed(feed)
    repository.upsertArticle(createArticle(feed.id))
    repository.upsertArticle({ ...createArticle(feed.id), id: 'article-starred', isStarred: true })

    repository.deleteArticlesByFeed(feed.id, false)
    expect(repository.listArticlesByFeed(feed.id).map((article) => article.id)).toEqual(['article-starred'])

    repository.deleteArticlesByFeed(feed.id, true)
    repository.deleteFeed(feed.id)
    expect(repository.getFeedById(feed.id)).toBeNull()
    expect(repository.listArticlesByFeed(feed.id)).toEqual([])
    database.close()
  })

  it('archives only expired read and unstarred articles and records their links', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    const now = 1_786_000_000_000
    repository.upsertFeed(feed)
    repository.upsertArticle({ ...createArticle(feed.id), id:'expired', url:'https://example.com/expired', isUnread:false, isStarred:false, updatedAt:now-2*86_400_000 })
    repository.upsertArticle({ ...createArticle(feed.id), id:'starred', url:'https://example.com/starred', isUnread:false, isStarred:true, updatedAt:now-2*86_400_000 })
    repository.upsertArticle({ ...createArticle(feed.id), id:'unread', url:'https://example.com/unread', isUnread:true, isStarred:false, updatedAt:now-2*86_400_000 })
    repository.upsertArticle({ ...createArticle(feed.id), id:'recent', url:'https://example.com/recent', isUnread:false, isStarred:false, updatedAt:now })

    expect(repository.archiveExpiredArticlesForAccount(1,86_400_000,now)).toBe(1)
    expect(repository.listArticles().map((article)=>article.id).sort()).toEqual(['recent','starred','unread'])
    expect(repository.isArchivedLink(feed.id,'https://example.com/expired')).toBe(true)
    expect(repository.isArchivedLink(feed.id,'https://example.com/starred')).toBe(false)
    database.close()
  })

  it('updates article read and starred state in batches larger than 1000 rows', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    repository.upsertFeed(feed)
    const ids: string[] = []
    for (let index = 0; index < 1505; index += 1) {
      const id = `article-${index}`
      ids.push(id)
      repository.upsertArticle({
        ...createArticle(feed.id),
        id,
        url: `https://example.com/${index}`,
        updatedAt: 123
      })
    }

    repository.setArticleUnreadBatchForAccount(1, ids, false)
    repository.setArticleStarredBatchForAccount(1, ids, true)

    const states = repository.listArticleStateForAccount(1)
    expect(states).toHaveLength(1505)
    expect(states.every((article) => !article.isUnread && article.isStarred)).toBe(true)
    expect(repository.getArticleById(ids[0]!)?.updatedAt).toBe(123)
    database.close()
  })

  it('keeps large feed and group scopes independent from the global 200-article window', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    const secondGroupId = 'group-large'
    repository.upsertGroup({
      id: secondGroupId,
      accountId: 1,
      name: 'Large feeds',
      sortOrder: 1,
      isDefault: false
    })
    repository.upsertFeed({ ...feed, groupId: secondGroupId })

    for (let index = 0; index < 470; index += 1) {
      repository.upsertArticle({
        ...createArticle(feed.id),
        id: `rocket-${index}`,
        title: `Rocket ${index}`,
        url: `https://example.com/rocket/${index}`,
        publishedAt: 10_000 + index,
        isUnread: index < 469,
        isStarred: index === 469
      })
    }

    expect(repository.listArticles()).toHaveLength(200)
    expect(repository.listArticlesByFeed(feed.id)).toHaveLength(470)
    expect(repository.listArticlesByGroup(secondGroupId)).toHaveLength(470)
    expect(repository.listFeedArticleStats()).toEqual([
      { feedId: feed.id, total: 470, unread: 469, starred: 1 }
    ])
    database.close()
  })

  it('batch-queries existing article ids across the 800-parameter chunk boundary', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    repository.upsertFeed(feed)
    const articles = Array.from({ length: 1505 }, (_, index) => ({
      ...createArticle(feed.id),
      id: `existing-${index}`,
      url: `https://example.com/existing/${index}`
    }))
    repository.upsertFeedWithArticles(feed, articles)

    const ids = articles.map((article) => article.id)
    const existing = repository.existingArticleIds([...ids, 'missing-1', 'missing-2'])
    expect(existing.size).toBe(1505)
    expect(existing.has('existing-0')).toBe(true)
    expect(existing.has('existing-1504')).toBe(true)
    expect(existing.has('missing-1')).toBe(false)
    database.close()
  })

  it('batch-queries archived links across the 800-parameter chunk boundary', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    repository.upsertFeed(feed)
    const archived = ['https://example.com/archive/10', 'https://example.com/archive/1200']
    const insert = database.connection.prepare(
      'INSERT INTO archived_articles(feed_id,link,archived_at) VALUES(?,?,?)'
    )
    for (const link of archived) insert.run(feed.id, link, Date.now())
    const candidates = Array.from({ length: 1505 }, (_, index) => `https://example.com/archive/${index}`)

    expect([...repository.archivedLinks(feed.id, candidates)].sort()).toEqual([...archived].sort())
    database.close()
  })

  it('persists RSS HTTP validators independently from Feed records', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)
    const feed = createFeed()
    repository.upsertFeedWithArticles(feed, [createArticle(feed.id)], {
      feedId: feed.id,
      feedUrl: feed.url,
      etag: '"etag-v1"',
      lastModified: 'Tue, 18 Aug 2026 12:00:00 GMT',
      updatedAt: 1234
    })

    expect(repository.getRssHttpCache(feed.id)).toEqual({
      feedId: feed.id,
      feedUrl: feed.url,
      etag: '"etag-v1"',
      lastModified: 'Tue, 18 Aug 2026 12:00:00 GMT',
      updatedAt: 1234
    })
    expect(repository.getFeedById(feed.id)).not.toHaveProperty('etag')
    database.close()
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

