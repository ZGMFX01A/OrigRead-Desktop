import { randomUUID } from 'node:crypto'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import type { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import type { SettingsRepository } from '../database/settings-repository'
import type { ArticleFilterRepository } from '../filter/article-filter-repository'
import type { JsonRuleRepository } from '../sources/json/json-rule-repository'
import type { RssHubSettingsRepository } from '../sources/rsshub/rsshub-settings-repository'
import type { WebsiteParsePreferenceRepository } from '../sources/website/website-parse-preference-repository'
import type { WebsiteRuleRepository } from '../sources/website/website-rule-repository'
import type { TranslationSettingsRepository } from '../translation/translation-settings-repository'
import type { ConfigurationBackup,ConfigurationBackupSecrets,ConfigurationRestoreResult,TranslationBackup,AiBackup,RssHubBackup } from '../../shared/configuration-backup'
import { backupTargetToTranslationTarget } from '../../shared/configuration-backup'
import type { FeedRecord,GroupRecord,SourceType } from '../../shared/library'
import type { TranslationProviderType } from '../../shared/translation'
import { TRANSLATION_PROVIDER_TYPES } from '../../shared/translation'
import { decryptConfigurationSecrets,encryptConfigurationSecrets } from './configuration-backup-crypto'

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
    private readonly ai:AiSettingsRepository
  ){}

  exportBackup(password=''):string{
    const groups=this.library.listGroups(),feeds=this.library.listFeeds(),settings=this.desktopSettings.current(),translation=this.translation.current(),ai=this.ai.current()
    const secrets:ConfigurationBackupSecrets={
      translationApiKeys:Object.fromEntries(TRANSLATION_PROVIDER_TYPES.map((type)=>[type,this.translation.getApiKey(type)]).filter(([,value])=>Boolean(value))) as Partial<Record<TranslationProviderType,string>>,
      aiApiKeys:Object.fromEntries(ai.providers.map((provider)=>[provider.id,this.ai.getApiKey(provider.id)]).filter(([,value])=>Boolean(value)))
    }
    const hasSecrets=Object.keys(secrets.translationApiKeys).length>0||Object.keys(secrets.aiApiKeys).length>0
    const includeSecrets=Boolean(password)
    if(includeSecrets&&password.length<6)throw new Error('备份密码至少需要 6 个字符')
    const backup:ConfigurationBackup={
      schemaVersion:1,appName:'OrigRead',sourceVersion:this.appVersion,createdAtEpochMillis:Date.now(),preferences:desktopPreferences(settings),
      accountSettings:{syncIntervalMinutes:settings.syncIntervalMinutes,syncOnStart:settings.syncOnStart,syncOnlyOnWiFi:false,syncOnlyWhenCharging:false,keepArchivedMillis:2_592_000_000,syncBlockList:[]},
      subscriptions:{sourceAccountId:1,groups:groups.map((group)=>({id:group.id,name:group.name,isDefault:group.isDefault})),feeds:feeds.map(toBackupFeed)},
      websiteRules:JSON.parse(this.websiteRules.exportRules()),jsonRules:JSON.parse(this.jsonRules.exportRules()),articleFilters:JSON.parse(this.articleFilters.exportRules()),websiteParsePreferences:JSON.parse(this.websitePreferences.exportBackup(new Set(feeds.map((feed)=>feed.id)))),
      rssHub:this.rssHub.current(),rssHubSourceUrls:this.library.listRssHubSourceUrls(),translation:toTranslationBackup(translation),ai:toAiBackup(ai),
      encryptedSecrets:includeSecrets&&hasSecrets?encryptConfigurationSecrets(secrets,password):null
    }
    return JSON.stringify(backup,null,2)
  }

  inspect(content:string):{sourceVersion:string;createdAtEpochMillis:number;feeds:number;groups:number;hasEncryptedSecrets:boolean}{const backup=this.decodeAndValidate(content);return{sourceVersion:backup.sourceVersion,createdAtEpochMillis:backup.createdAtEpochMillis,feeds:backup.subscriptions.feeds.length,groups:backup.subscriptions.groups.length,hasEncryptedSecrets:Boolean(backup.encryptedSecrets)}}

  restoreBackup(content:string,password=''):ConfigurationRestoreResult{
    const backup=this.decodeAndValidate(content)
    const secrets=backup.encryptedSecrets?decryptConfigurationSecrets(backup.encryptedSecrets,password):null
    // 到这里才开始任何写入：格式、规则、订阅和密码均已完整校验。
    const {feedIdMap,groupsAdded,feedsAdded,feedsUpdated}=this.restoreSubscriptions(backup)
    this.desktopSettings.update({
      ...readDesktopPreferences(backup.preferences),
      syncIntervalMinutes:normalizeDesktopSyncInterval(backup.accountSettings.syncIntervalMinutes),
      syncOnStart:backup.accountSettings.syncOnStart
    })
    this.websiteRules.restoreBackup(JSON.stringify(backup.websiteRules))
    this.jsonRules.restoreBackup(JSON.stringify(backup.jsonRules))
    const filterRulesRestored=this.articleFilters.restoreBackup(JSON.stringify(backup.articleFilters),feedIdMap)
    this.websitePreferences.restoreBackup(JSON.stringify(backup.websiteParsePreferences),feedIdMap)
    this.rssHub.restore(backup.rssHub)
    for(const [oldFeedId,url] of Object.entries(backup.rssHubSourceUrls)){const mapped=feedIdMap.get(oldFeedId);if(mapped&&url.trim())this.library.setRssHubSourceUrl(mapped,url)}
    this.restoreTranslation(backup.translation,secrets?.translationApiKeys)
    this.restoreAi(backup.ai,secrets?.aiApiKeys)
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
    validateRssHubBackup(backup.rssHub);validateTranslationBackup(backup.translation);validateAiBackup(backup.ai)
    return backup
  }

  private restoreSubscriptions(backup:ConfigurationBackup):{feedIdMap:Map<string,string>;groupsAdded:number;feedsAdded:number;feedsUpdated:number}{
    const existingGroups=this.library.listGroups();const groupMap=new Map<string,string>();let groupsAdded=0
    for(const source of backup.subscriptions.groups){if(source.isDefault){groupMap.set(source.id,DEFAULT_GROUP_ID);continue}let target=existingGroups.find((group)=>group.name===source.name);if(!target){target={id:`group-${randomUUID()}`,name:source.name,sortOrder:existingGroups.length+groupsAdded+1,isDefault:false};this.library.upsertGroup(target);existingGroups.push(target);groupsAdded++}groupMap.set(source.id,target.id)}
    const feedIdMap=new Map<string,string>();let feedsAdded=0,feedsUpdated=0
    for(const source of backup.subscriptions.feeds){const existing=this.library.findFeedByUrl(source.url.trim());const now=Date.now();const feed:FeedRecord=existing?{...existing,name:source.name,icon:source.icon,groupId:groupMap.get(source.groupId)??DEFAULT_GROUP_ID,isNotification:source.isNotification,isFullContent:source.isFullContent,isBrowser:source.isBrowser,sourceType:fromAndroidSourceType(source.sourceType),updatedAt:now}:{id:`feed-${randomUUID()}`,name:source.name,url:source.url.trim(),sourcePageUrl:source.url.trim(),icon:source.icon,groupId:groupMap.get(source.groupId)??DEFAULT_GROUP_ID,isNotification:source.isNotification,isFullContent:source.isFullContent,isBrowser:source.isBrowser,sourceType:fromAndroidSourceType(source.sourceType),dynamicRendering:false,createdAt:now,updatedAt:now};this.library.upsertFeed(feed);feedIdMap.set(source.id,feed.id);existing?feedsUpdated++:feedsAdded++}
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
function toAiBackup(value:ReturnType<AiSettingsRepository['current']>):AiBackup{return{enabled:value.enabled,defaultProviderId:value.defaultProviderId,outputLanguage:value.outputLanguage,summaryLength:value.summaryLength,providers:value.providers.map(({hasApiKey:_ignored,...provider})=>provider)}}
function desktopPreferences(settings:ReturnType<SettingsRepository['current']>):Record<string,unknown>{return{
  'origread.desktop.language':settings.language,
  'origread.desktop.theme':settings.theme,
  'origread.desktop.workspaceCollapsed':settings.workspaceCollapsed,
  'origread.desktop.workspaceWidth':settings.workspaceWidth,
  'origread.desktop.readerFontSize':settings.readerFontSize,
  'origread.desktop.readerLineHeight':settings.readerLineHeight,
  'origread.desktop.readerContentWidth':settings.readerContentWidth,
  'origread.desktop.readerBackground':settings.readerBackground,
  'origread.desktop.readerBackgroundCustom':settings.readerBackgroundCustom,
  'origread.desktop.aiSummaryPlacement':settings.aiSummaryPlacement,
  'origread.desktop.aiSummaryPanelSize':settings.aiSummaryPanelSize
}}
function readDesktopPreferences(value:Record<string,unknown>|null|undefined):Partial<ReturnType<SettingsRepository['current']>>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('备份中的 preferences 必须是 JSON 对象')
  const result:Record<string,unknown>={}
  const language=value['origread.desktop.language'];if(language!==undefined){if(language!=='system'&&language!=='zh'&&language!=='en')throw new Error('备份中的 Desktop 语言设置无效');result.language=language}
  const theme=value['origread.desktop.theme'];if(theme!==undefined){if(!['system','light','dark'].includes(String(theme)))throw new Error('备份中的 Desktop 主题设置无效');result.theme=theme}
  const collapsed=value['origread.desktop.workspaceCollapsed'];if(collapsed!==undefined){if(typeof collapsed!=='boolean')throw new Error('备份中的 Desktop 侧栏设置类型无效');result.workspaceCollapsed=collapsed}
  const readerBackground=value['origread.desktop.readerBackground'];if(readerBackground!==undefined){if(!['theme','paper','warm','sepia','mint','custom'].includes(String(readerBackground)))throw new Error('备份中的阅读背景设置无效');result.readerBackground=readerBackground}
  const readerBackgroundCustom=value['origread.desktop.readerBackgroundCustom'];if(readerBackgroundCustom!==undefined){if(typeof readerBackgroundCustom!=='string'||!/^#[0-9a-fA-F]{6}$/.test(readerBackgroundCustom))throw new Error('备份中的自定义阅读背景颜色无效');result.readerBackgroundCustom=readerBackgroundCustom.toLowerCase()}
  const placement=value['origread.desktop.aiSummaryPlacement'];if(placement!==undefined){if(!['replace','left','right','top','bottom'].includes(String(placement)))throw new Error('备份中的 AI 摘要位置无效');result.aiSummaryPlacement=placement}
  for(const [key,target] of [['origread.desktop.workspaceWidth','workspaceWidth'],['origread.desktop.readerFontSize','readerFontSize'],['origread.desktop.readerLineHeight','readerLineHeight'],['origread.desktop.readerContentWidth','readerContentWidth'],['origread.desktop.aiSummaryPanelSize','aiSummaryPanelSize']] as const){const candidate=value[key];if(candidate!==undefined){if(typeof candidate!=='number'||!Number.isFinite(candidate))throw new Error(`备份中的 ${key} 类型无效`);result[target]=candidate}}
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
  for(const provider of value.providers){if(!provider.id?.trim()||!provider.endpoint?.trim())throw new Error('备份包含无效 AI Provider');if(ids.has(provider.id))throw new Error(`备份包含重复 AI Provider：${provider.id}`);ids.add(provider.id)}
  if(!ids.has(value.defaultProviderId))throw new Error('备份中的默认 AI Provider 不存在')
}

