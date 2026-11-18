import { describe, expect, it } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from './database'
import { LibraryRepository } from './library-repository'
import { DEFAULT_GROUP_ID } from './migrations'

function createFeed(id = 'feed-1', accountId = 1, groupId = DEFAULT_GROUP_ID): FeedRecord {
  const now = Date.now()
  return {
    id,
    accountId,
    groupId,
    name: 'Test Feed',
    url: `https://example.com/feed/${id}.xml`,
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

function createArticle(id: string, feedId: string, accountId = 1): ArticleRecord {
  const now = Date.now()
  return {
    id,
    accountId,
    feedId,
    title: `Article ${id}`,
    url: `https://example.com/articles/${id}`,
    author: 'Author',
    publishedAt: now,
    description: `Description for ${id}`,
    contentHtml: '<p>Full content body</p>',
    fullContentHtml: '<p>Full scraped body</p>',
    imageUrl: null,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

describe('LibraryReadingHistory integration', () => {
  it('updates order on rereading and returns summaries with null content bodies', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    const feed = createFeed()
    repository.upsertFeed(feed)

    const art1 = createArticle('art-1', feed.id)
    const art2 = createArticle('art-2', feed.id)
    repository.upsertArticle(art1)
    repository.upsertArticle(art2)

    // Open art1 at t=1000, art2 at t=2000
    repository.recordArticleOpened(art1.id, 1, 1000)
    repository.recordArticleOpened(art2.id, 1, 2000)

    let recents = repository.listRecentArticles(10, 1)
    expect(recents).toHaveLength(2)
    const [r0, r1] = recents
    expect(r0?.id).toBe(art2.id)
    expect(r0?.lastOpenedAt).toBe(2000)
    expect(r0?.contentHtml).toBeNull()
    expect(r0?.fullContentHtml).toBeNull()
    expect(r1?.id).toBe(art1.id)
    expect(r1?.lastOpenedAt).toBe(1000)
    expect(r1?.contentHtml).toBeNull()
    expect(r1?.fullContentHtml).toBeNull()

    // Reopen art1 at t=3000 -> upsert moves it to the top
    repository.recordArticleOpened(art1.id, 1, 3000)
    recents = repository.listRecentArticles(10, 1)
    expect(recents).toHaveLength(2)
    const [reopened0, reopened1] = recents
    expect(reopened0?.id).toBe(art1.id)
    expect(reopened0?.lastOpenedAt).toBe(3000)
    expect(reopened1?.id).toBe(art2.id)
    expect(reopened1?.lastOpenedAt).toBe(2000)

    database.close()
  })

  it('rejects cross-account article recording and isolates reading history per account', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    // Setup Account 2
    database.connection.prepare(`
      INSERT INTO accounts (id, name, type, sync_interval_minutes, sync_on_start, created_at)
      VALUES (2, 'Second Account', 'local', 30, 0, ?)
    `).run(Date.now())
    database.connection.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default)
      VALUES ('group-acc-2', 2, 'Default', 0, 1)
    `).run()

    const feed1 = createFeed('feed-acc-1', 1, DEFAULT_GROUP_ID)
    const feed2 = createFeed('feed-acc-2', 2, 'group-acc-2')
    repository.upsertFeed(feed1)
    repository.upsertFeed(feed2)

    const art1 = createArticle('art-acc-1', feed1.id, 1)
    const art2 = createArticle('art-acc-2', feed2.id, 2)
    repository.upsertArticle(art1)
    repository.upsertArticle(art2)

    // Attempting to record Account 2's article under Account 1 must be rejected
    expect(() => repository.recordArticleOpened(art2.id, 1)).toThrow(
      /does not belong to account 1/
    )

    // Attempting to record non-existent article must be rejected
    expect(() => repository.recordArticleOpened('non-existent', 1)).toThrow(
      /Article not found/
    )

    // Record legitimately in respective accounts
    repository.recordArticleOpened(art1.id, 1, 1000)
    repository.recordArticleOpened(art2.id, 2, 2000)

    // Account 1 sees only art1
    const recents1 = repository.listRecentArticles(10, 1)
    expect(recents1.map((r) => r.id)).toEqual([art1.id])

    // Account 2 sees only art2
    const recents2 = repository.listRecentArticles(10, 2)
    expect(recents2.map((r) => r.id)).toEqual([art2.id])

    database.close()
  })

  it('caps history at 500 records per account and handles limit edge cases', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    const feed = createFeed()
    repository.upsertFeed(feed)

    // Insert 505 articles in a transaction for speed
    database.connection.exec('BEGIN IMMEDIATE')
    for (let i = 1; i <= 505; i++) {
      const art = createArticle(`batch-art-${i}`, feed.id)
      repository.upsertArticle(art)
    }
    database.connection.exec('COMMIT')

    // Record all 505 opened with increasing timestamps
    for (let i = 1; i <= 505; i++) {
      repository.recordArticleOpened(`batch-art-${i}`, 1, 10000 + i)
    }

    // Verify database only has 500 rows for this account
    const countRow = database.connection
      .prepare('SELECT COUNT(*) AS count FROM reading_history WHERE account_id = 1')
      .get() as { count: number | bigint }
    expect(Number(countRow.count)).toBe(500)

    // Oldest 5 (batch-art-1 through batch-art-5) must have been pruned
    const oldestInDb = database.connection
      .prepare('SELECT article_id FROM reading_history WHERE account_id = 1 AND article_id = ?')
      .get('batch-art-1')
    expect(oldestInDb).toBeUndefined()

    // Newest (batch-art-505) must be present and at the top
    const recents = repository.listRecentArticles()
    expect(recents).toHaveLength(500)
    expect(recents[0]?.id).toBe('batch-art-505')

    // Safe bounds test: NaN, decimal, negative, excessive limit
    expect(repository.listRecentArticles(NaN as unknown as number)).toHaveLength(500)
    expect(repository.listRecentArticles(10.8)).toHaveLength(10)
    expect(repository.listRecentArticles(-5)).toHaveLength(1)
    expect(repository.listRecentArticles(99999)).toHaveLength(500)

    database.close()
  })

  it('cascades history deletion when article or account is deleted', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    const feed = createFeed()
    repository.upsertFeed(feed)

    const art1 = createArticle('art-cascade-1', feed.id)
    const art2 = createArticle('art-cascade-2', feed.id)
    repository.upsertArticle(art1)
    repository.upsertArticle(art2)

    repository.recordArticleOpened(art1.id, 1, 1000)
    repository.recordArticleOpened(art2.id, 1, 2000)
    expect(repository.listRecentArticles(10, 1)).toHaveLength(2)

    // Delete feed (and its articles)
    repository.deleteArticlesByFeed(feed.id, true)

    // Reading history rows must have cascaded
    expect(repository.listRecentArticles(10, 1)).toHaveLength(0)
    const historyCount = database.connection
      .prepare('SELECT COUNT(*) AS count FROM reading_history WHERE account_id = 1')
      .get() as { count: number | bigint }
    expect(Number(historyCount.count)).toBe(0)

    // Account deletion cascade test
    database.connection.prepare(`
      INSERT INTO accounts (id, name, type, sync_interval_minutes, sync_on_start, created_at)
      VALUES (2, 'Account 2', 'local', 30, 0, ?)
    `).run(Date.now())
    database.connection.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default)
      VALUES ('group-acc-2', 2, 'Default', 0, 1)
    `).run()
    const feed2 = createFeed('feed-acc-2', 2, 'group-acc-2')
    repository.upsertFeed(feed2)
    const art3 = createArticle('art-cascade-3', feed2.id, 2)
    repository.upsertArticle(art3)
    repository.recordArticleOpened(art3.id, 2, 3000)
    expect(repository.listRecentArticles(10, 2)).toHaveLength(1)

    // Delete account 2
    database.connection.prepare('DELETE FROM accounts WHERE id = 2').run()
    const historyCountAcc2 = database.connection
      .prepare('SELECT COUNT(*) AS count FROM reading_history WHERE account_id = 2')
      .get() as { count: number | bigint }
    expect(Number(historyCountAcc2.count)).toBe(0)

    database.close()
  })

  it('clearReadingHistory clears only the target account history', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    database.connection.prepare(`
      INSERT INTO accounts (id, name, type, sync_interval_minutes, sync_on_start, created_at)
      VALUES (2, 'Account 2', 'local', 30, 0, ?)
    `).run(Date.now())
    database.connection.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default)
      VALUES ('group-acc-2', 2, 'Default', 0, 1)
    `).run()

    const feed1 = createFeed('feed-acc-1', 1, DEFAULT_GROUP_ID)
    const feed2 = createFeed('feed-acc-2', 2, 'group-acc-2')
    repository.upsertFeed(feed1)
    repository.upsertFeed(feed2)

    const art1 = createArticle('art-clear-1', feed1.id, 1)
    const art2 = createArticle('art-clear-2', feed2.id, 2)
    repository.upsertArticle(art1)
    repository.upsertArticle(art2)

    repository.recordArticleOpened(art1.id, 1, 1000)
    repository.recordArticleOpened(art2.id, 2, 2000)

    // Clear Account 1 only
    repository.clearReadingHistory(1)
    expect(repository.listRecentArticles(10, 1)).toHaveLength(0)

    // Account 2 remains untouched
    const recents2 = repository.listRecentArticles(10, 2)
    expect(recents2).toHaveLength(1)
    expect(recents2[0]?.id).toBe(art2.id)

    database.close()
  })

  it('does not automatically record history when reading content or marking unread/starred', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LibraryRepository(database.connection)

    const feed = createFeed()
    repository.upsertFeed(feed)

    const art = createArticle('art-no-history', feed.id)
    repository.upsertArticle(art)

    // Normal querying/reading
    repository.getArticleById(art.id)
    repository.getArticleSummaryById(art.id)
    repository.listArticles()
    repository.listArticleSummaries()

    // Marking read/starred
    repository.setArticleUnread(art.id, false)
    repository.setArticleStarred(art.id, true)

    // Reading history must still be empty!
    expect(repository.listRecentArticles(10, 1)).toHaveLength(0)

    database.close()
  })
})
