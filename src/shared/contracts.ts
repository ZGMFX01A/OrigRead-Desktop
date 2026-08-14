import type { ArticleRecord, FeedRecord, LibrarySnapshot } from './library'
import type { DesktopSettings, DesktopSettingsPatch } from './settings'
import type { RssSubscriptionResult } from './rss'
import type { RssHubSettings } from './rsshub'
import type { JsonRule } from './json-source'
import type { WebsiteInspectionResult, WebsiteRule } from './website'
import type { SourceDiscoveryResult, SourceSubscriptionResult } from './source-discovery'
import type { SourceSyncBatchResult, SourceSyncItemResult } from './source-sync'
import type { FullContentFetchResult, ReaderArticleContent } from './reader'
import type { SyncRuntimeState } from './sync-runtime'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from './original-view'

export interface AppInfo {
  version: string
  locale: string
  platform: string
}

export interface OrigReadDesktopApi {
  getAppInfo(): Promise<AppInfo>
  getLibrarySnapshot(): Promise<LibrarySnapshot>
  listFeeds(): Promise<FeedRecord[]>
  listArticles(limit?: number): Promise<ArticleRecord[]>
  setArticleUnread(articleId: string, unread: boolean): Promise<void>
  setArticleStarred(articleId: string, starred: boolean): Promise<void>
  getSettings(): Promise<DesktopSettings>
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings>
  addRssSource(inputUrl: string): Promise<RssSubscriptionResult>
  refreshRssSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }>
  getRssHubSettings(): Promise<RssHubSettings>
  setRssHubEnabled(enabled: boolean): Promise<RssHubSettings>
  addRssHubInstance(url: string): Promise<RssHubSettings>
  setRssHubInstanceEnabled(id: string, enabled: boolean): Promise<RssHubSettings>
  deleteRssHubInstance(id: string): Promise<RssHubSettings>
  testRssHubInstance(url: string): Promise<{ ok: boolean; error: string | null }>
  listJsonRules(): Promise<JsonRule[]>
  importJsonRules(content: string): Promise<number>
  exportJsonRules(): Promise<string>
  exportJsonRuleTemplate(): Promise<string>
  setJsonRuleEnabled(id: string, enabled: boolean): Promise<void>
  deleteJsonRule(id: string): Promise<void>
  inspectWebsiteStatic(url: string): Promise<WebsiteInspectionResult>
  inspectWebsiteDynamic(url: string): Promise<WebsiteInspectionResult>
  refreshWebsiteSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number; deletedArticles: number }>
  listWebsiteRules(): Promise<WebsiteRule[]>
  importWebsiteRules(content: string): Promise<number>
  exportWebsiteRules(): Promise<string>
  exportWebsiteRuleTemplate(): Promise<string>
  setWebsiteRuleEnabled(id: string, enabled: boolean): Promise<void>
  deleteWebsiteRule(id: string): Promise<void>
  discoverSource(url: string): Promise<SourceDiscoveryResult>
  subscribeSource(discoveryId: string, candidateId: string): Promise<SourceSubscriptionResult>
  refreshJsonSource(feedId: string): Promise<{ feedId: string; fetchedArticles: number; insertedArticles: number }>
  refreshSource(feedId: string): Promise<SourceSyncItemResult>
  refreshAllSources(): Promise<SourceSyncBatchResult>
  getSyncRuntimeState(): Promise<SyncRuntimeState>
  onSyncRuntimeStateChanged(listener: (state: SyncRuntimeState) => void): () => void
  getReaderContent(articleId: string): Promise<ReaderArticleContent>
  fetchFullContent(articleId: string): Promise<FullContentFetchResult>
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
  listArticles: 'library:list-articles',
  setArticleUnread: 'library:set-article-unread',
  setArticleStarred: 'library:set-article-starred',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  addRssSource: 'rss:add-source',
  refreshRssSource: 'rss:refresh-source',
  getRssHubSettings: 'rsshub:settings:get',
  setRssHubEnabled: 'rsshub:settings:set-enabled',
  addRssHubInstance: 'rsshub:instance:add',
  setRssHubInstanceEnabled: 'rsshub:instance:set-enabled',
  deleteRssHubInstance: 'rsshub:instance:delete',
  testRssHubInstance: 'rsshub:instance:test',
  listJsonRules: 'json:rules:list',
  importJsonRules: 'json:rules:import',
  exportJsonRules: 'json:rules:export',
  exportJsonRuleTemplate: 'json:rules:export-template',
  setJsonRuleEnabled: 'json:rules:set-enabled',
  deleteJsonRule: 'json:rules:delete',
  inspectWebsiteStatic: 'website:inspect-static',
  inspectWebsiteDynamic: 'website:inspect-dynamic',
  refreshWebsiteSource: 'website:refresh-source',
  listWebsiteRules: 'website:rules:list',
  importWebsiteRules: 'website:rules:import',
  exportWebsiteRules: 'website:rules:export',
  exportWebsiteRuleTemplate: 'website:rules:export-template',
  setWebsiteRuleEnabled: 'website:rules:set-enabled',
  deleteWebsiteRule: 'website:rules:delete',
  discoverSource: 'source:discover',
  subscribeSource: 'source:subscribe',
  refreshJsonSource: 'json:refresh-source',
  refreshSource: 'source:refresh',
  refreshAllSources: 'source:refresh-all',
  getSyncRuntimeState: 'sync:get-runtime-state',
  syncRuntimeStateChanged: 'sync:runtime-state-changed',
  getReaderContent: 'reader:get-content',
  fetchFullContent: 'reader:fetch-full-content',
  openOriginalArticle: 'reader:original:open',
  updateOriginalArticleBounds: 'reader:original:update-bounds',
  navigateOriginalArticle: 'reader:original:navigate',
  closeOriginalArticle: 'reader:original:close',
  getOriginalArticleState: 'reader:original:get-state',
  originalArticleStateChanged: 'reader:original:state-changed',
  openExternalUrl: 'shell:open-external'
} as const

