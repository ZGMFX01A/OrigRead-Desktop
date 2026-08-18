import { describe, expect, it, vi } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AccountRepository } from './account-repository'
import { DesktopAccountService } from './desktop-account-service'

describe('DesktopAccountService Android parity', () => {
  it('rolls back the inserted account and restores the previous account when credential validation fails', async () => {
    const fixture = createFixture(false)
    const originalId = fixture.accounts.currentId()

    await expect(fixture.service.add({ type:'google_reader',serverUrl:'https://reader.example/',username:'user',password:'invalid' }))
      .rejects.toThrow('服务器拒绝了当前账户凭据')
    expect(fixture.accounts.currentId()).toBe(originalId)
    expect(fixture.accounts.list()).toHaveLength(1)
    expect(fixture.remote.sync).not.toHaveBeenCalled()
    fixture.database.close()
  })

  it('returns after successful credential validation and starts the first remote sync without blocking add completion', async () => {
    const fixture = createFixture(true)
    let releaseSync!:()=>void
    const pending = new Promise<void>((resolve)=>{releaseSync=resolve})
    fixture.remote.sync.mockReturnValueOnce(pending)

    const added = await fixture.service.add({ type:'fresh_rss',serverUrl:'https://fresh.example/',username:'user',password:'valid' })
    expect(added.type).toBe('fresh_rss')
    expect(fixture.accounts.currentId()).toBe(added.id)
    expect(fixture.remote.sync).toHaveBeenCalledWith(added.id)
    releaseSync()
    fixture.database.close()
  })
})

function createFixture(valid:boolean) {
  const database=new DesktopDatabase(':memory:')
  const library=new LibraryRepository(database.connection)
  const accounts=new AccountRepository(database.connection,new MemorySecretStore())
  const remote={
    validCredentials:vi.fn(async()=>valid),sync:vi.fn(async(_id:number):Promise<void>=>{}),subscribeRss:vi.fn(),
    markArticleUnread:vi.fn(),markArticleStarred:vi.fn(),addGroup:vi.fn(),updateFeed:vi.fn(),deleteFeed:vi.fn()
  }
  const localSync={refreshAllSources:vi.fn()}
  const service=new DesktopAccountService(accounts,library,remote as never,localSync as never)
  return{database,library,accounts,remote,service}
}
