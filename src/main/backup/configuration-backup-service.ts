import { isDesktopLanguage } from '../../shared/locale'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import type { LibraryRepository } from '../database/library-repository'
import type { SettingsRepository } from '../database/settings-repository'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import type { TranslationSettingsRepository } from '../translation/translation-settings-repository'
import type { ConfigurationBackup,ConfigurationBackupSecrets,ConfigurationRestoreResult,TranslationBackup,AiBackup,RssHubBackup,WebSearchBackup,McpBackup } from '../../shared/configuration-backup'
import { backupTargetToTranslationTarget } from '../../shared/configuration-backup'
import { normalizeRssHubRoutePath } from '../sources/rsshub/rsshub-input'
import type { RssHubSubscriptionDescriptor } from '../../shared/rsshub'
import type { FeedRecord, SourceType } from '../../shared/library'
import { findGroupByName, normalizeGroupName } from '../../shared/group-name'
import type { TranslationProviderType } from '../../shared/translation'
import { TRANSLATION_PROVIDER_TYPES } from '../../shared/translation'
import { decryptConfigurationSecrets,encryptConfigurationSecrets } from './configuration-backup-crypto'
import type { AccountRepository } from '../accounts/account-repository'
import { DEFAULT_DESKTOP_SETTINGS, isUiFontScale, normalizeAiSummaryPlacement } from '../../shared/settings'
import type { LlmSkillRepository } from '../llm/skill-repository'
import type { LlmQuickMessageRepository } from '../llm/quick-message-repository'
import type { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { normalizeLlmCustomizationSettingsPatch } from '../../shared/llm-customization'
import type { WebSearchRepository } from '../search/web-search-repository'
import { MAX_WEB_SEARCH_MAX_RESULTS, MIN_WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_PROVIDER_KINDS } from '../../shared/web-search'
import type { McpRemoteRepository } from '../mcp/mcp-remote-repository'
import type { McpLocalRepository } from '../mcp/mcp-local-repository'
import type { SecretStore } from '../security/secret-store'
import { exportJsonSubscriptionBackup, validateJsonSubscriptionBackup, restoreJsonSubscriptionBackup } from './json-subscription-backup'
import { buildGroupPathMap, escapeGroupSegment, validateDesktopGroupHierarchyBackup } from './desktop-group-hierarchy-backup'
import type { LlmCustomizationSettings } from '../../shared/llm-customization'
import type { McpRemoteOAuthBackupSecrets } from '../../shared/configuration-backup'
import { MCP_REMOTE_AUTH_MODES } from '../../shared/mcp'
import { assertRemoteServerTransportPolicy } from '../mcp/mcp-remote-repository'

const EDITION_SETTINGS_KEY='backup.android.edition-settings'

export class ConfigurationBackupService {
  constructor(
    private readonly appVersion:string,
    private readonly library:LibraryRepository,
    private readonly desktopSettings:SettingsRepository,
    private readonly websiteRules:WebsiteRuleRepository,
    private readonly jsonRules:JsonRuleRepository,
    private readonly articleFilters:ArticleFilterRepository,
    private readonly websitePreferences:WebsiteParsePreferenceRepository,
    private readonly rssHub:RssHubSettingsRepository,
    private readonly translation:TranslationSettingsRepository,
    private readonly ai:AiSettingsRepository,
    private readonly accounts?:AccountRepository,
    private readonly llmSkills?:LlmSkillRepository,
    private readonly llmQuickMessages?:LlmQuickMessageRepository,
    private readonly llmCustomization?:LlmCustomizationSettingsRepository,
    private readonly webSearch?:WebSearchRepository,
    private readonly mcpRemote?:McpRemoteRepository,
    private readonly mcpLocal?:McpLocalRepository,
    private readonly database?:DatabaseSync,
    private readonly secretStore?:SecretStore
  ){}

  async exportBackup(password=''):Promise<string>{
    const groups=this.library.listGroups(),feeds=this.library.listFeeds(),settings=this.desktopSettings.current(),translation=this.translation.current(),ai=this.ai.current(),account=this.accounts?.current()
    const isLocalAccount = !account || account.type === 'local'
    const hasNestedGroups = groups.some((group) => Boolean(group.parentId))
    const groupPathMap = isLocalAccount && hasNestedGroups ? buildGroupPathMap(groups) : null
    const desktopGroupHierarchy = isLocalAccount ? {
      version: 1 as const,
      groups: groups.map((group) => ({
        id: group.id,
        parentId: group.parentId ?? null,
        name: group.name
      }))
    } : undefined
    const mcpRemoteSecrets=this.mcpRemote?.exportBackupSecrets()
    const secrets:ConfigurationBackupSecrets={
      translationApiKeys:Object.fromEntries(TRANSLATION_PROVIDER_TYPES.map((type)=>[type,this.translation.getApiKey(type)]).filter(([,value])=>Boolean(value))) as Partial<Record<TranslationProviderType,string>>,
      aiApiKeys:Object.fromEntries(ai.providers.map((provider)=>[provider.id,this.ai.getApiKey(provider.id)]).filter(([,value])=>Boolean(value))),
      ...(this.webSearch?{webSearchApiKeys:this.webSearch.exportApiKeys()}:{}),
      ...(mcpRemoteSecrets&&Object.keys(mcpRemoteSecrets.credentials).length>0?{mcpRemoteCredentials:mcpRemoteSecrets.credentials}:{}),
      ...(mcpRemoteSecrets&&Object.keys(mcpRemoteSecrets.oauth).length>0?{mcpRemoteOAuth:mcpRemoteSecrets.oauth}:{}),
      ...(this.mcpLocal?{mcpLocalEnvironments:this.mcpLocal.exportBackupEnvironments()}:{}),
    }
    const editionConfiguration = this.exportEditionConfiguration(ai.reasoningEffort ?? 'AUTO')
    if (editionConfiguration) secrets.editionSecrets = exportEditionSecrets(secrets,this.mcpRemote?.exportBackupState())
    const hasSecrets=Object.keys(secrets.translationApiKeys).length>0||Object.keys(secrets.aiApiKeys).length>0||Object.keys(secrets.webSearchApiKeys??{}).length>0||Object.keys(secrets.mcpRemoteCredentials??{}).length>0||Object.keys(secrets.mcpRemoteOAuth??{}).length>0||Object.keys(secrets.mcpLocalEnvironments??{}).length>0||hasEditionSecrets(secrets.editionSecrets)
    const includeSecrets=Boolean(password)
    if(includeSecrets&&password.length<6)throw new Error('备份密码至少需要 6 个字符')
    const backup:ConfigurationBackup={
      schemaVersion:1,appName:'OrigRead',sourceVersion:this.appVersion,createdAtEpochMillis:Date.now(),preferences:desktopPreferences(settings),
      accountSettings:{syncIntervalMinutes:account?.syncIntervalMinutes??settings.syncIntervalMinutes,syncOnStart:account?.syncOnStart??settings.syncOnStart,syncOnlyOnWiFi:account?.syncOnlyOnWiFi??false,syncOnlyWhenCharging:account?.syncOnlyWhenCharging??false,keepArchivedMillis:account?.keepArchivedMillis??2_592_000_000,syncBlockList:account?.syncBlockList??[]},
      subscriptions:{
        sourceAccountId:account?.id??1,
        groups:groups.map((group)=>({
          id:group.id,
          name:groupPathMap ? (groupPathMap.get(group.id) ?? escapeGroupSegment(group.name)) : group.name,
          isDefault:group.isDefault
        })),
        feeds:feeds.map(toBackupFeed)
      },
      websiteRules:JSON.parse(this.websiteRules.exportRules()),jsonRules:exportJsonSubscriptionBackup(this.library,this.jsonRules),articleFilters:JSON.parse(this.articleFilters.exportRules(new Set(feeds.map(feed=>feed.id)))),websiteParsePreferences:JSON.parse(this.websitePreferences.exportBackup(new Set(feeds.map((feed)=>feed.id)))),
      rssHub:this.rssHub.current(),rssHubSourceUrls:this.library.listRssHubSourceUrls(),rssHubSubscriptions:this.library.listRssHubDescriptors(),rssHubDescriptors:this.library.listRssHubDescriptors(),translation:toTranslationBackup(translation),ai:toAiBackup(ai),
      ...(desktopGroupHierarchy ? { desktopGroupHierarchy } : {}),
      ...(this.llmSkills&&this.llmQuickMessages&&this.llmCustomization?{llm:{customization:this.llmCustomization.current(),skills:JSON.parse(this.llmSkills.exportBackupState()),quickMessages:JSON.parse(this.llmQuickMessages.exportBackupState())}}:{}),
      ...(this.webSearch?{webSearch:this.webSearch.exportStoredSettings()}:{}),
      ...(this.mcpRemote&&this.mcpLocal?{mcp:{remote:this.mcpRemote.exportBackupState(),local:this.mcpLocal.exportBackupState()}}:{}),
      ...(editionConfiguration ? { editionConfiguration } : {}),
      encryptedSecrets:includeSecrets&&hasSecrets?await encryptConfigurationSecrets(secrets,password):null
    }
    if (desktopGroupHierarchy) {
      validateDesktopGroupHierarchyBackup(desktopGroupHierarchy, backup.subscriptions.groups, { isLocalAccount })
    }
    this.validateEditionBackup(backup.editionConfiguration, secrets.editionSecrets)
    return JSON.stringify(backup,null,2)
  }

  inspect(content:string):{sourceVersion:string;createdAtEpochMillis:number;feeds:number;groups:number;hasEncryptedSecrets:boolean}{const backup=this.decodeAndValidate(content);return{sourceVersion:backup.sourceVersion,createdAtEpochMillis:backup.createdAtEpochMillis,feeds:backup.subscriptions.feeds.length,groups:backup.subscriptions.groups.length,hasEncryptedSecrets:Boolean(backup.encryptedSecrets)}}

  async restoreBackup(content:string,password=''):Promise<ConfigurationRestoreResult>{
    const backup=this.decodeAndValidate(content)
    const accountId=this.library.getCurrentAccountId()
    const secrets=backup.encryptedSecrets?await decryptConfigurationSecrets(backup.encryptedSecrets,password):null
    if(this.library.getCurrentAccountId()!==accountId)throw new Error('账户已切换，请重新导入备份')
    validateWebSearchSecretReferences(backup.webSearch,secrets?.webSearchApiKeys)
    this.validateMcpBackup(backup.mcp,secrets??undefined)
    this.validateEditionBackup(backup.editionConfiguration,secrets?.editionSecrets)
    // 到这里才开始任何写入：格式、规则、订阅和密码均已完整校验。
    // D8.4: Desktop 的配置横跨 SQLite、JSON 规则文件和 SecretStore；恢复必须作为一个逻辑事务。
    if(this.database&&this.secretStore){
      const rollback=this.captureRollbackState()
      this.database.exec('BEGIN IMMEDIATE')
      try{
        const result=this.applyValidatedBackup(backup,secrets)
        this.database.exec('COMMIT')
        return result
      }catch(error){
        const rollbackErrors:unknown[]=[]
        try{this.database.exec('ROLLBACK')}catch(rollbackError){rollbackErrors.push(rollbackError)}
        try{this.restoreRollbackState(rollback)}catch(rollbackError){rollbackErrors.push(rollbackError)}
        if(rollbackErrors.length>0)throw new AggregateError([error,...rollbackErrors],'配置恢复失败，且回滚未能完整完成')
        throw error
      }
    }
    return this.applyValidatedBackup(backup,secrets)
  }

  private applyValidatedBackup(backup:ConfigurationBackup,secrets:ConfigurationBackupSecrets|null):ConfigurationRestoreResult{
    const edition=this.validateEditionBackup(backup.editionConfiguration,secrets?.editionSecrets)
    const currentAccountFeedIds=new Set(this.library.listFeeds().map(feed=>feed.id))
    const {feedIdMap,groupsAdded,feedsAdded,feedsUpdated}=this.restoreSubscriptions(backup)
    this.desktopSettings.update(readDesktopPreferences(backup.preferences))
    if(this.accounts){
      this.accounts.update({id:this.accounts.currentId(),syncIntervalMinutes:normalizeDesktopSyncInterval(backup.accountSettings.syncIntervalMinutes),syncOnStart:backup.accountSettings.syncOnStart,syncOnlyOnWiFi:backup.accountSettings.syncOnlyOnWiFi,syncOnlyWhenCharging:backup.accountSettings.syncOnlyWhenCharging,keepArchivedMillis:backup.accountSettings.keepArchivedMillis,syncBlockList:backup.accountSettings.syncBlockList})
    }else{
      this.desktopSettings.update({syncIntervalMinutes:normalizeDesktopSyncInterval(backup.accountSettings.syncIntervalMinutes),syncOnStart:backup.accountSettings.syncOnStart})
    }
    this.websiteRules.restoreBackup(JSON.stringify(backup.websiteRules))
    this.jsonRules.restoreBackup(JSON.stringify(backup.jsonRules))
    if(!this.accounts||this.accounts.current()?.type==='local')restoreJsonSubscriptionBackup(backup,this.library,feedIdMap)
    const filterRulesRestored=this.articleFilters.restoreBackup(JSON.stringify(backup.articleFilters),feedIdMap,currentAccountFeedIds)
    this.websitePreferences.restoreBackup(JSON.stringify(backup.websiteParsePreferences),feedIdMap)
    this.rssHub.restore(backup.rssHub)
    // Restore legacy provenance first; descriptors enrich only the feeds they cover.
    for(const [oldFeedId,url] of Object.entries(backup.rssHubSourceUrls ?? {})){
      const mapped=feedIdMap.get(oldFeedId)
      if(mapped)this.library.setRssHubSourceUrl(mapped,url)
    }
    const descriptors = { ...backup.rssHubDescriptors, ...backup.rssHubSubscriptions }
    for(const [oldFeedId,descriptor] of Object.entries(descriptors)){
      const mapped=feedIdMap.get(oldFeedId)
      if(mapped)this.library.setRssHubDescriptor(mapped,descriptor)
    }
    this.restoreTranslation(backup.translation,secrets?.translationApiKeys)
    this.restoreAi(!backup.llm&&edition?.settings.reasoningEffort!==undefined?{...backup.ai,reasoningEffort:edition.settings.reasoningEffort as AiBackup['reasoningEffort']}:backup.ai,secrets?.aiApiKeys)
    if(backup.webSearch&&this.webSearch){
      this.webSearch.restore(backup.webSearch,secrets?.webSearchApiKeys)
    }
    if(backup.mcp&&this.mcpRemote&&this.mcpLocal){
      this.mcpRemote.restoreBackupState(backup.mcp.remote,secrets?.mcpRemoteCredentials,secrets?.mcpRemoteOAuth)
      this.mcpLocal.restoreBackupState(backup.mcp.local,secrets?.mcpLocalEnvironments)
    }
    if(backup.llm&&this.llmSkills&&this.llmQuickMessages&&this.llmCustomization){
      this.llmSkills.restoreBackupState(JSON.stringify(backup.llm.skills))
      this.llmQuickMessages.restoreBackupState(JSON.stringify(backup.llm.quickMessages))
      this.llmCustomization.update(backup.llm.customization)
    }
    if(edition){
      if(!backup.llm){
        this.llmCustomization?.update(edition.customization)
        if(edition.skillState!==undefined)this.llmSkills!.restoreBackupState(edition.skillState)
        if(edition.quickMessageState!==undefined)this.llmQuickMessages!.restoreBackupState(edition.quickMessageState)
      }
      // Retain Android-only options for the next portable export, within the SQLite transaction.
      this.database?.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
        .run(EDITION_SETTINGS_KEY,JSON.stringify(edition.settings),Date.now())
      if(!backup.webSearch)this.webSearch?.restore(edition.webSearch,edition.secrets.webSearchApiKeys)
      if(!backup.mcp)this.mcpRemote?.restoreBackupState(edition.remote,edition.secrets.mcpRemoteCredentials,edition.secrets.mcpRemoteOAuth)
    }
    return{groupsAdded,feedsAdded,feedsUpdated,filterRulesRestored,credentialsRestored:Boolean(secrets)}
  }

  private captureRollbackState():{
    websiteRules:string|null
    jsonRules:string|null
    articleFilters:string|null
    websitePreferences:string|null
    secrets:Readonly<Record<string,string>>
  }{
    if(!this.secretStore)throw new Error('SecretStore is not available')
    return{
      websiteRules:this.websiteRules.exportRawState(),
      jsonRules:this.jsonRules.exportRawState(),
      articleFilters:this.articleFilters.exportRawState(),
      websitePreferences:this.websitePreferences.exportRawState(),
      secrets:this.secretStore.snapshot()
    }
  }

  private restoreRollbackState(state:{websiteRules:string|null;jsonRules:string|null;articleFilters:string|null;websitePreferences:string|null;secrets:Readonly<Record<string,string>>}):void{
    if(!this.secretStore)throw new Error('SecretStore is not available')
    const errors:unknown[]=[]
    for(const restore of [
      ()=>this.websiteRules.restoreRawState(state.websiteRules),
      ()=>this.jsonRules.restoreRawState(state.jsonRules),
      ()=>this.articleFilters.restoreRawState(state.articleFilters),
      ()=>this.websitePreferences.restoreRawState(state.websitePreferences),
      ()=>this.secretStore!.restoreSnapshot(state.secrets)
    ]){
      try{restore()}catch(error){errors.push(error)}
    }
    if(errors.length>0)throw new AggregateError(errors,'配置恢复回滚失败')
  }

  private decodeAndValidate(content:string):ConfigurationBackup{
    let backup:ConfigurationBackup;try{backup=JSON.parse(content) as ConfigurationBackup}catch{throw new Error('备份文件不是有效 JSON')}
    if(backup.schemaVersion!==1)throw new Error(`不支持的配置备份版本：${String(backup.schemaVersion)}`)
    if(backup.appName!=='OrigRead'||!String(backup.sourceVersion??'').trim())throw new Error('这不是有效的 OrigRead 配置备份')
    if(!backup.subscriptions||!Array.isArray(backup.subscriptions.groups)||!Array.isArray(backup.subscriptions.feeds))throw new Error('备份缺少订阅数据')
    const groupIds=new Set<string>();for(const group of backup.subscriptions.groups){if(!group.id?.trim()||!group.name?.trim()||groupIds.has(group.id))throw new Error('备份包含无效或重复分组');groupIds.add(group.id)}
    const feedIds=new Set<string>();for(const feed of backup.subscriptions.feeds){if(!feed.id?.trim()||!feed.name?.trim()||!feed.url?.trim()||feedIds.has(feed.id)||!groupIds.has(feed.groupId))throw new Error(`备份包含无效订阅：${feed.name??''}`);fromAndroidSourceType(feed.sourceType);feedIds.add(feed.id)}
    const isLocalAccount = !this.accounts || this.accounts.current()?.type === 'local'
    validateDesktopGroupHierarchyBackup(backup.desktopGroupHierarchy, backup.subscriptions.groups, { isLocalAccount })
    backup.rssHubSubscriptions=validateRssHubDescriptors(backup.rssHubSubscriptions,feedIds)
    backup.rssHubDescriptors=validateRssHubDescriptors(backup.rssHubDescriptors,feedIds)
    if(backup.rssHubSourceUrls!==undefined){
      if(!backup.rssHubSourceUrls||typeof backup.rssHubSourceUrls!=='object'||Array.isArray(backup.rssHubSourceUrls))throw new Error('备份中的 RSSHub 来源映射无效')
      for(const [feedId,url] of Object.entries(backup.rssHubSourceUrls)){
        if(!feedIds.has(feedId)||typeof url!=='string'||!url.trim())throw new Error('备份中的 RSSHub 来源映射无效')
      }
    }
    normalizeDesktopSyncInterval(backup.accountSettings?.syncIntervalMinutes)
    readDesktopPreferences(backup.preferences)
    this.websiteRules.validateBackup(JSON.stringify(backup.websiteRules));this.jsonRules.validateBackup(JSON.stringify(backup.jsonRules));this.articleFilters.validateBackup(JSON.stringify(backup.articleFilters));this.websitePreferences.validateBackup(JSON.stringify(backup.websiteParsePreferences))
    validateJsonSubscriptionBackup(backup,this.jsonRules)
    validateRssHubBackup(backup.rssHub);validateTranslationBackup(backup.translation);validateAiBackup(backup.ai);this.validateLlmBackup(backup.llm);validateWebSearchBackup(backup.webSearch);this.validateMcpBackup(backup.mcp)
    this.validateEditionBackup(backup.editionConfiguration)
    return backup
  }

  private exportEditionConfiguration(reasoningEffort:string):unknown{
    if(!this.llmCustomization&&!this.webSearch&&!this.mcpRemote&&!this.llmSkills&&!this.llmQuickMessages)return undefined
    const search=this.webSearch?.exportStoredSettings()
    const saved=this.database?.prepare('SELECT value FROM app_settings WHERE key=?').get(EDITION_SETTINGS_KEY) as {value:string}|undefined
    const settings=saved?backupObject(JSON.parse(saved.value),'LLM settings'):{}
    return {
      schemaVersion:2,
      settings:{...settings,...this.llmCustomization?.current(),reasoningEffort,webSearchEnabled:search?.mode==='AUTO',webSearchMode:search?.mode??'OFF',mcpEnabled:this.mcpRemote?.current().servers.some(server=>server.enabled)??false},
      webSearch:search?{providers:search.providers,defaultProviderId:search.defaultProviderId,maxResults:search.maxResults}:{providers:[],defaultProviderId:null,maxResults:5},
      // Desktop keeps incomplete drafts in its own section; Android requires a real endpoint.
      mcpServers:this.mcpRemote?.exportBackupState().servers.filter(server=>server.url.trim()).map(server=>({id:server.id,name:server.name,endpoint:server.url,enabled:server.enabled,authType:server.authMode}))??[],
      ...(this.llmSkills?{skillState:convertSkillState(this.llmSkills.exportBackupState(),false)}:{}),
      ...(this.llmQuickMessages?{quickMessageState:this.llmQuickMessages.exportBackupState()}:{}),
    }
  }

  private validateEditionBackup(configuration:unknown,secrets?:unknown):ValidatedEditionBackup|undefined{
    if(configuration==null){
      if(secrets!=null)throw new Error('editionSecrets 存在，但备份缺少 editionConfiguration')
      return undefined
    }
    const edition=decodeEditionBackup(configuration,secrets)
    if(!this.webSearch&&edition.webSearch.providers.length)throw new Error('当前版本无法恢复 Web Search')
    if(!this.mcpRemote&&edition.remote.servers.length)throw new Error('当前版本无法恢复 Remote MCP')
    if(edition.skillState!==undefined){
      if(!this.llmSkills)throw new Error('当前版本无法恢复 Skills')
      this.llmSkills.validateBackupState(edition.skillState)
    }
    if(edition.quickMessageState!==undefined){
      if(!this.llmQuickMessages)throw new Error('当前版本无法恢复 Quick Messages')
      this.llmQuickMessages.validateBackupState(edition.quickMessageState)
    }
    this.mcpRemote?.validateBackupState(edition.remote,edition.secrets.mcpRemoteCredentials,edition.secrets.mcpRemoteOAuth)
    return edition
  }

  private validateLlmBackup(value:ConfigurationBackup['llm']):void{
    if(value===undefined)return
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份中的 AI 自定义配置无效')
    if(!this.llmSkills||!this.llmQuickMessages||!this.llmCustomization)throw new Error('当前版本无法恢复 AI 自定义配置')
    if(typeof value.customization?.skillsEnabled!=='boolean'||typeof value.customization?.customInstructions!=='string')throw new Error('备份中的 Custom Instructions 配置无效')
    normalizeLlmCustomizationSettingsPatch(value.customization)
    if(value.skills===undefined||value.quickMessages===undefined)throw new Error('备份缺少 Skills 或 Quick Messages')
    this.llmSkills.validateBackupState(JSON.stringify(value.skills))
    this.llmQuickMessages.validateBackupState(JSON.stringify(value.quickMessages))
  }

  private validateMcpBackup(value:McpBackup|undefined,secrets?:ConfigurationBackupSecrets):void{
    const hasMcpSecrets=Object.keys(secrets?.mcpRemoteCredentials??{}).length>0
      ||Object.keys(secrets?.mcpRemoteOAuth??{}).length>0
      ||Object.keys(secrets?.mcpLocalEnvironments??{}).length>0
    if(value===undefined){
      if(hasMcpSecrets)throw new Error('MCP 凭据存在，但备份缺少对应的 MCP 配置')
      return
    }
    if(!value||typeof value!=='object'||Array.isArray(value)||!value.remote||!value.local)throw new Error('备份中的 MCP 配置无效')
    if(!this.mcpRemote||!this.mcpLocal)throw new Error('当前版本无法恢复 MCP 配置')
    this.mcpRemote.validateBackupState(value.remote,secrets?.mcpRemoteCredentials,secrets?.mcpRemoteOAuth)
    this.mcpLocal.validateBackupState(value.local,secrets?.mcpLocalEnvironments)
  }

  private restoreSubscriptions(backup: ConfigurationBackup): {
    feedIdMap: Map<string, string>
    groupsAdded: number
    feedsAdded: number
    feedsUpdated: number
  } {
    const existingGroups = this.library.listGroups()
    const groupMap = new Map<string, string>()
    let groupsAdded = 0

    const isLocalAccount = !this.accounts || this.accounts.current()?.type === 'local'
    const hierarchy = validateDesktopGroupHierarchyBackup(
      backup.desktopGroupHierarchy,
      backup.subscriptions.groups,
      { isLocalAccount }
    )

    if (!isLocalAccount) {
      const feedIdMap = new Map<string, string>()
      let feedsUpdated = 0
      for (const source of backup.subscriptions.feeds) {
        // Lookup is scoped to the active account and compares normalized source URLs.
        const existing = this.library.findFeedByUrl(source.url.trim())
        if (!existing) continue
        this.library.upsertFeed({
          ...existing,
          isNotification: source.isNotification,
          isFullContent: source.isFullContent,
          isBrowser: source.isBrowser,
          updatedAt: Date.now()
        })
        feedIdMap.set(source.id, existing.id)
        feedsUpdated++
      }
      return { feedIdMap, groupsAdded: 0, feedsAdded: 0, feedsUpdated }
    }

    const defaultGroupId = this.library.getCurrentDefaultGroup().id
    if (hierarchy) {
      const defaultName = existingGroups.find(group => group.id === defaultGroupId)?.name.trim()
      if (hierarchy.orderedGroups.some(group => !group.isDefault && group.parentId === null && group.name.trim() === defaultName)) {
        throw new Error('备份分组名称与当前账户默认分组冲突，请更改名称后重试')
      }
      for (const source of hierarchy.orderedGroups) {
        if (source.isDefault) {
          groupMap.set(source.id, defaultGroupId)
          continue
        }

        const targetParentId = source.parentId ? (groupMap.get(source.parentId) ?? null) : null
        const normalizedSourceName = normalizeGroupName(source.name)
        let target = existingGroups.find(
          (g) =>
            !g.isDefault &&
            (g.parentId ?? null) === targetParentId &&
            normalizeGroupName(g.name) === normalizedSourceName
        )

        if (!target) {
          target = {
            id: `group-${randomUUID()}`,
            name: normalizedSourceName,
            parentId: targetParentId,
            sortOrder: existingGroups.length + groupsAdded + 1,
            isDefault: false
          }
          this.library.upsertGroup(target)
          existingGroups.push(target)
          groupsAdded++
        }

        groupMap.set(source.id, target.id)
      }
    } else {
      for (const source of backup.subscriptions.groups) {
        if (source.isDefault) {
          groupMap.set(source.id, defaultGroupId)
          continue
        }
        const normalizedSourceName = normalizeGroupName(source.name)
        const rootGroups = existingGroups.filter((g) => g.parentId == null)
        let target = findGroupByName(rootGroups, source.name)
        if (!target) {
          target = {
            id: `group-${randomUUID()}`,
            name: normalizedSourceName,
            parentId: null,
            sortOrder: existingGroups.length + groupsAdded + 1,
            isDefault: false
          }
          this.library.upsertGroup(target)
          existingGroups.push(target)
          groupsAdded++
        }
        groupMap.set(source.id, target.id)
      }
    }

    const feedIdMap = new Map<string, string>()
    let feedsAdded = 0,
      feedsUpdated = 0
    for (const source of backup.subscriptions.feeds) {
      const existing = this.library.findFeedByUrl(source.url.trim())
      const now = Date.now()
      const targetGroupId = groupMap.get(source.groupId) ?? defaultGroupId
      const feed: FeedRecord = existing
        ? {
            ...existing,
            name: source.name,
            icon: source.icon,
            groupId: targetGroupId,
            isNotification: source.isNotification,
            isFullContent: source.isFullContent,
            isBrowser: source.isBrowser,
            sourceType: fromAndroidSourceType(source.sourceType),
            updatedAt: now
          }
        : {
            id: `feed-${randomUUID()}`,
            name: source.name,
            url: source.url.trim(),
            sourcePageUrl: source.url.trim(),
            icon: source.icon,
            groupId: targetGroupId,
            isNotification: source.isNotification,
            isFullContent: source.isFullContent,
            isBrowser: source.isBrowser,
            sourceType: fromAndroidSourceType(source.sourceType),
            dynamicRendering: false,
            createdAt: now,
            updatedAt: now
          }
      this.library.upsertFeed(feed)
      feedIdMap.set(source.id, feed.id)
      existing ? feedsUpdated++ : feedsAdded++
    }
    return { feedIdMap, groupsAdded, feedsAdded, feedsUpdated }
  }
  private restoreTranslation(value:TranslationBackup,keys?:Partial<Record<TranslationProviderType,string>>):void{const fallback=TRANSLATION_PROVIDER_TYPES.includes(value.defaultProvider as TranslationProviderType)?value.defaultProvider as TranslationProviderType:'ML_KIT';this.translation.restore({defaultProvider:fallback,defaultTarget:backupTargetToTranslationTarget(value.defaultTarget,fallback),targetLanguage:value.targetLanguage,displayMode:value.displayMode,providers:TRANSLATION_PROVIDER_TYPES.map((type)=>{const source=value.providers.find((item)=>item.type===type);return{type,enabled:source?.enabled??type==='ML_KIT',endpoint:source?.endpoint??'',region:source?.region??''}})},keys)}
  private restoreAi(value:AiBackup,keys?:Record<string,string>):void{this.ai.restore({enabled:value.enabled,defaultProviderId:value.defaultProviderId,outputLanguage:value.outputLanguage,summaryLength:value.summaryLength,reasoningEffort:value.reasoningEffort??'AUTO',providers:value.providers.map((provider)=>({...provider}))},keys)}
}

function toBackupFeed(feed:FeedRecord){return{id:feed.id,name:feed.name,icon:feed.icon,url:feed.url,groupId:feed.groupId,isNotification:feed.isNotification,isFullContent:feed.isFullContent,isBrowser:feed.isBrowser,sourceType:toAndroidSourceType(feed.sourceType)}}
function toAndroidSourceType(type:SourceType):string{return type==='rss'?'RSS':type==='website'?'WEBSITE':'JSON'}
function fromAndroidSourceType(value:string):SourceType{switch(value.toUpperCase()){case'RSS':return'rss';case'WEBSITE':return'website';case'JSON':return'json';default:throw new Error(`不支持的来源类型：${value}`)}}
function normalizeDesktopSyncInterval(value:number){const allowed=[0,15,30,60,120,180,360,720,1440] as const;if(!allowed.includes(value as typeof allowed[number]))throw new Error(`不支持的同步间隔：${value}`);return value as typeof allowed[number]}
function toTranslationBackup(value:ReturnType<TranslationSettingsRepository['current']>):TranslationBackup{return{defaultProvider:value.defaultProvider,defaultTarget:value.defaultTarget.type==='traditional'?{type:'traditional',provider:value.defaultTarget.provider}:{type:'ai',providerId:value.defaultTarget.providerId,providerName:value.defaultTarget.providerName,model:value.defaultTarget.model},targetLanguage:value.targetLanguage,displayMode:value.displayMode,providers:value.providers.map((provider)=>({type:provider.type,enabled:provider.enabled,endpoint:provider.endpoint,region:provider.region}))}}
function toAiBackup(value:ReturnType<AiSettingsRepository['current']>):AiBackup{return{enabled:value.enabled,defaultProviderId:value.defaultProviderId,outputLanguage:value.outputLanguage,summaryLength:value.summaryLength,reasoningEffort:value.reasoningEffort??'AUTO',providers:value.providers.map(({hasApiKey:_ignored,apiKeyLength:_length,...provider})=>provider)}}
function desktopPreferences(settings:ReturnType<SettingsRepository['current']>):Record<string,unknown>{return{
  'origread.desktop.language':settings.language,
  'origread.desktop.theme':settings.theme,
  'origread.desktop.uiFontScale':settings.uiFontScale,
  'origread.desktop.showArticleThumbnails':settings.showArticleThumbnails,
  'origread.desktop.showArticleSummaries':settings.showArticleSummaries,
  'origread.desktop.layoutMode':settings.layoutMode,
  'origread.desktop.workspaceCollapsed':settings.workspaceCollapsed,
  'origread.desktop.workspaceWidth':settings.workspaceWidth,
  'origread.desktop.sourcePaneWidth':settings.sourcePaneWidth,
  'origread.desktop.articlePaneWidth':settings.articlePaneWidth,
  'origread.desktop.sourcePaneCollapsed':settings.sourcePaneCollapsed,
  'origread.desktop.articlePaneCollapsed':settings.articlePaneCollapsed,
  'origread.desktop.readerFontSize':settings.readerFontSize,
  'origread.desktop.readerLineHeight':settings.readerLineHeight,
  'origread.desktop.readerContentWidth':settings.readerContentWidth,
  'origread.desktop.readerIndentParagraphs':settings.readerIndentParagraphs,
  'origread.desktop.readerBackground':settings.readerBackground,
  'origread.desktop.readerBackgroundCustom':settings.readerBackgroundCustom,
  'origread.desktop.aiSummaryPlacement':settings.aiSummaryPlacement,
  'origread.desktop.aiSummaryPanelSize':settings.aiSummaryPanelSize,
  'origread.desktop.autoCheckUpdates':settings.autoCheckUpdates
}}
function readDesktopPreferences(value:Record<string,unknown>|null|undefined):Partial<ReturnType<SettingsRepository['current']>>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份中的 preferences 必须是 JSON 对象')
  // 旧备份缺少界面字号、缩略图或布局字段时恢复默认值，不继承目标机器的显示偏好。
  const result:Record<string,unknown>={
    uiFontScale:DEFAULT_DESKTOP_SETTINGS.uiFontScale,
    showArticleThumbnails:DEFAULT_DESKTOP_SETTINGS.showArticleThumbnails,
    showArticleSummaries:DEFAULT_DESKTOP_SETTINGS.showArticleSummaries,
    layoutMode:DEFAULT_DESKTOP_SETTINGS.layoutMode,
    sourcePaneWidth:DEFAULT_DESKTOP_SETTINGS.sourcePaneWidth,
    articlePaneWidth:DEFAULT_DESKTOP_SETTINGS.articlePaneWidth,
    sourcePaneCollapsed:DEFAULT_DESKTOP_SETTINGS.sourcePaneCollapsed,
    articlePaneCollapsed:DEFAULT_DESKTOP_SETTINGS.articlePaneCollapsed,
    readerIndentParagraphs:DEFAULT_DESKTOP_SETTINGS.readerIndentParagraphs
  }
  const language=value['origread.desktop.language'];if(language!==undefined){if(language!=='system'&&!isDesktopLanguage(language))throw new Error('备份中的 Desktop 语言设置无效');result.language=language}
  const theme=value['origread.desktop.theme'];if(theme!==undefined){if(!['system','light','dark'].includes(String(theme)))throw new Error('备份中的 Desktop 主题设置无效');result.theme=theme}
  const uiFontScale=value['origread.desktop.uiFontScale'];if(uiFontScale!==undefined){if(!isUiFontScale(uiFontScale))throw new Error('备份中的 Desktop 界面字号设置无效');result.uiFontScale=uiFontScale}
  const thumbnails=value['origread.desktop.showArticleThumbnails'];if(thumbnails!==undefined){if(typeof thumbnails!=='boolean')throw new Error('备份中的 Desktop 文章缩略图设置类型无效');result.showArticleThumbnails=thumbnails}
  const summaries=value['origread.desktop.showArticleSummaries'];if(summaries!==undefined){if(typeof summaries!=='boolean')throw new Error('备份中的 Desktop 文章摘要设置类型无效');result.showArticleSummaries=summaries}
  const indent=value['origread.desktop.readerIndentParagraphs'];if(indent!==undefined){if(typeof indent!=='boolean')throw new Error('备份中的 Desktop 段落缩进设置类型无效');result.readerIndentParagraphs=indent}
  const layoutMode=value['origread.desktop.layoutMode'];if(layoutMode!==undefined){if(layoutMode!=='two-pane'&&layoutMode!=='three-pane')throw new Error('备份中的 Desktop 布局设置无效');result.layoutMode=layoutMode}
  const collapsed=value['origread.desktop.workspaceCollapsed'];if(collapsed!==undefined){if(typeof collapsed!=='boolean')throw new Error('备份中的 Desktop 侧栏设置类型无效');result.workspaceCollapsed=collapsed}
  const sourceCollapsed=value['origread.desktop.sourcePaneCollapsed'];if(sourceCollapsed!==undefined){if(typeof sourceCollapsed!=='boolean')throw new Error('备份中的 Desktop Source Pane 折叠设置类型无效');result.sourcePaneCollapsed=sourceCollapsed}
  const articleCollapsed=value['origread.desktop.articlePaneCollapsed'];if(articleCollapsed!==undefined){if(typeof articleCollapsed!=='boolean')throw new Error('备份中的 Desktop Article Pane 折叠设置类型无效');result.articlePaneCollapsed=articleCollapsed}
  const readerBackground=value['origread.desktop.readerBackground'];if(readerBackground!==undefined){if(!['theme','paper','warm','sepia','mint','custom'].includes(String(readerBackground)))throw new Error('备份中的阅读背景设置无效');result.readerBackground=readerBackground}
  const readerBackgroundCustom=value['origread.desktop.readerBackgroundCustom'];if(readerBackgroundCustom!==undefined){if(typeof readerBackgroundCustom!=='string'||!/^#[0-9a-fA-F]{6}$/.test(readerBackgroundCustom))throw new Error('备份中的自定义阅读背景颜色无效');result.readerBackgroundCustom=readerBackgroundCustom.toLowerCase()}
  const placement=value['origread.desktop.aiSummaryPlacement'];if(placement!==undefined){if(!['replace','left','right','top','bottom'].includes(String(placement)))throw new Error('备份中的 AI 摘要位置无效');result.aiSummaryPlacement=normalizeAiSummaryPlacement(placement)}
  const autoCheckUpdates=value['origread.desktop.autoCheckUpdates'];if(autoCheckUpdates!==undefined){if(typeof autoCheckUpdates!=='boolean')throw new Error('备份中的自动检查更新设置类型无效');result.autoCheckUpdates=autoCheckUpdates}
  for(const [key,target] of [['origread.desktop.workspaceWidth','workspaceWidth'],['origread.desktop.sourcePaneWidth','sourcePaneWidth'],['origread.desktop.articlePaneWidth','articlePaneWidth'],['origread.desktop.readerFontSize','readerFontSize'],['origread.desktop.readerLineHeight','readerLineHeight'],['origread.desktop.readerContentWidth','readerContentWidth'],['origread.desktop.aiSummaryPanelSize','aiSummaryPanelSize']] as const){const candidate=value[key];if(candidate!==undefined){if(typeof candidate!=='number'||!Number.isFinite(candidate))throw new Error(`备份中的 ${key} 类型无效`);result[target]=candidate}}
  return result as Partial<ReturnType<SettingsRepository['current']>>
}
function validateRssHubDescriptors(
  value: unknown,
  feedIds: Set<string>
): Record<string, RssHubSubscriptionDescriptor> | undefined {
  if(value===undefined)return undefined
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份中的 RSSHub 订阅描述无效')
  return Object.fromEntries(Object.entries(value).map(([feedId,raw])=>{
    if(!feedIds.has(feedId)||!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('备份中的 RSSHub 订阅描述无效')
    const descriptor=raw as Partial<RssHubSubscriptionDescriptor>
    if(typeof descriptor.originalInput!=='string'||!descriptor.originalInput.trim())throw new Error('备份中的 RSSHub 订阅描述无效')
    for(const field of ['routePath','preferredInstance','lastResolvedInstance','lastResolvedUrl'] as const){
      const fieldValue=descriptor[field]
      if(fieldValue!=null&&typeof fieldValue!=='string')throw new Error('备份中的 RSSHub 路由或实例信息无效')
    }
    const routePath=descriptor.routePath==null?null:normalizeRssHubRoutePath(descriptor.routePath)
    if(descriptor.routePath!=null&&!routePath)throw new Error('备份中的 RSSHub 路由无效')
    return [feedId,{
      originalInput:descriptor.originalInput.trim(),
      routePath,
      preferredInstance:descriptor.preferredInstance??null,
      lastResolvedInstance:descriptor.lastResolvedInstance??null,
      lastResolvedUrl:descriptor.lastResolvedUrl??null
    }]
  }))
}

function validateRssHubBackup(value:RssHubBackup):void{
  if(!value||typeof value.enabled!=='boolean'||!Array.isArray(value.instances))throw new Error('备份中的 RSSHub 配置无效')
  const urls=new Set<string>()
  for(const instance of value.instances){
    if(!instance||!String(instance.id??'').trim()||!String(instance.url??'').trim())throw new Error('备份包含无效 RSSHub 实例')
    let normalized='';try{const url=new URL(instance.url);if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error();url.hash='';url.search='';normalized=url.toString().replace(/\/+$/,'')}catch{throw new Error(`备份包含无效 RSSHub 实例地址：${instance.url}`)}
    if(urls.has(normalized))throw new Error(`备份包含重复 RSSHub 实例：${normalized}`);urls.add(normalized)
  }
}
function validateTranslationBackup(value:TranslationBackup):void{
  if(!value||!Array.isArray(value.providers)||!String(value.targetLanguage??'').trim())throw new Error('备份中的翻译配置无效')
  if(!TRANSLATION_PROVIDER_TYPES.includes(value.defaultProvider as TranslationProviderType))throw new Error(`备份包含未知默认翻译 Provider：${value.defaultProvider}`)
  if(value.displayMode!=='TRANSLATED'&&value.displayMode!=='BILINGUAL')throw new Error(`备份包含未知翻译显示模式：${value.displayMode}`)
  const providerTypes=new Set<string>()
  for(const provider of value.providers){if(!TRANSLATION_PROVIDER_TYPES.includes(provider.type as TranslationProviderType))throw new Error(`备份包含未知翻译 Provider：${provider.type}`);if(providerTypes.has(provider.type))throw new Error(`备份包含重复翻译 Provider：${provider.type}`);providerTypes.add(provider.type)}
  if(value.defaultTarget.type==='traditional'){if(!value.defaultTarget.provider||!TRANSLATION_PROVIDER_TYPES.includes(value.defaultTarget.provider as TranslationProviderType))throw new Error('备份中的传统翻译目标无效')}
  else if(value.defaultTarget.type==='ai'){if(!value.defaultTarget.providerId?.trim()||!value.defaultTarget.model?.trim())throw new Error('备份中的 AI 翻译目标无效')}
  else throw new Error(`备份包含未知翻译目标类型：${String(value.defaultTarget.type)}`)
}
function validateAiBackup(value:AiBackup):void{
  if(!value||!Array.isArray(value.providers)||value.providers.length===0)throw new Error('备份中的 AI 配置无效')
  if(!['BRIEF','STANDARD','DETAILED'].includes(value.summaryLength))throw new Error(`备份中的 AI 摘要长度无效：${value.summaryLength}`)
  if(value.reasoningEffort!==undefined&&!['AUTO','MINIMAL','LOW','MEDIUM','HIGH','MAXIMUM'].includes(value.reasoningEffort))throw new Error(`备份中的模型推理强度无效：${value.reasoningEffort}`)
  const ids=new Set<string>()
  const capabilityModes=new Set(['AUTO','ENABLED','DISABLED'])
  const outputTokenStyles=new Set(['AUTO','MAX_TOKENS','MAX_COMPLETION_TOKENS'])
  for(const provider of value.providers){
    if(!provider.id?.trim()||!provider.endpoint?.trim())throw new Error('备份包含无效 AI Provider')
    if(ids.has(provider.id))throw new Error(`备份包含重复 AI Provider：${provider.id}`)
    ids.add(provider.id)
    for(const mode of [provider.streamingCapabilityOverride,provider.toolCallingCapabilityOverride,provider.reasoningCapabilityOverride]){
      if(mode!==undefined&&!capabilityModes.has(mode))throw new Error(`备份包含无效 AI Provider 能力设置：${mode}`)
    }
    if(provider.outputTokenLimitStyle!==undefined&&!outputTokenStyles.has(provider.outputTokenLimitStyle))throw new Error(`备份包含无效 AI 输出 token 设置：${provider.outputTokenLimitStyle}`)
    if(provider.contextWindowTokens!==undefined&&(!Number.isInteger(provider.contextWindowTokens)||provider.contextWindowTokens<4096||provider.contextWindowTokens>4_000_000))throw new Error(`备份包含无效 AI 上下文窗口：${provider.contextWindowTokens}`)
    if(provider.strictStreamTermination!==undefined&&typeof provider.strictStreamTermination!=='boolean')throw new Error('备份包含无效 AI 流式结束设置')
  }
  if(!ids.has(value.defaultProviderId))throw new Error('备份中的默认 AI Provider 不存在')
}

function validateWebSearchBackup(value:WebSearchBackup|undefined):void{
  if(value===undefined)return
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.providers))throw new Error('备份中的 Web Search 配置无效')
  if(value.mode!=='OFF'&&value.mode!=='AUTO')throw new Error(`备份包含未知 Web Search 模式：${String(value.mode)}`)
  if(!Number.isInteger(value.maxResults)||value.maxResults<MIN_WEB_SEARCH_MAX_RESULTS||value.maxResults>MAX_WEB_SEARCH_MAX_RESULTS)throw new Error('备份中的 Web Search 结果数量无效')
  const ids=new Set<string>()
  for(const provider of value.providers){
    if(!provider||typeof provider.id!=='string'||!provider.id.trim()||typeof provider.name!=='string'||!provider.name.trim()||typeof provider.enabled!=='boolean')throw new Error('备份包含无效 Web Search Provider')
    if(ids.has(provider.id))throw new Error(`备份包含重复 Web Search Provider：${provider.id}`)
    ids.add(provider.id)
    if(!WEB_SEARCH_PROVIDER_KINDS.includes(provider.kind))throw new Error(`备份包含未知 Web Search Provider：${String(provider.kind)}`)
    try{const endpoint=new URL(provider.endpoint);if(endpoint.protocol!=='http:'&&endpoint.protocol!=='https:')throw new Error()}catch{throw new Error(`备份包含无效 Web Search Endpoint：${provider.endpoint}`)}
  }
  if(value.defaultProviderId!==null&&!ids.has(value.defaultProviderId))throw new Error('备份中的默认 Web Search Provider 不存在')
}

function validateWebSearchSecretReferences(value:WebSearchBackup|undefined,keys:Record<string,string>|undefined):void{
  if(keys===undefined)return
  const providerIds=new Set(value?.providers.map((provider)=>provider.id)??[])
  for(const providerId of Object.keys(keys)){
    if(!providerIds.has(providerId))throw new Error('Web Search 凭据引用了不存在的 Provider')
  }
}

interface ValidatedEditionBackup {
  settings:Record<string,unknown>
  customization:LlmCustomizationSettings
  webSearch:WebSearchBackup
  remote:McpBackup['remote']
  skillState?:string
  quickMessageState?:string
  secrets:ConfigurationBackupSecrets
}

function backupObject(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`备份中的 ${label} 必须是对象`)
  return value as Record<string,unknown>
}

function backupString(value:unknown,label:string,allowEmpty=false):string{
  if(typeof value!=='string'||(!allowEmpty&&!value.trim())||value.includes('\0'))throw new Error(`备份中的 ${label} 无效`)
  return value
}

function backupStringMap(value:unknown,label:string):Record<string,string>{
  return Object.fromEntries(Object.entries(backupObject(value,label)).map(([key,item])=>[key,backupString(item,label,true)]))
}

function backupDefault(value:unknown,fallback:unknown):unknown{
  return value===undefined?fallback:value
}

function decodeEditionBackup(value:unknown,rawSecrets?:unknown):ValidatedEditionBackup{
  const root=backupObject(value,'editionConfiguration')
  const version=backupDefault(root.schemaVersion,2)
  if(version!==1&&version!==2)throw new Error('不支持的 LLM 配置备份版本')
  const settings=backupObject(backupDefault(root.settings,{}),'LLM settings')
  for(const key of ['assistantEnabled','continueGenerationInBackground','defaultGenerateSummary','advancedAiConfigEnabled','streamResponses','showReasoning','skillsEnabled','webSearchEnabled','mcpEnabled']){
    if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw new Error(`LLM ${key} 无效`)
  }
  const context=backupDefault(settings.contextMaxTokens,128_000)
  if(!Number.isInteger(context)||Number(context)<4096||Number(context)>4_000_000)throw new Error('LLM Context 长度超出支持范围')
  if(!['AUTO','MINIMAL','LOW','MEDIUM','HIGH','MAXIMUM'].includes(String(backupDefault(settings.reasoningEffort,'AUTO'))))throw new Error('LLM reasoningEffort 无效')
  const mode=backupDefault(settings.webSearchMode,'AUTO')
  if(!['OFF','AUTO','FORCE'].includes(String(mode)))throw new Error('LLM Web Search 模式无效')
  const customization={skillsEnabled:backupDefault(settings.skillsEnabled,false),customInstructions:backupDefault(settings.customInstructions,'')} as LlmCustomizationSettings
  normalizeLlmCustomizationSettingsPatch(customization)
  const search=backupObject(backupDefault(root.webSearch,{}),'LLM Web Search')
  const webSearch={providers:backupDefault(search.providers,[]),defaultProviderId:search.defaultProviderId??null,maxResults:backupDefault(search.maxResults,5),mode:settings.webSearchEnabled===true&&mode!=='OFF'?'AUTO':'OFF'} as WebSearchBackup
  validateWebSearchBackup(webSearch)
  const servers=backupDefault(root.mcpServers,[])
  if(!Array.isArray(servers))throw new Error('MCP Server 列表无效')
  const ids=new Set<string>()
  const remote:McpBackup['remote']={servers:servers.map(item=>{
    const server=backupObject(item,'MCP Server')
    const id=backupString(server.id,'MCP Server ID')
    if(ids.has(id.trim()))throw new Error('MCP 备份包含重复 Server ID')
    ids.add(id.trim())
    const endpoint=backupString(server.endpoint,'MCP endpoint')
    if(typeof server.enabled!=='boolean'||!MCP_REMOTE_AUTH_MODES.includes(server.authType as typeof MCP_REMOTE_AUTH_MODES[number]))throw new Error('MCP Server 配置无效')
    return {id,name:backupString(server.name,'MCP name'),url:endpoint,enabled:server.enabled,transport:'STREAMABLE_HTTP',authMode:server.authType as typeof MCP_REMOTE_AUTH_MODES[number],oauthScopes:''}
  })}
  const secrets:ConfigurationBackupSecrets={translationApiKeys:{},aiApiKeys:{}}
  if(rawSecrets!=null){
    const secret=backupObject(rawSecrets,'editionSecrets')
    secrets.webSearchApiKeys=backupStringMap(backupDefault(secret.webSearchApiKeys,{}),'Web Search API keys')
    validateWebSearchSecretReferences(webSearch,secrets.webSearchApiKeys)
    secrets.mcpRemoteCredentials={}
    secrets.mcpRemoteOAuth={}
    for(const [id,raw] of Object.entries(backupObject(backupDefault(secret.mcpServers,{}),'MCP secrets'))){
      const server=remote.servers.find(server=>server.id===id)
      if(!server)throw new Error('MCP 凭据引用了不存在的 Server')
      const credential=backupObject(raw,'MCP credentials')
      const bearer=backupString(backupDefault(credential.bearerToken,''),'MCP bearerToken',true)
      const headers=backupStringMap(backupDefault(credential.customHeaders,{}),'MCP customHeaders')
      for(const [name,header] of Object.entries(headers)){
        if(!name.trim()||/[\r\n]/.test(name+header))throw new Error('MCP customHeaders 无效')
      }
      const config=credential.oauthClientConfig==null?undefined:decodeOAuthClient(credential.oauthClientConfig,false)
      const registration=credential.oauthRegistration==null?undefined:decodeOAuthClient(credential.oauthRegistration,true)
      const token=credential.oauthTokenSet==null?undefined:decodeOAuthToken(credential.oauthTokenSet)
      const pending=backupDefault(credential.oauthPendingScopes,[])
      if(!Array.isArray(pending)||pending.some(scope=>typeof scope!=='string'))throw new Error('MCP OAuth scopes 无效')
      if(registration&&token&&registration.issuer!==token.issuer)throw new Error('MCP OAuth issuer 不一致')
      if(server.authMode==='BEARER'&&bearer)secrets.mcpRemoteCredentials[id]=bearer
      if(server.authMode==='CUSTOM_HEADERS'&&Object.keys(headers).length)secrets.mcpRemoteCredentials[id]=Object.entries(headers).map(([name,header])=>`${name}: ${header}`).join('\n')
      if(server.authMode==='OAUTH'){
        server.oauthScopes=[...new Set(pending.map(scope=>scope.trim()).filter(Boolean))].join(' ')
        const oauth:McpRemoteOAuthBackupSecrets={}
        const client=registration??config
        if(client)oauth.client=JSON.stringify({issuer:registration?.issuer??token?.issuer??null,...(config?{editionClientConfig:config}:{}),value:{client_id:client.clientId,client_secret:client.clientSecret,token_endpoint_auth_method:client.authMethod.toLowerCase(),issuer:registration?.issuer??token?.issuer}})
        if(token)oauth.tokens=JSON.stringify({issuer:token.issuer,value:{access_token:token.accessToken,refresh_token:token.refreshToken,token_type:token.tokenType,scope:token.scope,expires_at:token.expiresAtEpochMs,issuer:token.issuer}})
        // Only these two allowlisted envelopes cross the boundary. Never import discovery.
        if(Object.keys(oauth).length)secrets.mcpRemoteOAuth[id]=oauth
      }
    }
  }
  const portableSettings=Object.fromEntries(['assistantEnabled','continueGenerationInBackground','defaultGenerateSummary','advancedAiConfigEnabled','reasoningEffort','streamResponses','showReasoning','contextMaxTokens','customInstructions','skillsEnabled','webSearchEnabled','webSearchMode','mcpEnabled'].filter(key=>settings[key]!==undefined).map(key=>[key,settings[key]]))
  return {
    settings:portableSettings,customization,webSearch,remote,secrets,
    ...(root.skillState==null?{}:{skillState:convertSkillState(backupString(root.skillState,'skillState'),true)}),
    ...(root.quickMessageState==null?{}:{quickMessageState:backupString(root.quickMessageState,'quickMessageState')}),
  }
}

function decodeOAuthClient(value:unknown,registration:boolean){
  const client=backupObject(value,'MCP OAuth client')
  const authMethod=backupDefault(client.authMethod,'NONE')
  if(!['NONE','CLIENT_SECRET_POST','CLIENT_SECRET_BASIC'].includes(String(authMethod)))throw new Error('MCP OAuth authMethod 无效')
  return {clientId:backupString(backupDefault(client.clientId,''),'MCP OAuth clientId',!registration),clientSecret:backupString(backupDefault(client.clientSecret,''),'MCP OAuth clientSecret',true),authMethod:String(authMethod),...(registration?{issuer:oauthIssuer(client.issuer)}:{})}
}

function oauthIssuer(value:unknown):string{
  const issuer=backupString(value,'MCP OAuth issuer')
  const url=new URL(issuer)
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new Error('MCP OAuth issuer 无效')
  assertRemoteServerTransportPolicy(issuer,'OAUTH')
  return issuer
}

function decodeOAuthToken(value:unknown){
  const token=backupObject(value,'MCP OAuth Token')
  const tokenType=backupString(backupDefault(token.tokenType,'Bearer'),'MCP OAuth tokenType')
  if(tokenType.toLowerCase()!=='bearer')throw new Error('MCP OAuth Token 类型不受支持')
  const expires=backupDefault(token.expiresAtEpochMs,Number.MAX_SAFE_INTEGER)
  if(typeof expires!=='number'||!Number.isFinite(expires)||!Number.isInteger(expires)||expires<0)throw new Error('MCP OAuth expiresAtEpochMs 无效')
  return {issuer:oauthIssuer(token.issuer),accessToken:backupString(token.accessToken,'MCP OAuth accessToken'),refreshToken:backupString(backupDefault(token.refreshToken,''),'MCP OAuth refreshToken',true),tokenType,scope:backupString(backupDefault(token.scope,''),'MCP OAuth scope',true),expiresAtEpochMs:Math.min(expires,Number.MAX_SAFE_INTEGER)}
}

function convertSkillState(raw:string,toDesktop:boolean):string{
  const state=backupObject(JSON.parse(raw),'skillState')
  const bindings=backupObject(state.bindings,'Skill bindings')
  const mapped:Record<string,unknown>={}
  for(const name of ['summary','translation','chat','articleAnalysis']){
    mapped[toDesktop?`${name}SkillId`:name]=bindings[toDesktop?name:`${name}SkillId`]??null
  }
  return JSON.stringify({...state,bindings:mapped})
}

function hasEditionSecrets(value:unknown):boolean{
  if(value===undefined)return false
  const secret=backupObject(value,'editionSecrets')
  return Object.keys(backupObject(secret.webSearchApiKeys??{},'Web Search keys')).length>0||Object.keys(backupObject(secret.mcpServers??{},'MCP secrets')).length>0
}

function exportEditionSecrets(secrets:ConfigurationBackupSecrets,remote?:McpBackup['remote']):unknown{
  const servers:Record<string,unknown>={}
  const portableIds=new Set(remote?.servers.filter(server=>server.url.trim()).map(server=>server.id)??[])
  for(const [id,credential] of Object.entries(secrets.mcpRemoteCredentials??{})){
    if(!portableIds.has(id))continue
    if(remote?.servers.find(server=>server.id===id)?.authMode==='CUSTOM_HEADERS'){
      const headers=Object.fromEntries(credential.split(/\r?\n/).filter(line=>line.trim()).map(line=>{
        const colon=line.indexOf(':'),equals=line.indexOf('=')
        const separator=colon>=0&&(equals<0||colon<equals)?colon:equals
        if(separator<=0)throw new Error('MCP Custom Header 格式无效')
        return [line.slice(0,separator).trim(),line.slice(separator+1).trim()]
      }))
      servers[id]={customHeaders:headers}
    }else servers[id]={bearerToken:credential}
  }
  for(const [id,oauth] of Object.entries(secrets.mcpRemoteOAuth??{})){
    if(!portableIds.has(id))continue
    const saved:Record<string,unknown>={}
    if(oauth.client){
      const envelope=backupObject(JSON.parse(oauth.client),'MCP OAuth client envelope')
      const client=backupObject(envelope.value,'MCP OAuth client')
      const config={clientId:client.client_id??'',clientSecret:client.client_secret??'',authMethod:String(client.token_endpoint_auth_method??'none').toUpperCase()}
      saved.oauthClientConfig=envelope.editionClientConfig??config
      if(envelope.issuer)saved.oauthRegistration={...config,issuer:envelope.issuer}
    }
    if(oauth.tokens){
      const envelope=backupObject(JSON.parse(oauth.tokens),'MCP OAuth token envelope')
      const tokens=backupObject(envelope.value,'MCP OAuth tokens')
      // JS rounds Kotlin Long.MAX_VALUE past the Long range. Keep infinite lifetimes
      // safely representable on both ends instead of emitting an overflowing Android Long.
      saved.oauthTokenSet={issuer:envelope.issuer,accessToken:tokens.access_token,refreshToken:tokens.refresh_token??'',tokenType:tokens.token_type??'Bearer',scope:tokens.scope??'',expiresAtEpochMs:Math.min(Number(tokens.expires_at??Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER)}
    }
    servers[id]=saved
  }
  for(const server of remote?.servers??[]){
    if(portableIds.has(server.id)&&server.authMode==='OAUTH'&&server.oauthScopes){
      servers[server.id]={...(servers[server.id] as Record<string,unknown>??{}),oauthPendingScopes:server.oauthScopes.split(/\s+/).filter(Boolean)}
    }
  }
  return {webSearchApiKeys:secrets.webSearchApiKeys??{},mcpServers:servers}
}

