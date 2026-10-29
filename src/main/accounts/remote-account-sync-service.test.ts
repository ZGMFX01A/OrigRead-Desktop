import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { MemorySecretStore } from '../security/secret-store'
import { AccountRepository, remoteDbId } from './account-repository'
import { RemoteAccountSyncService } from './remote-account-sync-service'
import { STREAM_READ, type AccountFetch } from './remote-account-api'

describe('RemoteAccountSyncService Android parity', () => {
  it.each(['google_reader', 'fresh_rss'] as const)('keeps one canonical group when %s sync fails after saving the catalog', async (type) => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type, serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const fetcher = googleFixtureFetch()
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, async (input, init) => {
      const url = String(input)
      if (url.includes('/subscription/edit')) return new Response('OK')
      if (url.includes('/stream/items/contents')) return new Response('article fetch failed', { status: 500 })
      return fetcher(input, init)
    })
    const created = await service.addGroup(' Tech ')
    expect(created.id).toBe(remoteDbId(account.id, 'user/-/label/Tech'))
    await expect(service.sync(account.id)).rejects.toThrow('article fetch failed')
    expect(fixture.library.listGroups().filter(group => group.name === 'Tech')).toEqual([expect.objectContaining({ id: created.id })])
    fixture.database.close()
  })

  it('reuses existing remote groups without another remote write', async () => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const existing = { id: remoteDbId(account.id, 'Tech'), accountId: account.id, name: ' Tech ', sortOrder: 1, isDefault: false }
    fixture.library.upsertGroup(existing)
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, async () => { throw new Error('unexpected remote write') })
    expect((await service.addGroup('Tech')).id).toBe(existing.id)
    expect((await service.addGroup(' Default ')).isDefault).toBe(true)
    await expect(service.addGroup(' ')).rejects.toThrow('分组名称不能为空')
    fixture.database.close()
  })

  it.each(['origread_app_default_group', 'user/-/label/Tech'])('keeps literal remote name %s separate from internal and other category IDs', async (name) => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const fetcher = googleFixtureFetch()
    const edits: URLSearchParams[] = []
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, (input, init) => {
      const url = String(input)
      if (url.includes('/subscription/edit')) {
        edits.push(new URLSearchParams(String(init?.body)))
        return Promise.resolve(new Response('OK'))
      }
      if (url.includes('/subscription/list')) return Promise.resolve(json({ subscriptions: [
        { id: 'feed/a', title: 'A', url: 'https://example.com/a.xml', categories: [{ id: `user/-/label/${name}`, label: name }] },
        { id: 'feed/b', title: 'B', url: 'https://example.com/b.xml', categories: [{ id: 'user/-/label/Tech', label: 'Tech' }] }
      ] }))
      if (url.includes('/stream/items/contents')) return Promise.resolve(new Response('article fetch failed', { status: 500 }))
      return fetcher(input, init)
    })
    const created = await service.addGroup(name)
    const defaultGroup = fixture.library.getDefaultGroupForAccount(account.id)!
    expect(defaultGroup).not.toBeNull()
    expect(created.id).not.toBe(defaultGroup.id)
    expect(edits[0]?.get('a')).toBe(`user/-/label/${name}`)
    await expect(service.sync(account.id)).rejects.toThrow('article fetch failed')
    expect(fixture.library.getDefaultGroupForAccount(account.id)).toEqual(defaultGroup)
    expect(fixture.library.listGroups().filter(group => group.name === name)).toHaveLength(1)
    expect(fixture.library.getFeedById(remoteDbId(account.id, 'a'))?.groupId).toBe(created.id)
    expect(fixture.library.getFeedById(remoteDbId(account.id, 'b'))?.groupId).not.toBe(created.id)
    await service.updateFeed(remoteDbId(account.id, 'b'), { groupId: created.id })
    expect(edits.at(-1)?.get('a')).toBe(`user/-/label/${name}`)
    fixture.database.close()
  })

  it('repairs legacy category IDs before an article fetch failure and preserves starred orphan feeds', async () => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const legacyId = remoteDbId(account.id, 'Tech')
    fixture.library.upsertGroup({ id: legacyId, accountId: account.id, name: 'Tech', sortOrder: 1, isDefault: false })
    const orphan = feedRecord(remoteDbId(account.id, 'orphan'), account.id, legacyId, 'https://example.com/orphan.xml')
    fixture.library.upsertFeed(orphan)
    fixture.library.upsertArticle({ id: remoteDbId(account.id, '999'), accountId: account.id, feedId: orphan.id, title: 'Keep', url: 'https://example.com/999', author: null,
      publishedAt: 1, description: '', contentHtml: '<p>Keep</p>', fullContentHtml: null, imageUrl: null, isUnread: false, isStarred: true, createdAt: 1, updatedAt: 1 })
    const fetcher = googleFixtureFetch()
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, (input, init) =>
      String(input).includes('/stream/items/contents') ? Promise.resolve(new Response('article fetch failed', { status: 500 })) : fetcher(input, init))
    await expect(service.sync(account.id)).rejects.toThrow('article fetch failed')
    expect(fixture.library.listGroups().filter(group => group.name === 'Tech')).toEqual([expect.objectContaining({ id: remoteDbId(account.id, 'user/-/label/Tech') })])
    expect(fixture.library.getFeedById(orphan.id)?.groupId).toBe(remoteDbId(account.id, 'user/-/label/Tech'))
    expect(fixture.library.getArticleById(remoteDbId(account.id, '999'))).toMatchObject({ isUnread: false, isStarred: true, contentHtml: '<p>Keep</p>' })
    fixture.database.close()
  })

  it('keeps distinct remote category IDs even when the server uses the same display name', async () => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const fetcher = googleFixtureFetch()
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, (input, init) => {
      if (String(input).includes('/subscription/list')) return Promise.resolve(json({ subscriptions: [
        { id: 'feed/a', title: 'A', url: 'https://example.com/a.xml', categories: [{ id: 'user/-/label/Tech', label: 'Same' }] },
        { id: 'feed/b', title: 'B', url: 'https://example.com/b.xml', categories: [{ id: 'user/-/label/Other', label: 'Same' }] }
      ] }))
      if (String(input).includes('/stream/items/ids')) return Promise.resolve(json({ itemRefs: [] }))
      return fetcher(input, init)
    })
    await service.sync(account.id)
    expect(fixture.library.listGroups().filter(group => group.name === 'Same').map(group => group.id).sort())
      .toEqual([remoteDbId(account.id, 'user/-/label/Other'), remoteDbId(account.id, 'user/-/label/Tech')])
    expect(fixture.library.getFeedById(remoteDbId(account.id, 'a'))?.groupId).toBe(remoteDbId(account.id, 'user/-/label/Tech'))
    expect(fixture.library.getFeedById(remoteDbId(account.id, 'b'))?.groupId).toBe(remoteDbId(account.id, 'user/-/label/Other'))
    fixture.database.close()
  })

  it('rolls back legacy group remapping if the catalog cannot be saved', async () => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const legacyId = remoteDbId(account.id, 'Tech')
    fixture.library.upsertGroup({ id: legacyId, accountId: account.id, name: 'Tech', sortOrder: 1, isDefault: false })
    const orphan = feedRecord(remoteDbId(account.id, 'orphan'), account.id, legacyId, 'https://example.com/orphan.xml')
    fixture.library.upsertFeed(orphan)
    const fetcher = googleFixtureFetch()
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, (input, init) => {
      if (String(input).includes('/subscription/list')) return Promise.resolve(json({ subscriptions: ['a', 'b'].map(id => ({
        id: `feed/${id}`, title: id, url: 'https://example.com/duplicate.xml', categories: [{ id: 'user/-/label/Tech', label: 'Tech' }]
      })) }))
      return fetcher(input, init)
    })
    await expect(service.sync(account.id)).rejects.toThrow('UNIQUE')
    expect(fixture.library.listGroups().some(group => group.id === legacyId)).toBe(true)
    expect(fixture.library.listGroups().some(group => group.id === remoteDbId(account.id, 'user/-/label/Tech'))).toBe(false)
    expect(fixture.library.getFeedById(orphan.id)?.groupId).toBe(legacyId)
    expect(fixture.library.listFeeds().map(feed => feed.id)).toEqual([orphan.id])
    fixture.database.close()
  })

  it('syncs Google Reader subscriptions/items and treats remote unread/starred snapshots as truth', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'google_reader',serverUrl:'https://reader.example/',username:'u',password:'p'})
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,googleFixtureFetch())

    await service.sync(account.id)

    expect(fixture.library.listGroups().map((group)=>group.name).sort()).toEqual(['Default','Tech'])
    const feed=fixture.library.listFeeds()[0]!
    expect(feed).toMatchObject({accountId:account.id,name:'Remote Feed',url:'https://example.com/feed.xml'})
    const article=fixture.library.listArticles()[0]!
    expect(article).toMatchObject({accountId:account.id,title:'Remote Item',isUnread:true,isStarred:true})
    expect(article.feedId).toBe(feed.id)
    expect(fixture.accounts.get(account.id)?.updatedAt).not.toBeNull()
    fixture.database.close()
  })

  it('syncs Fever groups/feeds/items and preserves orphaned local feeds that still contain starred articles', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'fever',serverUrl:'https://fever.example/api/fever.php',username:'u',password:'p'})
    const oldGroup={id:remoteDbId(account.id,'old-group'),accountId:account.id,name:'Old',sortOrder:10,isDefault:false}
    fixture.library.upsertGroup(oldGroup)
    fixture.library.upsertFeed(feedRecord(remoteDbId(account.id,'old-feed'),account.id,oldGroup.id,'https://old.example/feed.xml'))
    fixture.library.upsertArticle({
      id:remoteDbId(account.id,'999'),accountId:account.id,feedId:remoteDbId(account.id,'old-feed'),title:'Keep me',url:'https://old.example/1',author:null,
      publishedAt:1_786_000_000_000,description:'',contentHtml:'<p>old</p>',fullContentHtml:null,imageUrl:null,isUnread:false,isStarred:true,
      createdAt:1_786_000_000_000,updatedAt:1_786_000_000_000
    })
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,feverFixtureFetch())

    await service.sync(account.id)

    expect(fixture.library.listGroups().some((group)=>group.id===oldGroup.id)).toBe(true)
    expect(fixture.library.listFeeds().some((feed)=>feed.id===remoteDbId(account.id,'old-feed'))).toBe(true)
    const remote=fixture.library.listArticles().find((article)=>article.id===remoteDbId(account.id,'101'))!
    expect(remote).toMatchObject({title:'Fever Item',isUnread:true,isStarred:true})
    expect(fixture.accounts.get(account.id)?.lastArticleId).toBe(remoteDbId(account.id,'101'))
    fixture.database.close()
  })

  it('uses Google Reader quickadd/edit semantics for subscribe, rename, move and unsubscribe', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'fresh_rss',serverUrl:'https://reader.example/',username:'u',password:'p'})
    const calls:Array<{url:string;body:string}>=[]
    const fetcher:AccountFetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
      const body=init?.body instanceof URLSearchParams?init.body.toString():typeof init?.body==='string'?init.body:''
      calls.push({url,body})
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'token'})
      if(url.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
      if(url.includes('/subscription/quickadd'))return json({streamId:'feed/remote-new',streamName:'Remote New'})
      if(url.includes('/subscription/edit'))return new Response('OK',{status:200})
      return new Response('missing',{status:404})
    }
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,fetcher)
    const groupA={id:remoteDbId(account.id,'Tech'),accountId:account.id,name:'Tech',sortOrder:1,isDefault:false}
    const groupB={id:remoteDbId(account.id,'News'),accountId:account.id,name:'News',sortOrder:2,isDefault:false}
    fixture.library.upsertGroup(groupA);fixture.library.upsertGroup(groupB)
    const feedId=await service.subscribeRss({
      feedUrl:'https://example.com/new.xml',sourcePageUrl:'https://example.com/',discoveredFromPage:true,title:'Remote New',siteUrl:'https://example.com/',iconUrl:null,items:[]
    },groupA.id)
    expect(feedId).toBe(remoteDbId(account.id,'remote-new'))

    await service.updateFeed(feedId,{name:'Renamed',groupId:groupB.id})
    expect(fixture.library.getFeedById(feedId)).toMatchObject({name:'Renamed',groupId:groupB.id})
    await service.deleteFeed(feedId)
    expect(fixture.library.getFeedById(feedId)).toBeNull()

    const edits=calls.filter((call)=>call.url.includes('/subscription/edit')).map((call)=>new URLSearchParams(call.body))
    expect(edits.some((form)=>form.get('s')==='feed/remote-new'&&form.get('a')==='user/-/label/Tech'&&form.get('t')==='Remote New')).toBe(true)
    expect(edits.some((form)=>form.get('s')==='feed/remote-new'&&form.get('t')==='Renamed')).toBe(true)
    expect(edits.some((form)=>form.get('s')==='feed/remote-new'&&form.get('a')==='user/-/label/News'&&form.get('r')==='user/-/label/Tech')).toBe(true)
    expect(edits.some((form)=>form.get('ac')==='unsubscribe'&&form.get('s')==='feed/remote-new')).toBe(true)
    fixture.database.close()
  })

  it('keeps the Google Reader default group local-only when subscribing and moving feeds', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'fresh_rss',serverUrl:'https://reader.example/',username:'u',password:'p'})
    const calls:Array<{url:string;body:string}>=[]
    const fetcher:AccountFetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
      const body=init?.body instanceof URLSearchParams?init.body.toString():typeof init?.body==='string'?init.body:''
      calls.push({url,body})
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'token'})
      if(url.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
      if(url.includes('/subscription/quickadd'))return json({streamId:'feed/root-feed',streamName:'Root Feed'})
      if(url.includes('/subscription/edit'))return new Response('OK',{status:200})
      return new Response('missing',{status:404})
    }
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,fetcher)
    const feedId=await service.subscribeRss({
      feedUrl:'https://example.com/root.xml',sourcePageUrl:'https://example.com/',discoveredFromPage:true,
      title:'Root Feed',siteUrl:'https://example.com/',iconUrl:null,items:[]
    })
    const defaultGroup=fixture.library.listGroupsForAccount(account.id).find((group)=>group.isDefault)!
    const tech={id:remoteDbId(account.id,'Tech'),accountId:account.id,name:'Tech',sortOrder:1,isDefault:false}
    fixture.library.upsertGroup(tech)

    await service.updateFeed(feedId,{groupId:tech.id})
    await service.updateFeed(feedId,{groupId:defaultGroup.id})

    const edits=calls.filter((call)=>call.url.includes('/subscription/edit')).map((call)=>new URLSearchParams(call.body))
    expect(edits).toHaveLength(3)
    expect(edits[0]!.get('s')).toBe('feed/root-feed')
    expect(edits[0]!.get('a')).toBeNull()
    expect(edits[0]!.get('r')).toBeNull()
    expect(edits[1]!.get('a')).toBe('user/-/label/Tech')
    expect(edits[1]!.get('r')).toBeNull()
    expect(edits[2]!.get('a')).toBeNull()
    expect(edits[2]!.get('r')).toBe('user/-/label/Tech')
    fixture.database.close()
  })

  it('calibrates Google Reader read and starred state with the same deltas as Android', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'google_reader',serverUrl:'https://reader.example/',username:'u',password:'p'})
    const group={id:remoteDbId(account.id,'Tech'),accountId:account.id,name:'Tech',sortOrder:0,isDefault:false}
    const feed=feedRecord(remoteDbId(account.id,'remote-feed'),account.id,group.id,'https://example.com/feed.xml')
    fixture.library.upsertGroup(group)
    fixture.library.upsertFeed(feed)
    const base={
      accountId:account.id,feedId:feed.id,title:'Existing',url:'https://example.com/item',author:null,
      publishedAt:1_786_000_000_000,description:'',contentHtml:'<p>x</p>',fullContentHtml:null,imageUrl:null,
      createdAt:1_786_000_000_000,updatedAt:1_786_000_000_000
    }
    fixture.library.upsertArticle({...base,id:remoteDbId(account.id,'101'),isUnread:true,isStarred:false})
    fixture.library.upsertArticle({...base,id:remoteDbId(account.id,'102'),isUnread:false,isStarred:true})
    fixture.library.upsertArticle({...base,id:remoteDbId(account.id,'103'),isUnread:true,isStarred:false})
    const fetcher:AccountFetch=async(input)=>{
      const urlText=typeof input==='string'?input:input instanceof URL?input.toString():input.url
      if(urlText.endsWith('/accounts/ClientLogin'))return json({Auth:'token'})
      if(urlText.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
      if(urlText.includes('/subscription/list'))return json({subscriptions:[{
        id:'feed/remote-feed',title:'Remote Feed',categories:[{id:'user/-/label/Tech',label:'Tech'}],
        url:'https://example.com/feed.xml',htmlUrl:'https://example.com/'
      }]})
      if(urlText.includes('/stream/items/ids')){
        const query=new URL(urlText).searchParams
        const stream=query.get('s')??''
        if(stream.includes('starred'))return json({itemRefs:[{id:'101'}]})
        if(stream===STREAM_READ)return json({itemRefs:[{id:'101'}]})
        return json({itemRefs:[{id:'102'}]})
      }
      if(urlText.includes('/stream/items/contents'))throw new Error('existing items should not be fetched again')
      return new Response('missing',{status:404})
    }
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,fetcher)

    await service.sync(account.id)

    expect(fixture.library.getArticleById(remoteDbId(account.id,'101'))).toMatchObject({isUnread:false,isStarred:true})
    expect(fixture.library.getArticleById(remoteDbId(account.id,'102'))).toMatchObject({isUnread:true,isStarred:false})
    // 103 不在最近一个月 remoteRead，也不在 remoteUnread；Android 不会仅凭“不在 unread 集合”就强制标已读。
    expect(fixture.library.getArticleById(remoteDbId(account.id,'103'))).toMatchObject({isUnread:true,isStarred:false})
    fixture.database.close()
  })

  it('places Fever feeds without a group mapping into the local default group instead of failing sync', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'fever',serverUrl:'https://fever.example/api/fever.php',username:'u',password:'p'})
    const fetcher:AccountFetch=async(input)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
      if(url.includes('&groups'))return json({auth:1,groups:[],feeds_groups:[]})
      if(url.includes('&feeds'))return json({auth:1,feeds:[{id:7,title:'Orphan Feed',url:'https://orphan.example/rss',site_url:'https://orphan.example/'}],feeds_groups:[]})
      if(url.includes('&favicons'))return json({auth:1,favicons:[]})
      if(url.includes('&items&since_id='))return json({auth:1,items:[]})
      if(url.includes('&unread_item_ids'))return json({auth:1,unread_item_ids:''})
      if(url.includes('&saved_item_ids'))return json({auth:1,saved_item_ids:''})
      return json({auth:1})
    }
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,fetcher)

    await service.sync(account.id)

    const defaultGroup=fixture.library.listGroupsForAccount(account.id).find((group)=>group.isDefault)
    const feed=fixture.library.getFeedByIdForAccount(account.id,remoteDbId(account.id,'7'))
    expect(defaultGroup).toBeDefined()
    expect(feed).toMatchObject({name:'Orphan Feed',groupId:defaultGroup!.id})
    fixture.database.close()
  })

  it('does not mutate local read/star state when the remote write fails', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'google_reader',serverUrl:'https://reader.example/',username:'u',password:'p'})
    const group={id:remoteDbId(account.id,'Tech'),accountId:account.id,name:'Tech',sortOrder:0,isDefault:false}
    fixture.library.upsertGroup(group)
    const feed=feedRecord(remoteDbId(account.id,'feed'),account.id,group.id,'https://example.com/feed')
    fixture.library.upsertFeed(feed)
    const articleId=remoteDbId(account.id,'101')
    fixture.library.upsertArticle({id:articleId,accountId:account.id,feedId:feed.id,title:'A',url:'https://example.com/a',author:null,publishedAt:1_786_000_000_000,description:'',contentHtml:'<p>A</p>',fullContentHtml:null,imageUrl:null,isUnread:true,isStarred:false,createdAt:1_786_000_000_000,updatedAt:1_786_000_000_000})
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,async(input)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
      if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'token'})
      if(url.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
      if(url.includes('/edit-tag'))return new Response('server failed',{status:500})
      return new Response('missing',{status:404})
    })
    await expect(service.markArticleUnread(articleId,false)).rejects.toThrow('server failed')
    await expect(service.markArticleStarred(articleId,true)).rejects.toThrow('server failed')
    expect(fixture.library.getArticleById(articleId)).toMatchObject({isUnread:true,isStarred:false})
    fixture.database.close()
  })

  it('rejects subscription mutations for Fever exactly like Android capabilities', async () => {
    const fixture=createFixture()
    const account=fixture.accounts.add({type:'fever',serverUrl:'https://fever.example/api/fever.php',username:'u',password:'p'})
    const service=new RemoteAccountSyncService(fixture.accounts,fixture.library,feverFixtureFetch())
    await expect(service.subscribeRss({feedUrl:'https://example.com/rss',sourcePageUrl:'https://example.com/',discoveredFromPage:false,title:'X',siteUrl:'https://example.com/',iconUrl:null,items:[]})).rejects.toThrow('Fever 账户不支持在客户端添加订阅')
    await expect(service.addGroup('Tech')).rejects.toThrow('Fever 账户不支持在客户端新建分组')
    const group={id:remoteDbId(account.id,'5'),accountId:account.id,name:'G',sortOrder:0,isDefault:false};fixture.library.upsertGroup(group)
    const feed=feedRecord(remoteDbId(account.id,'7'),account.id,group.id,'https://example.com/rss');fixture.library.upsertFeed(feed)
    await expect(service.updateFeed(feed.id,{name:'New'})).rejects.toThrow('Fever 账户不支持在客户端重命名或移动订阅')
    await expect(service.deleteFeed(feed.id)).rejects.toThrow('Fever 账户不支持在客户端删除订阅')
    fixture.database.close()
  })
})

function createFixture(){
  const database=new DesktopDatabase(':memory:')
  const library=new LibraryRepository(database.connection)
  const accounts=new AccountRepository(database.connection,new MemorySecretStore())
  return{database,library,accounts}
}

function googleFixtureFetch():AccountFetch {
  return async(input:string|URL|Request,init?:RequestInit)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
    if(url.endsWith('/accounts/ClientLogin'))return json({Auth:'token'})
    if(url.endsWith('/reader/api/0/token'))return new Response('action',{status:200})
    if(url.includes('/subscription/list'))return json({subscriptions:[{id:'feed/remote-feed',title:'Remote Feed',categories:[{id:'user/-/label/Tech',label:'Tech'}],url:'https://example.com/feed.xml',htmlUrl:'https://example.com/'}]})
    if(url.includes('/stream/items/ids')){
      const query=new URL(url).searchParams
      const stream=query.get('s')??''
      if(stream.includes('starred'))return json({itemRefs:[{id:'101'}]})
      if(stream===STREAM_READ)return json({itemRefs:[]})
      return json({itemRefs:[{id:'101'}]})
    }
    if(url.includes('/stream/items/contents')){
      const body=init?.body instanceof URLSearchParams?init.body.toString():typeof init?.body==='string'?init.body:''
      const ids=new URLSearchParams(body).getAll('i')
      expect(ids).toContain('101')
      return json({updated:1_786_000_100,items:[{id:'101',crawlTimeMsec:'1786000100000',published:1_786_000_000,title:'Remote Item',summary:{content:'<p>Remote body</p>'},origin:{streamId:'feed/remote-feed',htmlUrl:'https://example.com/',title:'Remote Feed'},canonical:[{href:'https://example.com/101'}]}]})
    }
    return new Response('missing',{status:404})
  }
}

function feverFixtureFetch():AccountFetch {
  return async(input:string|URL|Request)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url
    if(url.includes('&groups'))return json({auth:1,groups:[{id:5,title:'Tech'}],feeds_groups:[{group_id:5,feed_ids:'7'}]})
    if(url.includes('&feeds'))return json({auth:1,feeds:[{id:7,favicon_id:3,title:'Fever Feed',url:'https://fever-feed.example/rss',site_url:'https://fever-feed.example/'}],feeds_groups:[{group_id:5,feed_ids:'7'}]})
    if(url.includes('&favicons'))return json({auth:1,favicons:[{id:3,data:'data:image/png;base64,AA=='}]})
    if(url.includes('&items&since_id='))return json({auth:1,items:[{id:'101',feed_id:7,title:'Fever Item',author:'A',html:'<p>Body</p>',url:'https://fever-feed.example/101',is_saved:1,is_read:0,created_on_time:1_786_000_000}]})
    if(url.includes('&unread_item_ids'))return json({auth:1,unread_item_ids:'101'})
    if(url.includes('&saved_item_ids'))return json({auth:1,saved_item_ids:'101,999'})
    return json({auth:1})
  }
}

function feedRecord(id:string,accountId:number,groupId:string,url:string){const now=1_786_000_000_000;return{id,accountId,groupId,name:id,url,sourcePageUrl:url,sourceType:'rss' as const,icon:null,isNotification:false,isFullContent:false,isBrowser:false,dynamicRendering:false,createdAt:now,updatedAt:now}}
function json(value:unknown):Response{return new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}})}
