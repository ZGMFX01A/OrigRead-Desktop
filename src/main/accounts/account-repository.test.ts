import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AccountRepository, passwordKey, clientCertificateKey, clientCertificatePassphraseKey } from './account-repository'
import { ORIGREAD_DESKTOP_RELEASE_FEED_URL } from '../../shared/origread-release'

describe('AccountRepository', () => {
  it('rolls back data and the current account if deletion fails, retaining secrets until commit', () => {
    const database = new DesktopDatabase(':memory:')
    const secrets = new MemorySecretStore()
    const accounts = new AccountRepository(database.connection, secrets)
    const library = new LibraryRepository(database.connection)
    try {
      const other = accounts.add({ type: 'local' })
      library.upsertFeed(feed('rollback-feed', other.id, library.getCurrentDefaultGroup().id, 'https://example.com/feed'))
      library.upsertArticle(article('rollback-article', other.id, 'rollback-feed'))
      for (const key of [passwordKey(other.id), clientCertificateKey(other.id), clientCertificatePassphraseKey(other.id)]) secrets.put(key, 'keep')
      database.connection.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT, 'delete failed'); END`)
      expect(() => accounts.delete(other.id)).toThrow('delete failed')
      expect(accounts.currentId()).toBe(other.id)
      expect(library.getArticleByIdForAccount(other.id, 'rollback-article')).not.toBeNull()
      expect(library.getFeedByIdForAccount(other.id, 'rollback-feed')).not.toBeNull()
      for (const key of [passwordKey(other.id), clientCertificateKey(other.id), clientCertificatePassphraseKey(other.id)]) expect(secrets.get(key)).toBe('keep')
    } finally { database.close() }
  })

  it('deletes a nested local library atomically without touching another account', () => {
    const database = new DesktopDatabase(':memory:')
    const library = new LibraryRepository(database.connection)
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    try {
      library.upsertFeed(feed('keep', 1, library.getCurrentDefaultGroup().id, 'https://example.com/feed'))
      library.upsertArticle(article('keep-article', 1, 'keep'))
      const before = library.snapshot(1)
      const second = accounts.add({ type: 'local' })
      for (const [id, parentId] of [['root', null], ['child', 'root'], ['grandchild', 'child']] as const) {
        library.upsertGroup({ id, parentId, accountId: second.id, name: id, sortOrder: 1, isDefault: false })
      }
      library.upsertFeed(feed('nested-feed', second.id, 'grandchild', 'https://example.com/feed'))
      library.upsertArticle(article('nested-article', second.id, 'nested-feed'))
      expect(() => accounts.delete(second.id)).not.toThrow()
      expect(accounts.currentId()).toBe(1)
      expect(library.snapshot(1)).toEqual(before)
      expect(library.getArticleByIdForAccount(1, 'keep-article')).not.toBeNull()
      expect(library.snapshot(second.id)).toEqual({ groups: 0, feeds: 0, articles: 0, unread: 0, starred: 0 })
    } finally { database.close() }
  })

  it('isolates library data by current account and allows the same feed URL in different accounts', () => {
    const database = new DesktopDatabase(':memory:')
    const library = new LibraryRepository(database.connection)
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const first = accounts.current()
    library.upsertFeed(feed('feed-a', first.id, library.getCurrentDefaultGroup().id, 'https://example.com/feed.xml'))
    library.upsertArticle(article('article-a', first.id, 'feed-a'))

    const second = accounts.add({ type: 'local', name: 'Second Local' })
    expect(library.snapshot()).toEqual({ groups: 1, feeds: 0, articles: 0, unread: 0, starred: 0 })
    library.upsertFeed(feed('feed-b', second.id, library.getCurrentDefaultGroup().id, 'https://example.com/feed.xml'))
    library.upsertArticle(article('article-b', second.id, 'feed-b'))
    expect(library.listFeeds().map((item) => item.id)).toEqual(['feed-b'])

    accounts.switchTo(first.id)
    expect(library.listFeeds().find((item) => item.url === ORIGREAD_DESKTOP_RELEASE_FEED_URL)).toMatchObject({
      name: 'OrigRead Desktop Releases',
      accountId: first.id
    })
    expect(library.listFeeds().filter((item) => item.url !== ORIGREAD_DESKTOP_RELEASE_FEED_URL).map((item) => item.id)).toEqual(['feed-a'])
    expect(library.listArticles().map((item) => item.id)).toEqual(['article-a'])
    expect(library.listArticleSummaries().map((item) => item.id)).toEqual(['article-a'])
    expect(library.listArticleSummaries({ kind: 'feed', id: 'feed-b' })).toEqual([])
    expect(library.listArticleSummaries({ kind: 'group', id: library.getFeedByIdForAccount(second.id, 'feed-b')!.groupId })).toEqual([])
    database.close()
  })

  it('creates a default group for each Local account and refuses to delete the last account', () => {
    const database = new DesktopDatabase(':memory:')
    const library = new LibraryRepository(database.connection)
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    expect(() => accounts.delete(accounts.currentId())).toThrow('至少需要保留一个账户')
    const second = accounts.add({ type: 'local', name: 'Local 2' })
    expect(library.getDefaultGroupForAccount(second.id)).toMatchObject({ accountId: second.id, isDefault: true, name: 'Default' })
    accounts.delete(second.id)
    expect(accounts.list()).toHaveLength(1)
    database.close()
  })

  it('keeps remote passwords in SecretStore instead of SQLite', () => {
    const database = new DesktopDatabase(':memory:')
    const secrets = new MemorySecretStore()
    const accounts = new AccountRepository(database.connection, secrets)
    const remote = accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example/api/greader.php', username: 'user', password: 'credential' })
    expect(remote.serverUrl).toBe('https://fresh.example/api/greader.php/')
    expect(accounts.password(remote.id)).toBe('credential')
    const columns = database.connection.prepare('PRAGMA table_info(accounts)').all() as Array<{name:string}>
    expect(columns.some((column) => column.name === 'password')).toBe(false)
    accounts.delete(remote.id)
    expect(accounts.password(remote.id)).toBe('')
    database.close()
  })
})

function feed(id:string,accountId:number,groupId:string,url:string) {
  const now=1_786_000_000_000
  return { id,accountId,groupId,name:id,url,sourcePageUrl:url,sourceType:'rss' as const,icon:null,isNotification:false,isFullContent:false,isBrowser:false,dynamicRendering:false,createdAt:now,updatedAt:now }
}

function article(id:string,accountId:number,feedId:string) {
  const now=1_786_000_000_000
  return { id,accountId,feedId,title:id,url:`https://example.com/${id}`,author:null,publishedAt:now,description:'',contentHtml:'<p>x</p>',fullContentHtml:null,imageUrl:null,isUnread:true,isStarred:false,createdAt:now,updatedAt:now }
}
