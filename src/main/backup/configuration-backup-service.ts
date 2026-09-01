import { randomUUID } from 'node:crypto'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import type { LibraryRepository } from '../database/library-repository'
import type { SettingsRepository } from '../database/settings-repository'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import type { TranslationSettingsRepository } from '../translation/translation-settings-repository'
import type { ConfigurationBackup,ConfigurationBackupSecrets,ConfigurationRestoreResult,TranslationBackup,AiBackup,RssHubBackup,WebSearchBackup } from '../../shared/configuration-backup'
import { backupTargetToTranslationTarget } from '../../shared/configuration-backup'
import type { FeedRecord,GroupRecord,SourceType } from '../../shared/library'
import type { TranslationProviderType } from '../../shared/translation'
import { TRANSLATION_PROVIDER_TYPES } from '../../shared/translation'
import { decryptConfigurationSecrets,encryptConfigurationSecrets } from './configuration-backup-crypto'
import type { AccountRepository } from '../accounts/account-repository'
import { DEFAULT_DESKTOP_SETTINGS, normalizeAiSummaryPlacement } from '../../shared/settings'
import type { LlmSkillRepository } from '../llm/skill-repository'
import type { LlmQuickMessageRepository } from '../llm/quick-message-repository'
import type { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { normalizeLlmCustomizationSettingsPatch } from '../../shared/llm-customization'
import type { WebSearchRepository } from '../search/web-search-repository'
import { MAX_WEB_SEARCH_MAX_RESULTS, MIN_WEB_SEARCH_MAX_RESULTS, WEB_SEARCH_PROVIDER_KINDS } from '../../shared/web-search'

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
    private readonly webSearch?:WebSearchRepository
  ){}

  exportBackup(password=''):string{
    const groups=this.library.listGroups(),feeds=this.library.listFeeds(),settings=this.desktopSettings.current(),translation=this.translation.current(),ai=this.ai.current(),account=this.accounts?.current()
    const secrets:ConfigurationBackupSecrets={
      translationApiKeys:Object.fromEntries(TRANSLATION_PROVIDER_TYPES.map((type)=>[type,this.translation.getApiKey(type)]).filter(([,value])=>Boolean(value))) as Partial<Record<TranslationProviderType,string>>,
      aiApiKeys:Object.fromEntries(ai.providers.map((provider)=>[provider.id,this.ai.getApiKey(provider.id)]).filter(([,value])=>Boolean(value))),
      ...(this.webSearch?{webSearchApiKeys:this.webSearch.exportApiKeys()}:{})
    }
    const hasSecrets=Object.keys(secrets.translationApiKeys).length>0||Object.keys(secrets.aiApiKeys).length>0||Object.keys(secrets.webSearchApiKeys??{}).length>0
    const includeSecrets=Boolean(password)
    if(includeSecrets&&password.length<6)throw new Error('备份密码至少需要 6 个字符')
    const backup:ConfigurationBackup={
      schemaVersion:1,appName:'OrigRead',sourceVersion:this.appVersion,createdAtEpochMillis:Date.now(),preferences:desktopPreferences(settings),
      accountSettings:{syncIntervalMinutes:account?.syncIntervalMinutes??settings.syncIntervalMinutes,syncOnStart:account?.syncOnStart??settings.syncOnStart,syncOnlyOnWiFi:account?.syncOnlyOnWiFi??false,syncOnlyWhenCharging:account?.syncOnlyWhenCharging??false,keepArchivedMillis:account?.keepArchivedMillis??2_592_000_000,syncBlockList:account?.syncBlockList??[]},
      subscriptions:{sourceAccountId:account?.id??1,groups:groups.map((group)=>({id:group.id,name:group.name,isDefault:group.isDefault})),feeds:feeds.map(toBackupFeed)},
      websiteRules:JSON.parse(this.websiteRules.exportRules()),jsonRules:JSON.parse(this.jsonRules.exportRules()),articleFilters:JSON.parse(this.articleFilters.exportRules()),websiteParsePreferences:JSON.parse(this.websitePreferences.exportBackup(new Set(feeds.map((feed)=>feed.id)))),
      rssHub:this.rssHub.current(),rssHubSourceUrls:this.library.listRssHubSourceUrls(),translation:toTranslationBackup(translation),ai:toAiBackup(ai),
      ...(this.llmSkills&&this.llmQuickMessages&&this.llmCustomization?{llm:{customization:this.llmCustomization.current(),skills:JSON.parse(this.llmSkills.exportBackupState()),quickMessages:JSON.parse(this.llmQuickMessages.exportBackupState())}}:{}),
      ...(this.webSearch?{webSearch:this.webSearch.exportStoredSettings()}:{}),
      encryptedSecrets:includeSecrets&&hasSecrets?encryptConfigurationSecrets(secrets,password):null
    }
    return JSON.stringify(backup,null,2)
  }

  inspect(content:string):{sourceVersion:string;createdAtEpochMillis:number;feeds:number;groups:number;hasEncryptedSecrets:boolean}{const backup=this.decodeAndValidate(content);return{sourceVersion:backup.sourceVersion,createdAtEpochMillis:backup.createdAtEpochMillis,feeds:backup.subscriptions.feeds.length,groups:backup.subscriptions.groups.length,hasEncryptedSecrets:Boolean(backup.encryptedSecrets)}}

  restoreBackup(content:string,password=''):ConfigurationRestoreResult{
    const backup=this.decodeAndValidate(content)
    const secrets=backup.encryptedSecrets?decryptConfigurationSecrets(backup.encryptedSecrets,password):null
    validateWebSearchSecretReferences(backup.webSearch,secrets?.webSearchApiKeys)
    // 到这里才开始任何写入：格式、规则、订阅和密码均已完整校验。
    const {feedIdMap,groupsAdded,feedsAdded,feedsUpdated}=this.restoreSubscriptions(backup)
    this.desktopSettings.update(readDesktopPreferences(backup.preferences))
    if(this.accounts){
      this.accounts.update({id:this.accounts.currentId(),syncIntervalMinutes:normalizeDesktopSyncInterval(backup.accountSettings.syncIntervalMinutes),syncOnStart:backup.accountSettings.syncOnStart,syncOnlyOnWiFi:backup.accountSettings.syncOnlyOnWiFi,syncOnlyWhenCharging:backup.accountSettings.syncOnlyWhenCharging,keepArchivedMillis:backup.accountSettings.keepArchivedMillis,syncBlockList:backup.accountSettings.syncBlockList})
    }else{
      this.desktopSettings.update({syncIntervalMinutes:normalizeDesktopSyncInterval(backup.accountSettings.syncIntervalMinutes),syncOnStart:backup.accountSettings.syncOnStart})
    }
    this.websiteRules.restoreBackup(JSON.stringify(backup.websiteRules))
    this.jsonRules.restoreBackup(JSON.stringify(backup.jsonRules))
    const filterRulesRestored=this.articleFilters.restoreBackup(JSON.stringify(backup.articleFilters),feedIdMap)
    this.websitePreferences.restoreBackup(JSON.stringify(backup.websiteParsePreferences),feedIdMap)
    this.rssHub.restore(backup.rssHub)
    for(const [oldFeedId,url] of Object.entries(backup.rssHubSourceUrls)){const mapped=feedIdMap.get(oldFeedId);if(mapped&&url.trim())this.library.setRssHubSourceUrl(mapped,url)}
    this.restoreTranslation(backup.translation,secrets?.translationApiKeys)
    this.restoreAi(backup.ai,secrets?.aiApiKeys)
    if(backup.webSearch&&this.webSearch){
      this.webSearch.restore(backup.webSearch,secrets?.webSearchApiKeys)
    }
    if(backup.llm&&this.llmSkills&&this.llmQuickMessages&&this.llmCustomization){
      this.llmSkills.restoreBackupState(JSON.stringify(backup.llm.skills))
      this.llmQuickMessages.restoreBackupState(JSON.stringify(backup.llm.quickMessages))
      this.llmCustomization.update(backup.llm.customization)
    }
    return{groupsAdded,feedsAdded,feedsUpdated,filterRulesRestored,credentialsRestored:Boolean(secrets)}
  }

  private decodeAndValidate(content:string):ConfigurationBackup{
    let backup:ConfigurationBackup;try{backup=JSON.parse(content) as ConfigurationBackup}catch{throw new Error('备份文件不是有效 JSON')}
    if(backup.schemaVersion!==1)throw new Error(`不支持的配置备份版本：${String(backup.schemaVersion)}`)
    if(backup.appName!=='OrigRead'||!String(backup.sourceVersion??'').trim())throw new Error('这不是有效的 OrigRead 配置备份')
    if(!backup.subscriptions||!Array.isArray(backup.subscriptions.groups)||!Array.isArray(backup.subscriptions.feeds))throw new Error('备份缺少订阅数据')
    const groupIds=new Set<string>();for(const group of backup.subscriptions.groups){if(!group.id?.trim()||!group.name?.trim()||groupIds.has(group.id))throw new Error('备份包含无效或重复分组');groupIds.add(group.id)}
    const feedIds=new Set<string>();for(const feed of backup.subscriptions.feeds){if(!feed.id?.trim()||!feed.name?.trim()||!feed.url?.trim()||feedIds.has(feed.id)||!groupIds.has(feed.groupId))throw new Error(`备份包含无效订阅：${feed.name??''}`);fromAndroidSourceType(feed.sourceType);feedIds.add(feed.id)}
    normalizeDesktopSyncInterval(backup.accountSettings?.syncIntervalMinutes)
    readDesktopPreferences(backup.preferences)
    this.websiteRules.validateBackup(JSON.stringify(backup.websiteRules));this.jsonRules.validateBackup(JSON.stringify(backup.jsonRules));this.articleFilters.validateBackup(JSON.stringify(backup.articleFilters));this.websitePreferences.validateBackup(JSON.stringify(backup.websiteParsePreferences))
    validateRssHubBackup(backup.rssHub);validateTranslationBackup(backup.translation);validateAiBackup(backup.ai);this.validateLlmBackup(backup.llm);validateWebSearchBackup(backup.webSearch)
    return backup
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

  private restoreSubscriptions(backup:ConfigurationBackup):{feedIdMap:Map<string,string>;groupsAdded:number;feedsAdded:number;feedsUpdated:number}{
    const existingGroups=this.library.listGroups();const groupMap=new Map<string,string>();let groupsAdded=0;const defaultGroupId=this.library.getCurrentDefaultGroup().id
    for(const source of backup.subscriptions.groups){if(source.isDefault){groupMap.set(source.id,defaultGroupId);continue}let target=existingGroups.find((group)=>group.name===source.name);if(!target){target={id:`group-${randomUUID()}`,name:source.name,sortOrder:existingGroups.length+groupsAdded+1,isDefault:false};this.library.upsertGroup(target);existingGroups.push(target);groupsAdded++}groupMap.set(source.id,target.id)}
    const feedIdMap=new Map<string,string>();let feedsAdded=0,feedsUpdated=0
    for(const source of backup.subscriptions.feeds){const existing=this.library.findFeedByUrl(source.url.trim());const now=Date.now();const feed:FeedRecord=existing?{...existing,name:source.name,icon:source.icon,groupId:groupMap.get(source.groupId)??defaultGroupId,isNotification:source.isNotification,isFullContent:source.isFullContent,isBrowser:source.isBrowser,sourceType:fromAndroidSourceType(source.sourceType),updatedAt:now}:{id:`feed-${randomUUID()}`,name:source.name,url:source.url.trim(),sourcePageUrl:source.url.trim(),icon:source.icon,groupId:groupMap.get(source.groupId)??defaultGroupId,isNotification:source.isNotification,isFullContent:source.isFullContent,isBrowser:source.isBrowser,sourceType:fromAndroidSourceType(source.sourceType),dynamicRendering:false,createdAt:now,updatedAt:now};this.library.upsertFeed(feed);feedIdMap.set(source.id,feed.id);existing?feedsUpdated++:feedsAdded++}
    return{feedIdMap,groupsAdded,feedsAdded,feedsUpdated}
  }
  private restoreTranslation(value:TranslationBackup,keys?:Partial<Record<TranslationProviderType,string>>):void{const fallback=TRANSLATION_PROVIDER_TYPES.includes(value.defaultProvider as TranslationProviderType)?value.defaultProvider as TranslationProviderType:'ML_KIT';this.translation.restore({defaultProvider:fallback,defaultTarget:backupTargetToTranslationTarget(value.defaultTarget,fallback),targetLanguage:value.targetLanguage,displayMode:value.displayMode,providers:TRANSLATION_PROVIDER_TYPES.map((type)=>{const source=value.providers.find((item)=>item.type===type);return{type,enabled:source?.enabled??type==='ML_KIT',endpoint:source?.endpoint??'',region:source?.region??''}})},keys)}
  private restoreAi(value:AiBackup,keys?:Record<string,string>):void{this.ai.restore({enabled:value.enabled,defaultProviderId:value.defaultProviderId,outputLanguage:value.outputLanguage,summaryLength:value.summaryLength,providers:value.providers.map((provider)=>({...provider}))},keys)}
}

function toBackupFeed(feed:FeedRecord){return{id:feed.id,name:feed.name,icon:feed.icon,url:feed.url,groupId:feed.groupId,isNotification:feed.isNotification,isFullContent:feed.isFullContent,isBrowser:feed.isBrowser,sourceType:toAndroidSourceType(feed.sourceType)}}
function toAndroidSourceType(type:SourceType):string{return type==='rss'?'RSS':type==='website'?'WEBSITE':'JSON'}
function fromAndroidSourceType(value:string):SourceType{switch(value.toUpperCase()){case'RSS':return'rss';case'WEBSITE':return'website';case'JSON':return'json';default:throw new Error(`不支持的来源类型：${value}`)}}
function normalizeDesktopSyncInterval(value:number){const allowed=[0,15,30,60,120,180,360,720,1440] as const;if(!allowed.includes(value as typeof allowed[number]))throw new Error(`不支持的同步间隔：${value}`);return value as typeof allowed[number]}
function toTranslationBackup(value:ReturnType<TranslationSettingsRepository['current']>):TranslationBackup{return{defaultProvider:value.defaultProvider,defaultTarget:value.defaultTarget.type==='traditional'?{type:'traditional',provider:value.defaultTarget.provider}:{type:'ai',providerId:value.defaultTarget.providerId,providerName:value.defaultTarget.providerName,model:value.defaultTarget.model},targetLanguage:value.targetLanguage,displayMode:value.displayMode,providers:value.providers.map((provider)=>({type:provider.type,enabled:provider.enabled,endpoint:provider.endpoint,region:provider.region}))}}
function toAiBackup(value:ReturnType<AiSettingsRepository['current']>):AiBackup{return{enabled:value.enabled,defaultProviderId:value.defaultProviderId,outputLanguage:value.outputLanguage,summaryLength:value.summaryLength,providers:value.providers.map(({hasApiKey:_ignored,apiKeyLength:_length,...provider})=>provider)}}
function desktopPreferences(settings:ReturnType<SettingsRepository['current']>):Record<string,unknown>{return{
  'origread.desktop.language':settings.language,
  'origread.desktop.theme':settings.theme,
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
  'origread.desktop.readerBackground':settings.readerBackground,
  'origread.desktop.readerBackgroundCustom':settings.readerBackgroundCustom,
  'origread.desktop.aiSummaryPlacement':settings.aiSummaryPlacement,
  'origread.desktop.aiSummaryPanelSize':settings.aiSummaryPanelSize,
  'origread.desktop.autoCheckUpdates':settings.autoCheckUpdates
}}
function readDesktopPreferences(value:Record<string,unknown>|null|undefined):Partial<ReturnType<SettingsRepository['current']>>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份中的 preferences 必须是 JSON 对象')
  // 旧备份没有布局/三栏字段时必须回到新版本默认值，不能继承恢复目标机器当前的布局偏好。
  const result:Record<string,unknown>={
    layoutMode:DEFAULT_DESKTOP_SETTINGS.layoutMode,
    sourcePaneWidth:DEFAULT_DESKTOP_SETTINGS.sourcePaneWidth,
    articlePaneWidth:DEFAULT_DESKTOP_SETTINGS.articlePaneWidth,
    sourcePaneCollapsed:DEFAULT_DESKTOP_SETTINGS.sourcePaneCollapsed,
    articlePaneCollapsed:DEFAULT_DESKTOP_SETTINGS.articlePaneCollapsed
  }
  const language=value['origread.desktop.language'];if(language!==undefined){if(language!=='system'&&language!=='zh'&&language!=='en')throw new Error('备份中的 Desktop 语言设置无效');result.language=language}
  const theme=value['origread.desktop.theme'];if(theme!==undefined){if(!['system','light','dark'].includes(String(theme)))throw new Error('备份中的 Desktop 主题设置无效');result.theme=theme}
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

