import { createConfigurationBackupFixture } from '../../../tests/helpers/configuration-backup-test-support'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_ID } from '../database/migrations'

import { encryptConfigurationSecrets } from './configuration-backup-crypto'
import type { ConfigurationBackup } from '../../shared/configuration-backup'

import { mcpOAuthSecretKey } from '../mcp/mcp-remote-repository'
import { ConfigurationBackupService } from './configuration-backup-service'
import { AccountRepository } from '../accounts/account-repository'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('ConfigurationBackupService Android v1 compatibility', () => {
  it('keeps incomplete MCP drafts in the Desktop section without invalid Android endpoints or orphan secrets', async () => {
    const fixture=createFixture()
    try {
      const draft=fixture.mcpRemote.addServer().servers[0]!
      fixture.mcpRemote.updateServer({id:draft.id,authMode:'BEARER',credential:'draft-secret'})
      const backup=JSON.parse(await fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
      expect(backup.mcp?.remote.servers).toMatchObject([{id:draft.id,url:'',enabled:false}])
      expect(backup.editionConfiguration).toMatchObject({mcpServers:[]})
      expect(readEncryptedSecrets(backup,'backup-pass')).toMatchObject({mcpRemoteCredentials:{[draft.id]:'draft-secret'},editionSecrets:{mcpServers:{}}})
      expect(()=>fixture.backup.inspect(JSON.stringify(backup))).not.toThrow()
      fixture.mcpRemote.removeServer(draft.id)
      await fixture.backup.restoreBackup(JSON.stringify(backup),'backup-pass')
      expect(fixture.mcpRemote.getCredential(draft.id)).toBe('draft-secret')
      await expect(fixture.backup.exportBackup()).resolves.toEqual(expect.any(String))
    } finally {fixture.database.close()}
  })

  it('exports OAuth lifetimes that remain within Android Long range when Desktop tokens omit an expiry', async () => {
    const fixture=createFixture()
    try {
      const server=fixture.mcpRemote.addServer().servers[0]!
      fixture.mcpRemote.updateServer({id:server.id,url:'https://mcp.example/mcp',authMode:'OAUTH'})
      fixture.secrets.put(mcpOAuthSecretKey(server.id,'tokens'),JSON.stringify({issuer:'https://auth.example',value:{access_token:'token'}}))
      const backup=JSON.parse(await fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
      const edition=readEncryptedSecrets(backup,'backup-pass').editionSecrets as {mcpServers:Record<string,{oauthTokenSet:{expiresAtEpochMs:number}}>}
      expect(edition.mcpServers[server.id]!.oauthTokenSet.expiresAtEpochMs).toBe(Number.MAX_SAFE_INTEGER)
    } finally {fixture.database.close()}
  })

  it('keeps slash-containing flat names intact, including legacy backups without hierarchy metadata', async () => {
    const fixture=createFixture()
    try {
      fixture.library.upsertGroup({id:'slash-group',name:'News/Daily',parentId:null,isDefault:false,sortOrder:2})
      const backup=JSON.parse(await fixture.backup.exportBackup()) as ConfigurationBackup
      expect(backup.subscriptions.groups.find(group=>group.id==='slash-group')?.name).toBe('News/Daily')
      delete backup.desktopGroupHierarchy
      fixture.database.connection.prepare('DELETE FROM groups WHERE id=?').run('slash-group')
      await fixture.backup.restoreBackup(JSON.stringify(backup))
      expect(fixture.library.listGroups().map(group=>group.name)).toContain('News/Daily')
    } finally {fixture.database.close()}
  })

  it('isolates account filters on export and restore and rolls back all four files byte-for-byte', async () => {
    const fixture=createFixture()
    try {
      const accounts=new AccountRepository(fixture.database.connection,fixture.secrets)
      const currentFeed=fixture.library.listFeeds()[0]!
      const other=accounts.add({type:'local',name:'Other'})
      fixture.library.upsertFeed({...currentFeed,id:'other-feed',accountId:other.id,groupId:fixture.library.getCurrentDefaultGroup().id})
      fixture.filters.add('Other account','KEYWORD','other-feed')
      fixture.websitePreferences.setPreferredRule('other-feed','other-rule')
      accounts.switchTo(1)
      fixture.filters.add('Current account','KEYWORD',currentFeed.id)
      fixture.filters.add('Old global')
      const otherRules=fixture.filters.getByFeed('other-feed')
      const exported=JSON.parse(await fixture.backup.exportBackup()) as ConfigurationBackup
      expect((exported.articleFilters as {rules:Array<{feedId:string|null}>}).rules.map(rule=>rule.feedId)).not.toContain('other-feed')
      const incoming=await androidBackup(fixture)
      incoming.encryptedSecrets=null
      await fixture.backup.restoreBackup(JSON.stringify(incoming))
      expect(fixture.filters.getByFeed('other-feed')).toEqual(otherRules)
      expect(fixture.filters.getByFeed(currentFeed.id)).toEqual([])
      expect(fixture.database.connection.prepare('SELECT id FROM feeds WHERE account_id=?').all(other.id)).toEqual([{id:'other-feed'}])

      // Keep formatting, unknown fields, disabled built-ins and cross-account entries in the snapshot.
      fixture.websiteRules.setEnabled(fixture.websiteRules.listRules()[0]!.id,false)
      fixture.jsonRules.importRules(fixture.jsonRules.exportTemplate())
      fixture.websitePreferences.setPreferredRule(currentFeed.id,'baseline-rule')
      const files=['website-rules.json','json-rules.json','filters.json','website-preferences.json'].map(name=>join(fixture.dir,name))
      for(const file of files){
        const raw=' \n'+readFileSync(file,'utf8')+'\n '
        if(file===join(fixture.dir,'filters.json'))fixture.filters.restoreRawState(raw)
        else writeFileSync(file,raw)
      }
      const before=files.map(file=>readFileSync(file,'utf8'))
      const target=JSON.parse(await fixture.backup.exportBackup()) as ConfigurationBackup
      target.subscriptions.feeds.push({...target.subscriptions.feeds[0]!,id:'temporary-feed',url:'https://rollback.example/new.xml'})
      target.websiteParsePreferences={items:[{feedId:'temporary-feed',preferredRuleId:'new-rule'}]}
      const original=fixture.customization.update
      fixture.customization.update=()=>{throw new Error('late failure')}
      try {await expect(fixture.backup.restoreBackup(JSON.stringify(target))).rejects.toThrow('late failure')}
      finally {fixture.customization.update=original}
      expect(files.map(file=>readFileSync(file,'utf8'))).toEqual(before)
      expect(fixture.filters.getByFeed('other-feed')).toEqual(otherRules)
      expect(fixture.websitePreferences.exportRawState()).not.toContain('temporary-feed')
      expect(fixture.library.findFeedByUrl('https://rollback.example/new.xml')).toBeNull()
      expect(fixture.websiteRules.listRules().find(rule=>rule.id===fixture.websiteRules.listRules()[0]!.id)?.enabled).toBe(false)
    } finally {fixture.database.close()}
  })

  it('removes newly created state files on rollback when all four files were originally absent', async () => {
    const fixture=createFixture()
    try {
      const backup=await fixture.backup.exportBackup()
      const repositories=[fixture.websiteRules,fixture.jsonRules,fixture.filters,fixture.websitePreferences]
      expect(repositories.map(repo=>repo.exportRawState())).toEqual([null,null,null,null])
      fixture.customization.update=()=>{throw new Error('late failure')}
      await expect(fixture.backup.restoreBackup(backup)).rejects.toThrow('late failure')
      expect(repositories.map(repo=>repo.exportRawState())).toEqual([null,null,null,null])
      for(const name of ['website-rules.json','json-rules.json','filters.json','website-preferences.json'])expect(existsSync(join(fixture.dir,name))).toBe(false)
    } finally {fixture.database.close()}
  })

  it('updates only matched remote feed preferences without creating groups or rewriting remote identities', async () => {
    const fixture=createFixture()
    try {
      const incoming=await androidBackup(fixture)
      incoming.encryptedSecrets=null
      const accounts=new AccountRepository(fixture.database.connection,fixture.secrets)
      const account=accounts.add({type:'fresh_rss',name:'Remote',serverUrl:'https://reader.example',username:'u',password:'p'})
      // Remote accounts need not have a default group.
      fixture.database.connection.prepare('INSERT INTO groups (id,account_id,name,sort_order,is_default) VALUES (?,?,?,?,0)').run('remote/category',account.id,'Remote category',1)
      fixture.library.upsertFeed({id:'remote/42',groupId:'remote/category',name:'Server title',url:'https://EXAMPLE.com:443/feed.xml?utm_source=remote',sourcePageUrl:'https://example.com/',sourceType:'rss',icon:null,isNotification:false,isFullContent:false,isBrowser:false,dynamicRendering:false,createdAt:10,updatedAt:10})
      incoming.subscriptions.feeds[0]!.sourceType='WEBSITE'
      incoming.subscriptions.feeds[0]!.isFullContent=true
      incoming.subscriptions.feeds[0]!.isBrowser=true
      const service=new ConfigurationBackupService('test',fixture.library,fixture.settings,fixture.websiteRules,fixture.jsonRules,fixture.filters,fixture.websitePreferences,fixture.rssHub,fixture.translation,fixture.ai,accounts,fixture.skills,fixture.quickMessages,fixture.customization,fixture.webSearch,fixture.mcpRemote,fixture.mcpLocal,fixture.database.connection,fixture.secrets)
      const before=fixture.library.listFeeds()[0]!
      const groups=fixture.library.listGroups()
      const result=await service.restoreBackup(JSON.stringify(incoming))
      expect(result).toMatchObject({groupsAdded:0,feedsAdded:0,feedsUpdated:1})
      expect(fixture.library.listGroups()).toEqual(groups)
      expect(fixture.library.listFeeds()).toHaveLength(1)
      expect(fixture.library.listFeeds()[0]).toMatchObject({...before,isNotification:true,isFullContent:true,isBrowser:true,updatedAt:expect.any(Number)})
      expect(fixture.filters.getByFeed('remote/42').map(rule=>rule.keyword)).toContain('Sponsored')
      expect(await service.restoreBackup(JSON.stringify(incoming))).toMatchObject({groupsAdded:0,feedsAdded:0,feedsUpdated:1})
    } finally {fixture.database.close()}
  })

  it('restores Android edition-only settings, search keys, MCP OAuth, Skills and Quick Messages and exports the Android contract', async () => {
    const fixture=createFixture()
    try {
      await fixture.skills.createFromMarkdown('---\nname: android-skill\ndescription: Android skill\n---\nCheck evidence.')
      fixture.skills.setBinding('SUMMARY','android-skill')
      fixture.quickMessages.create('Android message','Check {{article_title}}')
      const desktop=JSON.parse(await fixture.backup.exportBackup()) as ConfigurationBackup
      const state=desktop.editionConfiguration as {skillState:string;quickMessageState:string}
      expect(JSON.parse(state.skillState).bindings.summary).toBe('android-skill')
      const incoming=await androidBackup(fixture)
      incoming.editionConfiguration={schemaVersion:2,settings:{skillsEnabled:false,customInstructions:'Android instructions',webSearchEnabled:true,webSearchMode:'FORCE',contextMaxTokens:128000,reasoningEffort:'HIGH',continueGenerationInBackground:false,showReasoning:false},webSearch:{providers:[{id:'android-search',kind:'TAVILY',name:'Android search',endpoint:'https://api.tavily.com/search',enabled:true}],defaultProviderId:'android-search',maxResults:20},mcpServers:[{id:'android-oauth',name:'Android OAuth',endpoint:'https://mcp.example/mcp',enabled:true,authType:'OAUTH'},{id:'android-header',name:'Android headers',endpoint:'https://mcp.example/headers',enabled:true,authType:'CUSTOM_HEADERS'}],skillState:state.skillState,quickMessageState:state.quickMessageState}
      incoming.encryptedSecrets=await encryptConfigurationSecrets({translationApiKeys:{},aiApiKeys:{},editionSecrets:{webSearchApiKeys:{'android-search':'search-key'},mcpServers:{'android-oauth':{oauthRegistration:{issuer:'https://auth.example',clientId:'android-client',authMethod:'NONE'},oauthTokenSet:{issuer:'https://auth.example',accessToken:'android-token',refreshToken:'android-refresh',tokenType:'Bearer',expiresAtEpochMs:1900000000000},oauthPendingScopes:['tools.read'],discovery:{authorizationServerUrl:'http://169.254.169.254/'}},'android-header':{customHeaders:{'X-Api-Key':'header-secret'}}}}},'backup-pass')
      fixture.skills.delete('android-skill')
      fixture.quickMessages.delete(fixture.quickMessages.current().find(message=>message.title==='Android message')!.id)
      expect(()=>fixture.backup.inspect(JSON.stringify(incoming))).not.toThrow()
      await fixture.backup.restoreBackup(JSON.stringify(incoming),'backup-pass')
      expect(fixture.customization.current()).toEqual({skillsEnabled:false,customInstructions:'Android instructions'})
      expect(fixture.webSearch.current()).toMatchObject({mode:'AUTO',maxResults:20,defaultProviderId:'android-search'})
      expect(fixture.webSearch.getApiKey('android-search')).toBe('search-key')
      expect(fixture.skills.current().bindings.summarySkillId).toBe('android-skill')
      expect(fixture.quickMessages.current().some(message=>message.title==='Android message')).toBe(true)
      expect(fixture.mcpRemote.current().servers[0]).toMatchObject({id:'android-oauth',authMode:'OAUTH',oauthScopes:'tools.read',oauthAuthorized:true})
      expect(JSON.parse(fixture.secrets.get(mcpOAuthSecretKey('android-oauth','tokens')))).toMatchObject({issuer:'https://auth.example',value:{access_token:'android-token'}})
      expect(fixture.secrets.get(mcpOAuthSecretKey('android-oauth','discovery'))).toBe('')
      expect(fixture.mcpRemote.getCredential('android-header')).toBe('X-Api-Key: header-secret')
      const exported=JSON.parse(await fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
      expect(exported.llm).toBeDefined();expect(exported.webSearch).toBeDefined();expect(exported.mcp).toBeDefined()
      const edition=exported.editionConfiguration as {settings:unknown;mcpServers:unknown[];skillState:string;quickMessageState:string}
      expect(edition.settings).toMatchObject({skillsEnabled:false,customInstructions:'Android instructions',webSearchEnabled:true,reasoningEffort:'HIGH',continueGenerationInBackground:false,showReasoning:false})
      expect(edition.mcpServers).toContainEqual({id:'android-header',name:'Android headers',endpoint:'https://mcp.example/headers',enabled:true,authType:'CUSTOM_HEADERS'})
      const secrets=readEncryptedSecrets(exported,'backup-pass').editionSecrets as {mcpServers:Record<string,unknown>;webSearchApiKeys:unknown}
      expect(secrets.webSearchApiKeys).toEqual({'android-search':'search-key'})
      expect(secrets.mcpServers['android-oauth']).toMatchObject({oauthRegistration:{clientId:'android-client'},oauthTokenSet:{accessToken:'android-token',expiresAtEpochMs:1900000000000},oauthPendingScopes:['tools.read']})
      expect(secrets.mcpServers['android-header']).toEqual({customHeaders:{'X-Api-Key':'header-secret'}})
      expect(JSON.stringify(secrets)).not.toContain('discovery')
      expect(JSON.stringify(exported)).not.toContain('android-token')
      // A second Desktop import of just the Android extension proves both conversion directions.
      delete exported.llm;delete exported.webSearch;delete exported.mcp
      exported.encryptedSecrets=await encryptConfigurationSecrets({translationApiKeys:{},aiApiKeys:{},editionSecrets:secrets},'backup-pass')
      await fixture.backup.restoreBackup(JSON.stringify(exported),'backup-pass')
      expect(fixture.skills.current().bindings.summarySkillId).toBe('android-skill')
      expect(fixture.mcpRemote.getCredential('android-header')).toBe('X-Api-Key: header-secret')
    } finally {fixture.database.close()}
  })

  it.each([
    {schemaVersion:3},
    {schemaVersion:null},
    {settings:null},
    {settings:{contextMaxTokens:null}},
    {settings:{customInstructions:null}},
    {settings:{contextMaxTokens:4095}},
    {settings:{reasoningEffort:'EXTREME'}},
    {settings:{webSearchMode:'INVALID'}},
    {settings:{skillsEnabled:'false'}},
    {settings:{customInstructions:'x'.repeat(8001)}},
    {webSearch:{maxResults:0}},
    {webSearch:{maxResults:null}},
    {webSearch:{providers:null}},
    {mcpServers:null},
    {webSearch:{maxResults:21}},
    {webSearch:{providers:[{id:'x',kind:'UNKNOWN',name:'Search',endpoint:'https://search.example',enabled:true}]}},
    {webSearch:{providers:[1,2].map(()=>({id:'duplicate',kind:'TAVILY',name:'Search',endpoint:'https://search.example',enabled:true}))}},
    {mcpServers:[1,2].map(()=>({id:'duplicate',name:'MCP',endpoint:'https://mcp.example',enabled:true,authType:'NONE'}))},
    {mcpServers:[{id:'x',name:'MCP',endpoint:'',enabled:true,authType:'NONE'}]},
    {mcpServers:[{id:'x',name:'MCP',endpoint:'https://mcp.example',enabled:true,authType:'INVALID'}]},
    {skillState:'{"version":1,"skills":[],"bindings":{"summary":"missing"}}'},
    {quickMessageState:'{}'},
  ])('rejects malformed Android edition configuration before any writes: %j', async patch => {
    const fixture=createFixture()
    try {
      const backup=await androidBackup(fixture)
      backup.encryptedSecrets=null
      backup.editionConfiguration={schemaVersion:2,settings:{},webSearch:{},mcpServers:[],...patch}
      const before=fixture.library.listFeeds()
      await expect(fixture.backup.restoreBackup(JSON.stringify(backup))).rejects.toThrow()
      expect(fixture.library.listFeeds()).toEqual(before)
      expect(fixture.filters.exportRawState()).toBeNull()
    } finally {fixture.database.close()}
  })

  it.each([
    {oauthTokenSet:{issuer:'',accessToken:'token'}},
    {oauthTokenSet:{issuer:'https://auth.example',accessToken:''}},
    {oauthTokenSet:{issuer:'https://auth.example',accessToken:'token',tokenType:'Basic'}},
    {oauthRegistration:{issuer:'https://auth.example',clientId:''}},
    {oauthRegistration:{issuer:'https://auth.example',clientId:'c',authMethod:'INVALID'}},
  ])('rejects malformed Android OAuth credentials before restoring subscriptions: %j', async credential=>{
    const fixture=createFixture()
    try {
      const backup=await androidBackup(fixture)
      backup.editionConfiguration={schemaVersion:2,mcpServers:[{id:'oauth',name:'OAuth',endpoint:'https://mcp.example',enabled:true,authType:'OAUTH'}]}
      backup.encryptedSecrets=await encryptConfigurationSecrets({translationApiKeys:{},aiApiKeys:{},editionSecrets:{mcpServers:{oauth:credential}}},'backup-pass')
      const before=fixture.library.listFeeds()
      await expect(fixture.backup.restoreBackup(JSON.stringify(backup),'backup-pass')).rejects.toThrow(/OAuth/)
      expect(fixture.library.listFeeds()).toEqual(before)
      expect(fixture.secrets.snapshot()).toEqual({})
    } finally {fixture.database.close()}
  })
  it('merges normalized group names and remaps feeds on repeated restores', async () => {
    const fixture = createFixture()
    const backup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
    delete (backup as { desktopGroupHierarchy?: unknown }).desktopGroupHierarchy
    backup.subscriptions.groups.push(
      { id: 'tech-a', name: ' Tech ', isDefault: false },
      { id: 'tech-b', name: 'Tech', isDefault: false },
      { id: 'default-alias', name: ' Default ', isDefault: false }
    )
    const base = backup.subscriptions.feeds[0]!
    backup.subscriptions.feeds.push(
      { ...base, id: 'a', name: 'A', url: 'https://example.com/a.xml', groupId: 'tech-a' },
      { ...base, id: 'b', name: 'B', url: 'https://example.com/b.xml', groupId: 'tech-b' },
      { ...base, id: 'c', name: 'C', url: 'https://example.com/c.xml', groupId: 'default-alias' }
    )
    expect(await fixture.backup.restoreBackup(JSON.stringify(backup))).toMatchObject({ groupsAdded: 1 })
    expect(fixture.library.listGroups().map(group => group.name)).toEqual(['Default', 'Tech'])
    expect(fixture.library.findFeedByUrl('https://example.com/a.xml')?.groupId)
      .toBe(fixture.library.findFeedByUrl('https://example.com/b.xml')?.groupId)
    expect(fixture.library.findFeedByUrl('https://example.com/c.xml')?.groupId).toBe(DEFAULT_GROUP_ID)
    expect(await fixture.backup.restoreBackup(JSON.stringify(backup))).toMatchObject({ groupsAdded: 0, feedsAdded: 0 })
    fixture.database.close()
  })

  it('restores legacy mappings even when the new descriptor map is empty or partial', async () => {
    const fixture = createFixture()
    const backup = await androidBackup(fixture)
    backup.encryptedSecrets = null
    backup.rssHubSourceUrls = { 'android-existing': 'https://www.cls.cn/', 'android-new': 'https://example.com/new' }
    backup.rssHubSubscriptions = {}
    await fixture.backup.restoreBackup(JSON.stringify(backup))
    const existing = fixture.library.findFeedByUrl('https://example.com/feed.xml')!
    expect(fixture.library.getRssHubSourceUrl(existing.id)).toBe('https://www.cls.cn/')
    backup.rssHubSubscriptions = { 'android-new': { originalInput: 'rsshub://zhihu/hot', routePath: '/zhihu/hot', preferredInstance: null, lastResolvedInstance: null, lastResolvedUrl: null } }
    await fixture.backup.restoreBackup(JSON.stringify(backup))
    expect(fixture.library.getRssHubSourceUrl(existing.id)).toBe('https://www.cls.cn/')
    expect(fixture.library.getRssHubDescriptor(fixture.library.findFeedByUrl('https://new.example/feed.xml')!.id)?.routePath).toBe('/zhihu/hot')
  })

  it.each([
    { 'android-new': null },
    { 'android-new': { originalInput: 42 } },
    { missing: { originalInput: 'rsshub://zhihu/hot' } },
    { 'android-new': { originalInput: 'rsshub://zhihu/hot', routePath: '/foo/../secret' } }
  ])('rejects malformed canonical RSSHub subscriptions before any restore writes: %j', async (descriptors) => {
    const fixture = createFixture()
    const backup = await androidBackup(fixture)
    backup.encryptedSecrets = null
    backup.rssHubSubscriptions = descriptors as any
    const before = await fixture.backup.exportBackup('')
    expect(() => fixture.backup.inspect(JSON.stringify(backup))).toThrow(/RSSHub/)
    await expect(fixture.backup.restoreBackup(JSON.stringify(backup))).rejects.toThrow(/RSSHub/)
    const after = await fixture.backup.exportBackup('')
    expect(JSON.parse(after).subscriptions).toEqual(JSON.parse(before).subscriptions)
  })

  it('merges Android subscriptions, preserves articles, remaps source rules, and restores encrypted credentials', async () => {
    const fixture = createFixture()
    const now = 1_786_700_000_000
    fixture.library.upsertFeed({
      id: 'existing-feed', groupId: DEFAULT_GROUP_ID, name: 'Old Name', url: 'https://example.com/feed.xml',
      sourcePageUrl: 'https://example.com/', sourceType: 'rss', icon: null, isNotification: false,
      isFullContent: false, isBrowser: false, dynamicRendering: false, createdAt: now, updatedAt: now
    })
    fixture.library.upsertFeed({
      id: 'desktop-extra', groupId: DEFAULT_GROUP_ID, name: 'Desktop Extra', url: 'https://extra.example/feed.xml',
      sourcePageUrl: 'https://extra.example/', sourceType: 'rss', icon: null, isNotification: false,
      isFullContent: false, isBrowser: false, dynamicRendering: false, createdAt: now, updatedAt: now
    })
    fixture.library.upsertArticle({
      id: 'kept-article', feedId: 'existing-feed', title: 'Keep me', url: 'https://example.com/article', author: null,
      publishedAt: now, description: 'Existing article', contentHtml: null, fullContentHtml: null, imageUrl: null,
      isUnread: false, isStarred: true, createdAt: now, updatedAt: now
    })
    fixture.settings.update({
      sourcePaneWidth: 310,
      articlePaneWidth: 460,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: true
    })

    const backup = await androidBackup(fixture)
    const result = await fixture.backup.restoreBackup(JSON.stringify(backup), 'backup-pass')

    expect(result).toMatchObject({ groupsAdded: 1, feedsAdded: 1, feedsUpdated: 1, credentialsRestored: true })
    expect(fixture.library.findFeedByUrl('https://example.com/feed.xml')).toMatchObject({ id: 'existing-feed', name: 'Android Updated' })
    const newFeed = fixture.library.findFeedByUrl('https://new.example/feed.xml')
    expect(newFeed).not.toBeNull()
    expect(fixture.library.getFeedById('desktop-extra')).not.toBeNull()
    expect(fixture.library.getArticleById('kept-article')).toMatchObject({ isUnread: false, isStarred: true })
    expect(fixture.filters.getByFeed('existing-feed').map((rule) => rule.keyword)).toContain('Sponsored')
    expect(fixture.filters.getByFeed(newFeed!.id).map((rule) => rule.keyword)).toContain('Promo')
    expect(fixture.translation.getApiKey('DEEPL')).toBe('android-deepl-key')
    expect(fixture.ai.getApiKey('android-ai')).toBe('android-ai-key')
    expect(fixture.settings.current()).toMatchObject({
      syncIntervalMinutes: 60,
      syncOnStart: true,
      layoutMode: 'three-pane',
      sourcePaneWidth: 260,
      articlePaneWidth: 380,
      sourcePaneCollapsed: false,
      articlePaneCollapsed: false
    })
  })

  it('exports the Android envelope and can omit or include encrypted secrets', async () => {
    const fixture = createFixture()
    fixture.ai.updateProvider({ id: 'default', endpoint: 'https://api.example/v1', defaultModel: 'model', apiKey: 'secret-ai' })
    fixture.translation.updateProvider({ type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', apiKey: 'secret-deepl' })
    fixture.settings.update({ layoutMode: 'two-pane', sourcePaneWidth: 300, articlePaneWidth: 440, sourcePaneCollapsed: true })

    const plainContent = await fixture.backup.exportBackup('')
    const plain = JSON.parse(plainContent) as ConfigurationBackup
    expect(plain).toMatchObject({ schemaVersion: 1, appName: 'OrigRead', sourceVersion: '0.1.0' })
    expect(plain.preferences).toMatchObject({
      'origread.desktop.readerFontSize': 17,
      'origread.desktop.readerLineHeight': 1.85,
      'origread.desktop.readerContentWidth': 760,
      'origread.desktop.layoutMode': 'two-pane',
      'origread.desktop.sourcePaneWidth': 300,
      'origread.desktop.articlePaneWidth': 440,
      'origread.desktop.sourcePaneCollapsed': true,
      'origread.desktop.articlePaneCollapsed': false,
      'origread.desktop.aiSummaryPlacement': 'right'
    })
    expect(plain.encryptedSecrets).toBeNull()

    fixture.settings.update({ layoutMode: 'three-pane', sourcePaneWidth: 220, articlePaneWidth: 320, sourcePaneCollapsed: false, articlePaneCollapsed: true })
    await fixture.backup.restoreBackup(plainContent)
    expect(fixture.settings.current()).toMatchObject({
      layoutMode: 'two-pane',
      sourcePaneWidth: 300,
      articlePaneWidth: 440,
      sourcePaneCollapsed: true,
      articlePaneCollapsed: false
    })

    const encrypted = JSON.parse(await fixture.backup.exportBackup('backup-pass')) as ConfigurationBackup
    expect(encrypted.encryptedSecrets).toMatchObject({ kdf: 'PBKDF2WithHmacSHA256', cipher: 'AES-256-GCM', iterations: 210_000 })
  })

  it.each(['replace', 'top', 'bottom'] as const)('restores legacy desktop summary placement %s as right', async (legacyPlacement) => {
    const fixture = createFixture()
    const backup = await androidBackup(fixture)
    backup.preferences = {
      'origread.desktop.aiSummaryPlacement': legacyPlacement,
      'origread.desktop.aiSummaryPanelSize': 430
    }

    await fixture.backup.restoreBackup(JSON.stringify(backup), 'backup-pass')

    expect(fixture.settings.current()).toMatchObject({
      aiSummaryPlacement: 'right',
      aiSummaryPanelSize: 430
    })
  })

  it('round-trips Skills, Quick Messages, and Custom Instructions without exposing them as secrets', async () => {
    const fixture = createFixture()
    await fixture.skills.createFromMarkdown(`---\nname: evidence-reader\ndescription: Use for evidence checks\n---\nCheck claims carefully.`)
    fixture.skills.setBinding('SUMMARY', 'evidence-reader')
    fixture.quickMessages.create('Compare', 'Compare {{article_title}} with the current evidence.')
    fixture.customization.update({ skillsEnabled: false, customInstructions: 'Prefer concise answers.' })

    const content = await fixture.backup.exportBackup('')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.llm).toMatchObject({
      customization: { skillsEnabled: false, customInstructions: 'Prefer concise answers.' }
    })
    expect(JSON.stringify(exported.llm)).toContain('evidence-reader')
    expect(JSON.stringify(exported.llm)).toContain('Compare')
    expect(exported.encryptedSecrets).toBeNull()

    fixture.skills.delete('evidence-reader')
    fixture.quickMessages.delete(fixture.quickMessages.current().find((message) => message.title === 'Compare')!.id)
    fixture.customization.update({ skillsEnabled: true, customInstructions: 'Changed after backup.' })
    await fixture.backup.restoreBackup(content)

    expect(fixture.skills.skill('evidence-reader')).toMatchObject({ id: 'evidence-reader', enabled: true })
    expect(fixture.skills.current().bindings.summarySkillId).toBe('evidence-reader')
    expect(fixture.quickMessages.current().some((message) => message.title === 'Compare')).toBe(true)
    expect(fixture.customization.current()).toEqual({ skillsEnabled: false, customInstructions: 'Prefer concise answers.' })
  })

  it('round-trips Web Search profiles separately from encrypted API keys and rejects dangling Search secrets', async () => {
    const fixture = createFixture()
    const added = fixture.webSearch.addProvider('TAVILY')
    const provider = added.providers[0]!
    fixture.webSearch.updateProvider({
      id: provider.id,
      name: 'Backup Tavily',
      endpoint: 'https://api.tavily.com/search',
      apiKey: 'search-secret-value'
    })
    fixture.webSearch.updateSettings({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })

    const content = await fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.webSearch).toMatchObject({
      mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8,
      providers: [{ id: provider.id, kind: 'TAVILY', name: 'Backup Tavily' }]
    })
    expect(JSON.stringify(exported.webSearch)).not.toContain('search-secret-value')
    expect(content).not.toContain('search-secret-value')

    fixture.webSearch.removeProvider(provider.id)
    expect(fixture.webSearch.current().providers).toHaveLength(0)
    await fixture.backup.restoreBackup(content, 'backup-pass')
    expect(fixture.webSearch.current()).toMatchObject({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })
    expect(fixture.webSearch.getApiKey(provider.id)).toBe('search-secret-value')

    const dangling = { ...exported }
    dangling.encryptedSecrets = await encryptConfigurationSecrets({
      translationApiKeys: {}, aiApiKeys: {}, webSearchApiKeys: { 'missing-provider': 'bad-secret' }
    }, 'backup-pass')
    await expect(fixture.backup.restoreBackup(JSON.stringify(dangling), 'backup-pass')).rejects.toThrow('Web Search 凭据引用了不存在的 Provider')
  })

  it('round-trips Remote/Local MCP profiles and encrypted secrets without restoring transient OAuth state', async () => {
    const fixture = createFixture()
    const firstRemote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: firstRemote.id,
      name: 'Backup bearer MCP',
      url: 'https://mcp.example/stream',
      enabled: true,
      authMode: 'BEARER',
      credential: 'remote-bearer-secret'
    })
    const secondRemote = fixture.mcpRemote.addServer().servers.at(-1)!
    fixture.mcpRemote.updateServer({
      id: secondRemote.id,
      name: 'Backup OAuth MCP',
      url: 'https://oauth-mcp.example/mcp',
      enabled: true,
      authMode: 'OAUTH',
      oauthScopes: 'tools.read tools.write'
    })
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'client'), JSON.stringify({ issuer: 'https://auth.example', value: { client_id: 'client-1' } }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'tokens'), JSON.stringify({ issuer: 'https://auth.example', value: { access_token: 'oauth-access-secret', refresh_token: 'oauth-refresh-secret' } }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'discovery'), JSON.stringify({ authorizationServerUrl: 'https://auth.example' }))
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'verifier'), 'transient-verifier')
    fixture.secrets.put(mcpOAuthSecretKey(secondRemote.id, 'state'), 'transient-state')

    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({
      id: local.id,
      name: 'Backup local MCP',
      command: process.execPath,
      args: ['fixture-server.cjs', '--stdio'],
      cwd: fixture.dir,
      environment: 'LOCAL_TOKEN=local-env-secret\nLOCAL_MODE=backup',
      enabled: true
    })

    const content = await fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp).toMatchObject({
      remote: { servers: [
        { id: firstRemote.id, name: 'Backup bearer MCP', authMode: 'BEARER', enabled: true },
        { id: secondRemote.id, name: 'Backup OAuth MCP', authMode: 'OAUTH', oauthScopes: 'tools.read tools.write', enabled: true }
      ] },
      local: { servers: [{ id: local.id, name: 'Backup local MCP', command: process.execPath, enabled: true }] }
    })
    expect(JSON.stringify(exported.mcp)).not.toContain('remote-bearer-secret')
    expect(JSON.stringify(exported.mcp)).not.toContain('local-env-secret')
    expect(content).not.toContain('remote-bearer-secret')
    expect(content).not.toContain('oauth-access-secret')
    expect(content).not.toContain('local-env-secret')

    fixture.mcpRemote.removeServer(firstRemote.id)
    fixture.mcpRemote.removeServer(secondRemote.id)
    fixture.mcpLocal.removeServer(local.id)
    await fixture.backup.restoreBackup(content, 'backup-pass')

    expect(fixture.mcpRemote.current().servers).toMatchObject([
      { id: firstRemote.id, name: 'Backup bearer MCP', authMode: 'BEARER', hasCredential: true },
      { id: secondRemote.id, name: 'Backup OAuth MCP', authMode: 'OAUTH', oauthAuthorized: true }
    ])
    expect(fixture.mcpRemote.getCredential(firstRemote.id)).toBe('remote-bearer-secret')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'client'))).toContain('client-1')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'tokens'))).toContain('oauth-refresh-secret')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'discovery'))).toBe('')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'verifier'))).toBe('')
    expect(fixture.secrets.get(mcpOAuthSecretKey(secondRemote.id, 'state'))).toBe('')
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, name: 'Backup local MCP', enabled: false, hasEnvironment: true })
    expect(fixture.mcpLocal.getEnvironment(local.id)).toContain('LOCAL_TOKEN=local-env-secret')

    const dangling = { ...exported }
    dangling.encryptedSecrets = await encryptConfigurationSecrets({
      translationApiKeys: {},
      aiApiKeys: {},
      mcpRemoteCredentials: { 'missing-mcp-server': 'bad-secret' }
    }, 'backup-pass')
    await expect(fixture.backup.restoreBackup(JSON.stringify(dangling), 'backup-pass')).rejects.toThrow('Remote MCP 凭据引用了不存在的 Server')
  })

  it('rejects MCP secrets when the backup has no MCP profiles', async () => {
    const fixture = createFixture()
    const legacy = await androidBackup(fixture)
    legacy.encryptedSecrets = await encryptConfigurationSecrets({
      translationApiKeys: {},
      aiApiKeys: {},
      mcpLocalEnvironments: { 'orphan-local-server': 'TOKEN=orphan-secret' }
    }, 'backup-pass')

    await expect(fixture.backup.restoreBackup(JSON.stringify(legacy), 'backup-pass'))
      .rejects.toThrow('MCP 凭据存在，但备份缺少对应的 MCP 配置')
  })

  it('restores plain MCP profiles without inheriting stale credentials from matching server IDs', async () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: remote.id,
      name: 'Plain bearer MCP',
      url: 'https://mcp.example/plain',
      enabled: true,
      authMode: 'BEARER',
      credential: 'backup-time-secret'
    })
    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({
      id: local.id,
      name: 'Plain local MCP',
      command: process.execPath,
      environment: 'LOCAL_TOKEN=backup-time-secret',
      enabled: true
    })

    const content = await fixture.backup.exportBackup('')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp).toBeDefined()
    expect(exported.encryptedSecrets).toBeNull()

    fixture.mcpRemote.updateServer({ id: remote.id, credential: 'restore-target-secret' })
    fixture.mcpLocal.updateServer({ id: local.id, environment: 'LOCAL_TOKEN=restore-target-secret' })
    await fixture.backup.restoreBackup(content)

    expect(fixture.mcpRemote.getCredential(remote.id)).toBe('')
    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, hasCredential: false })
    expect(fixture.mcpLocal.getEnvironment(local.id)).toBe('')
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, hasEnvironment: false })
  })

  it('round-trips Remote MCP Custom Headers only through encrypted backup secrets', async () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({
      id: remote.id,
      name: 'Custom Header MCP',
      url: 'https://mcp.example/custom-headers',
      enabled: true,
      authMode: 'CUSTOM_HEADERS',
      credential: 'X-Api-Key: custom-header-secret\nX-Client: OrigRead'
    })

    const content = await fixture.backup.exportBackup('backup-pass')
    const exported = JSON.parse(content) as ConfigurationBackup
    expect(exported.mcp?.remote.servers[0]).toMatchObject({
      id: remote.id,
      authMode: 'CUSTOM_HEADERS',
      enabled: true
    })
    expect(JSON.stringify(exported.mcp)).not.toContain('custom-header-secret')
    expect(content).not.toContain('custom-header-secret')

    fixture.mcpRemote.removeServer(remote.id)
    await fixture.backup.restoreBackup(content, 'backup-pass')
    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, authMode: 'CUSTOM_HEADERS', hasCredential: true })
    expect(fixture.mcpRemote.getCredential(remote.id)).toContain('X-Api-Key: custom-header-secret')
  })

  it('keeps current MCP settings when restoring a pre-D6 backup without MCP fields', async () => {
    const fixture = createFixture()
    const remote = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({ id: remote.id, name: 'Keep remote', url: 'https://mcp.example/mcp', enabled: true })
    const local = fixture.mcpLocal.addServer().servers[0]!
    fixture.mcpLocal.updateServer({ id: local.id, name: 'Keep local', command: process.execPath, enabled: true })

    await fixture.backup.restoreBackup(JSON.stringify(await androidBackup(fixture)), 'backup-pass')

    expect(fixture.mcpRemote.current().servers[0]).toMatchObject({ id: remote.id, name: 'Keep remote' })
    expect(fixture.mcpLocal.current().servers[0]).toMatchObject({ id: local.id, name: 'Keep local' })
  })

  it('keeps current Web Search settings when restoring a pre-D5 backup without Search fields', async () => {
    const fixture = createFixture()
    const added = fixture.webSearch.addProvider('KEENABLE')
    const provider = added.providers[0]!
    fixture.webSearch.updateSettings({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 10 })

    await fixture.backup.restoreBackup(JSON.stringify(await androidBackup(fixture)), 'backup-pass')

    expect(fixture.webSearch.current()).toMatchObject({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 10 })
    expect(fixture.webSearch.current().providers[0]).toMatchObject({ id: provider.id, kind: 'KEENABLE' })
  })

  it('rolls back SQLite, file-backed rules, and secrets when a late restore step fails', async () => {
    const fixture = createFixture()
    const aiProviderId = fixture.ai.current().providers[0]!.id
    const filterBundle = JSON.parse(fixture.filters.exportRules()) as { rules: unknown[] }

    // Build a target backup that differs in all three persistence domains.
    fixture.settings.update({ theme: 'dark' })
    fixture.ai.updateProvider({ id: aiProviderId, apiKey: 'target-ai-secret' })
    fixture.customization.update({ customInstructions: 'target customization' })
    fixture.filters.restoreBackup(JSON.stringify({
      ...filterBundle,
      rules: [{ id: 'target-filter', keyword: 'Target', feedId: null, feedName: null, type: 'KEYWORD', enabled: true }]
    }), new Map())
    const targetBackup = await fixture.backup.exportBackup('target-pass')

    // Establish the state that must survive the failed restore unchanged.
    fixture.settings.update({ theme: 'light' })
    fixture.ai.updateProvider({ id: aiProviderId, apiKey: 'baseline-ai-secret' })
    fixture.customization.update({ customInstructions: 'baseline customization' })
    fixture.filters.restoreBackup(JSON.stringify({ ...filterBundle, rules: [] }), new Map())
    const baselineSettings = fixture.settings.current()
    const baselineFilters = fixture.filters.exportRules()
    const baselineCustomization = fixture.customization.current()
    const baselineSecretSnapshot = fixture.secrets.snapshot()

    const originalUpdate = fixture.customization.update.bind(fixture.customization)
    fixture.customization.update = (() => { throw new Error('injected late restore failure') }) as typeof fixture.customization.update
    try {
      await expect(fixture.backup.restoreBackup(targetBackup, 'target-pass')).rejects.toThrow(/injected late restore failure/)
    } finally {
      fixture.customization.update = originalUpdate as typeof fixture.customization.update
    }

    expect(fixture.settings.current()).toEqual(baselineSettings)
    expect(fixture.filters.exportRules()).toBe(baselineFilters)
    expect(fixture.customization.current()).toEqual(baselineCustomization)
    expect(fixture.ai.getApiKey(aiProviderId)).toBe('baseline-ai-secret')
    expect(fixture.secrets.snapshot()).toEqual(baselineSecretSnapshot)
  })
})

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'origread-backup-'))
  dirs.push(dir)
  return createConfigurationBackupFixture(dir)
}

function readEncryptedSecrets(backup:ConfigurationBackup,password:string):Record<string,unknown>{
  const value=backup.encryptedSecrets!
  const payload=Buffer.from(value.ciphertextBase64,'base64')
  const key=pbkdf2Sync(password,Buffer.from(value.saltBase64,'base64'),value.iterations,32,'sha256')
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.ivBase64,'base64'))
  decipher.setAAD(Buffer.from('OrigReadConfigurationBackup:v1','utf8'))
  decipher.setAuthTag(payload.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(payload.subarray(0,-16)),decipher.final()]).toString('utf8'))
}

async function androidBackup(fixture: ReturnType<typeof createFixture>): Promise<ConfigurationBackup> {
  const encryptedSecrets = await encryptConfigurationSecrets({
    translationApiKeys: { DEEPL: 'android-deepl-key' },
    aiApiKeys: { 'android-ai': 'android-ai-key' }
  }, 'backup-pass')
  return {
    schemaVersion: 1,
    appName: 'OrigRead',
    sourceVersion: '1.0.0-android',
    createdAtEpochMillis: 1_786_700_000_000,
    preferences: {},
    accountSettings: {
      syncIntervalMinutes: 60,
      syncOnStart: true,
      syncOnlyOnWiFi: false,
      syncOnlyWhenCharging: false,
      keepArchivedMillis: 2_592_000_000,
      syncBlockList: []
    },
    subscriptions: {
      sourceAccountId: 1,
      groups: [
        { id: 'android-default-group', name: '默认', isDefault: true },
        { id: 'android-tech-group', name: '科技', isDefault: false }
      ],
      feeds: [
        { id: 'android-existing', name: 'Android Updated', icon: null, url: 'https://example.com/feed.xml', groupId: 'android-default-group', isNotification: true, isFullContent: false, isBrowser: false, sourceType: 'RSS' },
        { id: 'android-new', name: 'Android New', icon: null, url: 'https://new.example/feed.xml', groupId: 'android-tech-group', isNotification: false, isFullContent: false, isBrowser: false, sourceType: 'RSS' }
      ]
    },
    websiteRules: JSON.parse(fixture.websiteRules.exportRules()),
    jsonRules: JSON.parse(fixture.jsonRules.exportRules()),
    articleFilters: {
      schemaVersion: 1,
      rules: [
        { id: 'global-filter', keyword: 'Ads', feedId: null, feedName: null, type: 'KEYWORD', enabled: true },
        { id: 'existing-filter', keyword: 'Sponsored', feedId: 'android-existing', feedName: 'Android Updated', type: 'KEYWORD', enabled: true },
        { id: 'new-filter', keyword: 'Promo', feedId: 'android-new', feedName: 'Android New', type: 'KEYWORD', enabled: true }
      ],
      stats: { totalFiltered: 8, lastFilteredAt: null, lastMatchedRule: null }
    },
    websiteParsePreferences: { items: [] },
    rssHub: fixture.rssHub.current(),
    rssHubSourceUrls: {},
    translation: {
      defaultProvider: 'DEEPL',
      defaultTarget: { type: 'traditional', provider: 'DEEPL' },
      targetLanguage: 'zh-CN',
      displayMode: 'BILINGUAL',
      providers: [
        { type: 'ML_KIT', enabled: true, endpoint: '', region: '' },
        { type: 'MICROSOFT', enabled: false, endpoint: 'https://api.cognitive.microsofttranslator.com', region: '' },
        { type: 'DEEPL', enabled: true, endpoint: 'https://api-free.deepl.com/v2/translate', region: '' },
        { type: 'GOOGLE_CLOUD', enabled: false, endpoint: 'https://translation.googleapis.com/language/translate/v2', region: '' },
        { type: 'DLX', enabled: false, endpoint: '', region: '' }
      ]
    },
    ai: {
      enabled: true,
      defaultProviderId: 'android-ai',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD',
      providers: [{ id: 'android-ai', name: 'Android AI', enabled: true, endpoint: 'https://ai.example/v1', defaultModel: 'android-model', models: ['android-model'] }]
    },
    encryptedSecrets
  }
}


describe('MCP discovery backup poisoning', () => {
  it('discards discovery injected into encrypted secrets and clears an existing cache', async () => {
    const fixture = createFixture()
    const server = fixture.mcpRemote.addServer().servers[0]!
    fixture.mcpRemote.updateServer({ id: server.id, url: 'https://mcp.example.com/mcp', authMode: 'OAUTH' })
    const backup = JSON.parse(await fixture.backup.exportBackup('')) as ConfigurationBackup
    backup.encryptedSecrets = await encryptConfigurationSecrets({
      translationApiKeys: {}, aiApiKeys: {},
      mcpRemoteOAuth: { [server.id]: { discovery: '{"authorizationServerUrl":"http://169.254.169.254/latest"}' } }
    }, 'backup-pass')
    fixture.secrets.put(mcpOAuthSecretKey(server.id, 'discovery'), '{"authorizationServerUrl":"https://stale.example.com"}')
    await fixture.backup.restoreBackup(JSON.stringify(backup), 'backup-pass')
    expect(fixture.secrets.get(mcpOAuthSecretKey(server.id, 'discovery'))).toBe('')
  })
})
