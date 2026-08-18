import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AccountRepository } from './account-repository'

describe('AccountRepository', () => {
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
    expect(library.listFeeds().map((item) => item.id)).toEqual(['feed-a'])
    expect(library.listArticles().map((item) => item.id)).toEqual(['article-a'])
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
