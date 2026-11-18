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

  it.each(['google_reader', 'fresh_rss'] as const)('preserves the renamed default group after %s sync without sending a rename request', async (type) => {
    const fixture = createFixture()
    const account = fixture.accounts.add({ type, serverUrl: 'https://reader.example/', username: 'u', password: 'p' })
    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, googleFixtureFetch())
    await service.sync(account.id)
    const group = fixture.library.getDefaultGroupForAccount(account.id)!
    const noNetworkService = new RemoteAccountSyncService(fixture.accounts, fixture.library, async () => { throw new Error('unexpected network request during local rename') })
    await expect(noNetworkService.renameGroup(group.id, ' Personal ')).resolves.toMatchObject({ id: group.id, name: 'Personal', isDefault: true })
    await service.sync(account.id)
    expect(fixture.library.getDefaultGroupForAccount(account.id)).toMatchObject({ id: group.id, name: 'Personal', isDefault: true })
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
    await service.renameGroup(defaultGroup!.id, 'Personal')
    await service.sync(account.id)
    expect(fixture.library.getDefaultGroupForAccount(account.id)).toMatchObject({ id: defaultGroup!.id, name: 'Personal', isDefault: true })
    expect(fixture.library.getFeedByIdForAccount(account.id, feed!.id)?.groupId).toBe(defaultGroup!.id)
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

  it('reuses inflight sync for the same account, isolates different accounts, and releases on failure', async () => {
    const fixture = createFixture()
    const account1 = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://rss1.example', username: 'u1', password: 'p1' })
    const account2 = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://rss2.example', username: 'u2', password: 'p2' })

    let account1FetchCount = 0
    let account2FetchCount = 0
    let deferredResolve: (() => void) | null = null
    const gatePromise = new Promise<void>((resolve) => { deferredResolve = resolve })

    const customFetch: AccountFetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('rss1.example')) {
        account1FetchCount++
        await gatePromise
      } else if (url.includes('rss2.example')) {
        account2FetchCount++
      }
      if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
      if (url.includes('/subscription/list')) return json({ subscriptions: [] })
      if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
      return new Response('missing', { status: 404 })
    }

    const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)

    // 同账号并发调用：复用同一 inflight 任务
    const sync1PromiseA = service.sync(account1.id)
    const sync1PromiseB = service.sync(account1.id)
    // 不同账号调用：独立执行不阻塞
    const sync2Promise = service.sync(account2.id)

    await sync2Promise
    expect(account2FetchCount).toBeGreaterThan(0)
    // 此时 account1 仍在 gate 拦截中，ClientLogin 只调用了一次
    expect(account1FetchCount).toBe(1)

    // 释放 gate，两个 sync1 同时完成
    deferredResolve!()
    await Promise.all([sync1PromiseA, sync1PromiseB])
    // account1 仍然只发起了一套网络请求（共 7 次包含 ClientLogin、subscriptions、stream ids 与 tags），未发生重复同步
    expect(account1FetchCount).toBe(7)

    // 验证失败释放：当请求抛错时，finally 清理 inflight，后续调用能够重试
    let shouldFail = true
    const failingFetch: AccountFetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (shouldFail) throw new Error('network down')
      if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
      if (url.includes('/subscription/list')) return json({ subscriptions: [] })
      if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
      return new Response('missing', { status: 404 })
    }
    const failService = new RemoteAccountSyncService(fixture.accounts, fixture.library, failingFetch)

    await expect(failService.sync(account1.id)).rejects.toThrow('network down')

    // 失败后应已从 inflightSyncs 移除，再次调用会执行新的请求而不是直接返回旧 rejection
    shouldFail = false
    await expect(failService.sync(account1.id)).resolves.toBeUndefined()

    fixture.database.close()
  })

  describe('renameGroup', () => {
    it('rejects renaming group for Fever accounts or invalid group arguments', async () => {
      const fixture = createFixture()
      const feverAccount = fixture.accounts.add({ type: 'fever', serverUrl: 'https://fever.example', username: 'u', password: 'p' })
      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, feverFixtureFetch())

      const feverGroup = { id: remoteDbId(feverAccount.id, '5'), accountId: feverAccount.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(feverGroup)

      await expect(service.renameGroup(feverGroup.id, 'NewTech')).rejects.toThrow('Fever 账户不支持在客户端重命名分组')

      const readerAccount = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://reader.example', username: 'u', password: 'p' })
      const defaultGroup = { id: remoteDbId(readerAccount.id, 'default'), accountId: readerAccount.id, name: 'Default', sortOrder: 0, isDefault: true }
      const group1 = { id: remoteDbId(readerAccount.id, 'user/-/label/Tech'), accountId: readerAccount.id, name: 'Tech', sortOrder: 1, isDefault: false }
      const group2 = { id: remoteDbId(readerAccount.id, 'user/-/label/News'), accountId: readerAccount.id, name: 'News', sortOrder: 2, isDefault: false }
      fixture.library.upsertGroup(defaultGroup)
      fixture.library.upsertGroup(group1)
      fixture.library.upsertGroup(group2)

      const noopFetch: AccountFetch = async () => { throw new Error('should not fetch') }
      const readerService = new RemoteAccountSyncService(fixture.accounts, fixture.library, noopFetch)

      await expect(readerService.renameGroup(defaultGroup.id, 'NewDefault')).resolves.toMatchObject({ id: defaultGroup.id, name: 'NewDefault', isDefault: true })
      expect(fixture.library.getDefaultGroupForAccount(readerAccount.id)?.name).toBe('NewDefault')
      await expect(readerService.renameGroup(group1.id, '')).rejects.toThrow('分组名称不能为空')
      await expect(readerService.renameGroup(group1.id, '   ')).rejects.toThrow('分组名称不能为空')
      await expect(readerService.renameGroup(group1.id, 'x'.repeat(201))).rejects.toThrow('分组名称不能超过 200 个字符')
      await expect(readerService.renameGroup('non-existent', 'NewName')).rejects.toThrow('分组不存在')
      await expect(readerService.renameGroup(group1.id, 'News')).rejects.toThrow('分组名称已存在')

      // 相同名称直接返回原记录，不发远端请求
      const unchanged = await readerService.renameGroup(group1.id, ' Tech ')
      expect(unchanged).toEqual({ ...group1, parentId: null })

      fixture.database.close()
    })

    it('sends rename-tag protocol request and updates canonical group with new ID and feed mapping', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      const feedId = remoteDbId(account.id, 'feed-1')
      fixture.library.upsertFeed(feedRecord(feedId, account.id, oldGroupId, 'https://example.com/rss'))

      let renameTagCalled = false
      let renameTagBody = ''
      const customFetch: AccountFetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) {
          renameTagCalled = true
          renameTagBody = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '')
          return new Response('OK', { status: 200 })
        }
        if (url.includes('/subscription/list')) {
          return json({
            subscriptions: [
              {
                id: 'feed/feed-1',
                title: 'feed-1',
                url: 'https://example.com/rss',
                categories: [{ id: 'user/1000/label/Technology', label: 'Technology' }]
              }
            ]
          })
        }
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      const renamed = await service.renameGroup(oldGroupId, ' Technology ')

      expect(renameTagCalled).toBe(true)
      const params = new URLSearchParams(renameTagBody)
      expect(params.get('s')).toBe('user/-/label/Tech')
      expect(params.get('dest')).toBe('user/-/label/Technology')
      expect(params.get('T')).toBe('action-token')

      // 返回服务端权威重构的 canonical 新组，ID 随服务端规范变化
      expect(renamed.name).toBe('Technology')
      expect(renamed.id).toBe(remoteDbId(account.id, 'user/-/label/Technology'))
      expect(renamed.id).not.toBe(oldGroupId)

      // 来源 feed 关联自动迁移到权威新组
      const updatedFeed = fixture.library.getFeedByIdForAccount(account.id, feedId)
      expect(updatedFeed?.groupId).toBe(renamed.id)

      // 旧组被清理
      const remainingGroups = fixture.library.listGroupsForAccount(account.id)
      expect(remainingGroups.some(g => g.id === oldGroupId)).toBe(false)
      expect(remainingGroups.some(g => g.id === renamed.id)).toBe(true)

      fixture.database.close()
    })

    it('does not mutate local state when remote rename-tag API fails', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'google_reader', serverUrl: 'https://reader.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) {
          return new Response('Remote internal error', { status: 500 })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await expect(service.renameGroup(oldGroupId, 'Technology')).rejects.toThrow('Remote internal error')

      // 本地状态未被篡改
      const localGroups = fixture.library.listGroupsForAccount(account.id)
      expect(localGroups.find(g => g.id === oldGroupId)?.name).toBe('Tech')
      expect(localGroups.some(g => g.name === 'Technology')).toBe(false)

      fixture.database.close()
    })

    it('throws clear error and avoids false success when remote rename succeeds but subsequent sync fails', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      let renameCalled = false
      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) {
          renameCalled = true
          return new Response('OK', { status: 200 })
        }
        if (url.includes('/subscription/list')) {
          return new Response('Catalog fetch timeout', { status: 504 })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await expect(service.renameGroup(oldGroupId, 'Technology')).rejects.toThrow('分组重命名远端已成功，但后续同步失败：Catalog fetch timeout')
      expect(renameCalled).toBe(true)

      // 避免假成功：本地分组未更名
      const localGroups = fixture.library.listGroupsForAccount(account.id)
      expect(localGroups.find(g => g.id === oldGroupId)?.name).toBe('Tech')
      expect(localGroups.some(g => g.name === 'Technology')).toBe(false)

      fixture.database.close()
    })

    it('refuses to fabricate group when sync succeeds without target group and tag/list lacks target label', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      let tagListCalled = false
      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) return new Response('OK', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) {
          tagListCalled = true
          return json({ tags: [{ id: 'user/1000/state/com.google/reading-list' }, { id: 'user/1000/label/Other' }] })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await expect(service.renameGroup(oldGroupId, 'Technology')).rejects.toThrow(/远端已响应成功但无法确认最新分组|分组重命名远端已成功，但后续同步失败/)
      expect(tagListCalled).toBe(true)

      // 验证未猜测创建任何 Technology 分组
      const localGroups = fixture.library.listGroupsForAccount(account.id)
      expect(localGroups.some(g => g.name === 'Technology')).toBe(false)
      expect(localGroups.some(g => g.id.includes('Technology'))).toBe(false)

      fixture.database.close()
    })

    it('confirms empty group using authentic canonical label ID returned by tag/list', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 3, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      let tagListCalled = false
      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) return new Response('OK', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) {
          tagListCalled = true
          return json({
            tags: [
              { id: 'user/1000/state/com.google/reading-list' },
              { id: 'user/98765/label/Technology' }
            ]
          })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      const renamed = await service.renameGroup(oldGroupId, 'Technology')

      expect(tagListCalled).toBe(true)
      // 必须使用服务端真实返回的 canonical ID 规则映射
      expect(renamed.id).toBe(remoteDbId(account.id, 'user/-/label/Technology'))
      expect(renamed.id).not.toBe(oldGroupId)
      expect(renamed.name).toBe('Technology')
      expect(renamed.sortOrder).toBe(3)
      expect(renamed.isDefault).toBe(false)

      // 空组成功持久化到本地，且旧组被清理
      const localGroups = fixture.library.listGroupsForAccount(account.id)
      expect(localGroups.some(g => g.id === oldGroupId)).toBe(false)
      expect(localGroups.find(g => g.id === renamed.id)?.name).toBe('Technology')

      fixture.database.close()
    })

    it('throws clear error when tag/list request fails for empty group confirmation', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) return new Response('OK', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) return new Response('Server Error', { status: 500 })
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await expect(service.renameGroup(oldGroupId, 'Technology')).rejects.toThrow(/远端已响应成功但无法确认最新分组|分组重命名远端已成功，但后续同步失败/)

      const localGroups = fixture.library.listGroupsForAccount(account.id)
      expect(localGroups.some(g => g.name === 'Technology')).toBe(false)

      fixture.database.close()
    })

    it('waits for prior inflight sync before mutation and executes a fresh sync afterwards', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      const executionOrder: string[] = []
      let resolveInitialSync!: () => void
      const initialSyncGate = new Promise<void>((r) => { resolveInitialSync = r })

      let syncCallCount = 0
      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) {
          syncCallCount++
          if (syncCallCount === 1) {
            executionOrder.push('sync-1-start')
            await initialSyncGate
            executionOrder.push('sync-1-end')
            return json({ subscriptions: [{ id: 'feed/feed-1', title: 'Feed 1', url: 'https://example.com/rss', categories: [{ id: 'user/-/label/Tech', label: 'Tech' }] }] })
          } else {
            executionOrder.push('sync-2-start')
            executionOrder.push('sync-2-end')
            return json({ subscriptions: [{ id: 'feed/feed-1', title: 'Feed 1', url: 'https://example.com/rss', categories: [{ id: 'user/-/label/Technology', label: 'Technology' }] }] })
          }
        }
        if (url.includes('/reader/api/0/rename-tag')) {
          executionOrder.push('rename-tag')
          return new Response('OK', { status: 200 })
        }
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)

      // 1. 发起初始 sync 并在 gate 中挂起
      const initialSyncPromise = service.sync(account.id)
      await new Promise((r) => setTimeout(r, 10))
      expect(executionOrder).toEqual(['sync-1-start'])

      // 2. 发起 renameGroup：此时旧 sync 仍在进行，rename-tag 必须等待旧 sync 结束后方可调用
      const renamePromise = service.renameGroup(oldGroupId, 'Technology')
      await new Promise((r) => setTimeout(r, 10))
      expect(executionOrder).toEqual(['sync-1-start'])

      // 3. 释放旧 sync
      resolveInitialSync()
      await initialSyncPromise
      const renamed = await renamePromise

      // 4. 验证严格顺序：旧 sync 完结 -> rename-tag 变更 -> 新 sync 权威拉取
      expect(executionOrder).toEqual([
        'sync-1-start',
        'sync-1-end',
        'rename-tag',
        'sync-2-start',
        'sync-2-end'
      ])
      expect(renamed.name).toBe('Technology')

      fixture.database.close()
    })

    it('isolates accounts during rename and prevents cross-account mutation', async () => {
      const fixture = createFixture()
      const account1 = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://rss1.example', username: 'u1', password: 'p1' })
      const account2 = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://rss2.example', username: 'u2', password: 'p2' })

      const group1 = { id: remoteDbId(account1.id, 'user/-/label/Shared'), accountId: account1.id, name: 'Shared', sortOrder: 0, isDefault: false }
      const group2 = { id: remoteDbId(account2.id, 'user/-/label/Shared'), accountId: account2.id, name: 'Shared', sortOrder: 0, isDefault: false }
      fixture.library.upsertGroup(group1)
      fixture.library.upsertGroup(group2)

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, async (input) => {
        const url = String(input)
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action', { status: 200 })
        if (url.includes('/rename-tag')) return new Response('OK', { status: 200 })
        if (url.includes('/subscription/list')) {
          return json({ subscriptions: [{ id: 'feed/f2', title: 'F2', url: 'https://f2.example', categories: [{ id: 'user/-/label/Renamed', label: 'Renamed' }] }] })
        }
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        return new Response('missing', { status: 404 })
      })

      // 当前账户为 account2（最后添加的账户）
      expect(fixture.accounts.currentId()).toBe(account2.id)

      // 尝试重命名 account1 的组：报错分组不存在
      await expect(service.renameGroup(group1.id, 'Renamed')).rejects.toThrow('分组不存在')

      // 重命名 account2 的组：成功，不影响 account1
      const renamed2 = await service.renameGroup(group2.id, 'Renamed')
      expect(renamed2.accountId).toBe(account2.id)
      expect(renamed2.name).toBe('Renamed')

      // account1 的组未受影响
      const acc1Groups = fixture.library.listGroupsForAccount(account1.id)
      expect(acc1Groups.find(g => g.id === group1.id)?.name).toBe('Shared')

      fixture.database.close()
    })
  })

  describe('remote catalog sync with tag/list (B1c)', () => {
    it('preserves empty group after subsequent syncs when confirmed by tag/list', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const oldGroupId = remoteDbId(account.id, 'user/-/label/Tech')
      const oldGroup = { id: oldGroupId, accountId: account.id, name: 'Tech', sortOrder: 3, isDefault: false }
      fixture.library.upsertGroup(oldGroup)

      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/reader/api/0/rename-tag')) return new Response('OK', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) {
          return json({
            tags: [
              { id: 'user/1000/state/com.google/reading-list' },
              { id: 'user/1000/label/Technology' }
            ]
          })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      const renamed = await service.renameGroup(oldGroupId, 'Technology')

      expect(renamed.name).toBe('Technology')
      expect(renamed.id).toBe(remoteDbId(account.id, 'user/-/label/Technology'))
      expect(renamed.sortOrder).toBe(3)

      // 关键验证：后续定期或手动 sync 触发后，空组仍然保留在本地数据库中，不会被清理
      await service.sync(account.id)

      const groupsAfterSync = fixture.library.listGroupsForAccount(account.id)
      const preservedGroup = groupsAfterSync.find(g => g.name === 'Technology')
      expect(preservedGroup).toBeDefined()
      expect(preservedGroup?.id).toBe(remoteDbId(account.id, 'user/-/label/Technology'))
      expect(preservedGroup?.sortOrder).toBe(3)
      expect(groupsAfterSync.some(g => g.id === oldGroupId)).toBe(false)

      fixture.database.close()
    })

    it('cleans up local group when tag is deleted on server and has no subscriptions', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })
      const emptyGroupId = remoteDbId(account.id, 'user/-/label/DeletedOnServer')
      fixture.library.upsertGroup({ id: emptyGroupId, accountId: account.id, name: 'DeletedOnServer', sortOrder: 0, isDefault: false })

      // 服务端 tag/list 不再包含 DeletedOnServer（用户在远端已删除该标签），且订阅列表也无此分组
      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) {
          return json({
            tags: [
              { id: 'user/1000/state/com.google/reading-list' },
              { id: 'user/1000/label/ActiveTag' }
            ]
          })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await service.sync(account.id)

      const groups = fixture.library.listGroupsForAccount(account.id)
      expect(groups.some(g => g.id === emptyGroupId)).toBe(false)
      expect(groups.some(g => g.name === 'ActiveTag')).toBe(true)

      fixture.database.close()
    })

    it('gracefully falls back when service does not implement tag/list (404/501) but throws on auth/server failure', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })

      // 1. 旧服务 404: 同步不失败，基于 subscription.categories 完成目录同步
      const fetch404: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) {
          return json({
            subscriptions: [
              { id: 'feed/f1', title: 'Feed 1', url: 'https://example.com/f1.xml', categories: [{ id: 'user/-/label/News', label: 'News' }] }
            ]
          })
        }
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) return new Response('Not Implemented', { status: 404 })
        return new Response('missing', { status: 404 })
      }

      const service404 = new RemoteAccountSyncService(fixture.accounts, fixture.library, fetch404)
      await expect(service404.sync(account.id)).resolves.toBeUndefined()

      const groups404 = fixture.library.listGroupsForAccount(account.id)
      expect(groups404.some(g => g.name === 'News')).toBe(true)
      expect(fixture.accounts.get(account.id)?.updatedAt).toBeGreaterThan(0)

      // 2. 旧服务 501: 同步不失败，同样优雅降级
      const fetch501: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) return new Response('Not Implemented', { status: 501 })
        return new Response('missing', { status: 404 })
      }
      const service501 = new RemoteAccountSyncService(fixture.accounts, fixture.library, fetch501)
      await expect(service501.sync(account.id)).resolves.toBeUndefined()

      // 3. 避免吞掉 500 或 401 故障伪装成完整目录：必须明确抛错
      const fetch500: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) return new Response('Database Down', { status: 500 })
        return new Response('missing', { status: 404 })
      }
      const service500 = new RemoteAccountSyncService(fixture.accounts, fixture.library, fetch500)
      await expect(service500.sync(account.id)).rejects.toThrow('Database Down')

      fixture.database.close()
    })

    it('maps authentic namespace IDs, filters state tags, and preserves slashes in label names', async () => {
      const fixture = createFixture()
      const account = fixture.accounts.add({ type: 'fresh_rss', serverUrl: 'https://fresh.example', username: 'u', password: 'p' })

      const customFetch: AccountFetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/accounts/ClientLogin')) return json({ Auth: 'token' })
        if (url.endsWith('/reader/api/0/token')) return new Response('action-token', { status: 200 })
        if (url.includes('/subscription/list')) return json({ subscriptions: [] })
        if (url.includes('/stream/items/ids')) return json({ itemRefs: [] })
        if (url.includes('/reader/api/0/tag/list')) {
          return json({
            tags: [
              // 系统/状态标签：必须过滤
              { id: 'user/987654321/state/com.google/reading-list' },
              { id: 'user/987654321/state/com.google/starred' },
              { id: 'user/987654321/state/com.google/read' },
              { id: 'user/-/state/com.google/broadcast' },
              // 真实用户标签（带真实数字 ID）
              { id: 'user/987654321/label/Engineering' },
              // 带斜杠的真实用户标签：远端保持平面语义，不得拆分
              { id: 'user/987654321/label/Tech/Backend/Node' }
            ]
          })
        }
        return new Response('missing', { status: 404 })
      }

      const service = new RemoteAccountSyncService(fixture.accounts, fixture.library, customFetch)
      await service.sync(account.id)

      const groups = fixture.library.listGroupsForAccount(account.id)
      // 验证未包含任何系统状态标签
      expect(groups.some(g => g.name.includes('reading-list') || g.name.includes('starred') || g.name.includes('broadcast'))).toBe(false)

      // 验证真实命名空间 ID 与名称映射
      const engGroup = groups.find(g => g.name === 'Engineering')
      expect(engGroup).toBeDefined()
      expect(engGroup?.id).toBe(remoteDbId(account.id, 'user/-/label/Engineering'))
      expect(engGroup?.accountId).toBe(account.id)

      // 验证不拆分名称中的斜杠
      const slashGroup = groups.find(g => g.name === 'Tech/Backend/Node')
      expect(slashGroup).toBeDefined()
      expect(slashGroup?.id).toBe(remoteDbId(account.id, 'user/-/label/Tech/Backend/Node'))
      expect(slashGroup?.accountId).toBe(account.id)

      fixture.database.close()
    })
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
