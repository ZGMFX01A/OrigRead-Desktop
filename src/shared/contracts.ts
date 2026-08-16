import type { ArticleRecord, FeedRecord, GroupRecord, LibrarySnapshot } from './library'
import type { DesktopSettings, DesktopSettingsPatch } from './settings'
import type { RssSubscriptionResult } from './rss'
import type { RssHubSettings } from './rsshub'
import type { JsonRule } from './json-source'
import type { WebsiteInspectionResult, WebsiteParseCandidate, WebsiteRule } from './website'
import type { SourceDiscoveryResult, SourceSubscriptionResult } from './source-discovery'
import type { SourceSyncBatchResult, SourceSyncItemResult } from './source-sync'
import type { FullContentFetchResult, ReaderArticleContent } from './reader'
import type { SyncRuntimeState } from './sync-runtime'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from './original-view'
import type { AiProviderPatch, AiProviderTestResult, AiSettings, AiSettingsPatch, AiSummaryDocument, AiSummaryProgress, AiSummaryRequestOptions } from './ai'
import type { DeepLUsage, TranslationDocument, TranslationProviderPatch, TranslationProviderTestResult, TranslationSettings, TranslationSettingsPatch, TranslationTarget } from './translation'
import type { ArticleFilterRule, ArticleFilterSnapshot, ArticleFilterRuleType } from './filter-rules'
import type { ConfigurationBackupFileResult } from './configuration-backup'
import type { FeedCatalogSnapshot } from './source-catalog'
import type { AiGeneratedRuleKind, AiGeneratedRulePreview } from './ai-rule'
import type { ReaderFontEntry, ReaderFontFileResult } from './reader-font'
import type { OpmlExportFileResult, OpmlImportFileResult } from './opml'

export interface WebsiteSourceRuleSettings {
  feedId: string
  preferredRuleId: string | null
  preferredRuleName: string | null
  dynamicRenderingEnabled: boolean
  cachedAutomaticRuleId: string | null
  cachedAutomaticRuleName: string | null
}

export interface AppInfo {
  version: string
  locale: string
  platform: string
}

export interface FeedSettingsPatch {
  name?: string
  url?: string
  groupId?: string
  isNotification?: boolean
  isFullContent?: boolean
  isBrowser?: boolean
}

export interface OrigReadDesktopApi {
  getAppInfo(): Promise<AppInfo>
  getLibrarySnapshot(): Promise<LibrarySnapshot>
  listFeeds(): Promise<FeedRecord[]>
  listGroups(): Promise<GroupRecord[]>
  listArticles(limit?: number): Promise<ArticleRecord[]>
  setArticleUnread(articleId: string, unread: boolean): Promise<void>
  setArticleStarred(articleId: string, starred: boolean): Promise<void>
  addGroup(name: string): Promise<GroupRecord[]>
  updateFeedSettings(feedId: string, patch: FeedSettingsPatch): Promise<FeedRecord>
  clearFeedArticles(feedId: string): Promise<void>
  deleteFeed(feedId: string): Promise<void>
  reloadFeedIcon(feedId: string): Promise<FeedRecord>
  getSettings(): Promise<DesktopSettings>
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings>
  listReaderFonts(): Promise<ReaderFontEntry[]>
  importReaderFont(): Promise<ReaderFontFileResult>
  deleteReaderFont(id: string): Promise<ReaderFontEntry[]>
  addRssSource(inputUrl: string): Promise<RssSubscriptionResult>
  refreshRssSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }>
  getRssHubSettings(): Promise<RssHubSettings>
  setRssHubEnabled(enabled: boolean): Promise<RssHubSettings>
  addRssHubInstance(url: string): Promise<RssHubSettings>
  setRssHubInstanceEnabled(id: string, enabled: boolean): Promise<RssHubSettings>
  deleteRssHubInstance(id: string): Promise<RssHubSettings>
  testRssHubInstance(url: string): Promise<{ ok: boolean; error: string | null }>
  restoreDefaultRssHubSettings(): Promise<RssHubSettings>
  getSourceCatalog(): Promise<FeedCatalogSnapshot>
  listJsonRules(): Promise<JsonRule[]>
  importJsonRules(content: string): Promise<number>
  exportJsonRules(): Promise<string>
  exportJsonRuleTemplate(): Promise<string>
  setJsonRuleEnabled(id: string, enabled: boolean): Promise<void>
  deleteJsonRule(id: string): Promise<void>
  getRuleGuide(kind: 'website' | 'json', language: 'zh' | 'en'): Promise<string>
  generateAiRule(kind: AiGeneratedRuleKind, url: string): Promise<AiGeneratedRulePreview>
  saveAiGeneratedRule(previewId: string): Promise<void>
  exportRuleTemplateFile(kind: 'website' | 'json'): Promise<{ ok:boolean;cancelled:boolean;path:string|null;error:string|null }>
  inspectWebsiteStatic(url: string): Promise<WebsiteInspectionResult>
  inspectWebsiteDynamic(url: string): Promise<WebsiteInspectionResult>
  refreshWebsiteSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }>
  listWebsiteRules(): Promise<WebsiteRule[]>
  importWebsiteRules(content: string): Promise<number>
  exportWebsiteRules(): Promise<string>
  exportWebsiteRuleTemplate(): Promise<string>
  setWebsiteRuleEnabled(id: string, enabled: boolean): Promise<void>
  deleteWebsiteRule(id: string): Promise<void>
  testWebsiteRule(url: string): Promise<{ ok:boolean;articleCount:number;error:string|null }>
  discoverSource(url: string): Promise<SourceDiscoveryResult>
  subscribeSource(discoveryId: string, candidateId: string): Promise<SourceSubscriptionResult>
  refreshJsonSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }>
  refreshSource(feedId: string): Promise<SourceSyncItemResult>
  refreshAllSources(): Promise<SourceSyncBatchResult>
  getSyncRuntimeState(): Promise<SyncRuntimeState>
  onSyncRuntimeStateChanged(listener: (state: SyncRuntimeState) => void): () => void
  getReaderContent(articleId: string, preferFull?: boolean): Promise<ReaderArticleContent>
  fetchFullContent(articleId: string): Promise<FullContentFetchResult>
  getAiSettings(): Promise<AiSettings>
  getAiApiKey(providerId: string): Promise<string>
  updateAiSettings(patch: AiSettingsPatch): Promise<AiSettings>
  addAiProvider(): Promise<AiSettings>
  updateAiProvider(patch: AiProviderPatch): Promise<AiSettings>
  removeAiProvider(providerId: string): Promise<AiSettings>
  refreshAiModels(providerId: string, draftApiKey?: string): Promise<string[]>
  testAiProvider(providerId: string): Promise<AiProviderTestResult>
  summarizeArticle(articleId: string, forceRefresh?: boolean, options?: AiSummaryRequestOptions): Promise<AiSummaryDocument>
  stopAiSummary(articleId: string): Promise<boolean>
  onAiSummaryProgress(listener: (progress: AiSummaryProgress) => void): () => void
  getTranslationSettings(): Promise<TranslationSettings>
  getTranslationApiKey(type: TranslationProviderPatch['type']): Promise<string>
  updateTranslationSettings(patch: TranslationSettingsPatch): Promise<TranslationSettings>
  updateTranslationProvider(patch: TranslationProviderPatch): Promise<TranslationSettings>
  testTranslationProvider(type: TranslationProviderPatch['type']): Promise<TranslationProviderTestResult>
  getDeepLUsage(): Promise<DeepLUsage>
  translateArticle(articleId: string, target?: TranslationTarget, forceRefresh?: boolean): Promise<TranslationDocument>
  getArticleFilters(): Promise<ArticleFilterSnapshot>
  addArticleFilter(keyword: string, type: ArticleFilterRuleType, feedId?: string | null): Promise<ArticleFilterSnapshot>
  setArticleFilterEnabled(id: string, enabled: boolean): Promise<ArticleFilterSnapshot>
  deleteArticleFilter(id: string): Promise<ArticleFilterSnapshot>
  getWebsiteSourceRuleSettings(feedId: string): Promise<WebsiteSourceRuleSettings | null>
  evaluateWebsiteSourceRules(feedId: string): Promise<WebsiteParseCandidate[]>
  setWebsiteSourcePreferredRule(feedId: string, ruleId: string | null): Promise<WebsiteSourceRuleSettings>
  setWebsiteSourceDynamicRendering(feedId: string, enabled: boolean): Promise<WebsiteSourceRuleSettings>
  importOpml(): Promise<OpmlImportFileResult>
  exportOpml(attachInfo?: boolean): Promise<OpmlExportFileResult>
  exportConfigurationBackup(password?: string): Promise<ConfigurationBackupFileResult>
  restoreConfigurationBackup(password?: string): Promise<ConfigurationBackupFileResult>
  importRuleFile(kind: 'website' | 'json' | 'filter'): Promise<{ ok:boolean;cancelled:boolean;count:number;error:string|null }>
  exportRuleFile(kind: 'website' | 'json' | 'filter'): Promise<{ ok:boolean;cancelled:boolean;path:string|null;error:string|null }>
  openOriginalArticle(url: string, bounds: OriginalViewBounds): Promise<OriginalArticleViewState>
  updateOriginalArticleBounds(bounds: OriginalViewBounds): Promise<void>
  navigateOriginalArticle(action: OriginalNavigationAction): Promise<OriginalArticleViewState>
  closeOriginalArticle(): Promise<void>
  getOriginalArticleState(): Promise<OriginalArticleViewState>
  onOriginalArticleStateChanged(listener: (state: OriginalArticleViewState) => void): () => void
  openExternalUrl(url: string): Promise<void>
}

export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
  getLibrarySnapshot: 'library:get-snapshot',
  listFeeds: 'library:list-feeds',
  listGroups: 'library:list-groups',
  listArticles: 'library:list-articles',
  setArticleUnread: 'library:set-article-unread',
  setArticleStarred: 'library:set-article-starred',
  addGroup: 'library:add-group',
  updateFeedSettings: 'library:feed:update-settings',
  clearFeedArticles: 'library:feed:clear-articles',
  deleteFeed: 'library:feed:delete',
  reloadFeedIcon: 'library:feed:reload-icon',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  listReaderFonts: 'reader-font:list',
  importReaderFont: 'reader-font:import',
  deleteReaderFont: 'reader-font:delete',
  addRssSource: 'rss:add-source',
  refreshRssSource: 'rss:refresh-source',
  getRssHubSettings: 'rsshub:settings:get',
  setRssHubEnabled: 'rsshub:settings:set-enabled',
  addRssHubInstance: 'rsshub:instance:add',
  setRssHubInstanceEnabled: 'rsshub:instance:set-enabled',
  deleteRssHubInstance: 'rsshub:instance:delete',
  testRssHubInstance: 'rsshub:instance:test',
  restoreDefaultRssHubSettings: 'rsshub:settings:restore-default',
  getSourceCatalog: 'source:catalog:get',
  listJsonRules: 'json:rules:list',
  importJsonRules: 'json:rules:import',
  exportJsonRules: 'json:rules:export',
  exportJsonRuleTemplate: 'json:rules:export-template',
  setJsonRuleEnabled: 'json:rules:set-enabled',
  deleteJsonRule: 'json:rules:delete',
  getRuleGuide: 'rules:guide:get',
  generateAiRule: 'rules:ai:generate',
  saveAiGeneratedRule: 'rules:ai:save',
  exportRuleTemplateFile: 'rules:template:export-file',
  inspectWebsiteStatic: 'website:inspect-static',
  inspectWebsiteDynamic: 'website:inspect-dynamic',
  refreshWebsiteSource: 'website:refresh-source',
  listWebsiteRules: 'website:rules:list',
  importWebsiteRules: 'website:rules:import',
  exportWebsiteRules: 'website:rules:export',
  exportWebsiteRuleTemplate: 'website:rules:export-template',
  setWebsiteRuleEnabled: 'website:rules:set-enabled',
  deleteWebsiteRule: 'website:rules:delete',
  testWebsiteRule: 'website:rules:test',
  discoverSource: 'source:discover',
  subscribeSource: 'source:subscribe',
  refreshJsonSource: 'json:refresh-source',
  refreshSource: 'source:refresh',
  refreshAllSources: 'source:refresh-all',
  getSyncRuntimeState: 'sync:get-runtime-state',
  syncRuntimeStateChanged: 'sync:runtime-state-changed',
  getReaderContent: 'reader:get-content',
  fetchFullContent: 'reader:fetch-full-content',
  getAiSettings: 'ai:settings:get',
  getAiApiKey: 'ai:provider:get-api-key',
  updateAiSettings: 'ai:settings:update',
  addAiProvider: 'ai:provider:add',
  updateAiProvider: 'ai:provider:update',
  removeAiProvider: 'ai:provider:remove',
  refreshAiModels: 'ai:provider:models',
  testAiProvider: 'ai:provider:test',
  summarizeArticle: 'ai:summary:generate',
  stopAiSummary: 'ai:summary:stop',
  aiSummaryProgress: 'ai:summary:progress',
  getTranslationSettings: 'translation:settings:get',
  getTranslationApiKey: 'translation:provider:get-api-key',
  updateTranslationSettings: 'translation:settings:update',
  updateTranslationProvider: 'translation:provider:update',
  testTranslationProvider: 'translation:provider:test',
  getDeepLUsage: 'translation:deepl:usage',
  translateArticle: 'translation:article:translate',
  getArticleFilters: 'rules:filter:list',
  addArticleFilter: 'rules:filter:add',
  setArticleFilterEnabled: 'rules:filter:set-enabled',
  deleteArticleFilter: 'rules:filter:delete',
  getWebsiteSourceRuleSettings: 'rules:source:get',
  evaluateWebsiteSourceRules: 'rules:source:evaluate',
  setWebsiteSourcePreferredRule: 'rules:source:set-preferred',
  setWebsiteSourceDynamicRendering: 'rules:source:set-dynamic',
  importOpml: 'opml:import',
  exportOpml: 'opml:export',
  exportConfigurationBackup: 'backup:export',
  restoreConfigurationBackup: 'backup:restore',
  importRuleFile: 'rules:file:import',
  exportRuleFile: 'rules:file:export',
  openOriginalArticle: 'reader:original:open',
  updateOriginalArticleBounds: 'reader:original:update-bounds',
  navigateOriginalArticle: 'reader:original:navigate',
  closeOriginalArticle: 'reader:original:close',
  getOriginalArticleState: 'reader:original:get-state',
  originalArticleStateChanged: 'reader:original:state-changed',
  openExternalUrl: 'shell:open-external'
} as const

