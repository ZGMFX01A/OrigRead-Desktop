import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type FeedSettingsPatch, type OrigReadDesktopApi } from '../shared/contracts'
import type { DesktopSettingsPatch } from '../shared/settings'
import type { SyncRuntimeState } from '../shared/sync-runtime'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from '../shared/original-view'
import type { AiProviderPatch, AiSettingsPatch, AiSummaryRequestOptions } from '../shared/ai'
import type { TranslationProviderPatch, TranslationProviderType, TranslationSettingsPatch, TranslationTarget } from '../shared/translation'
import type { ArticleFilterRuleType } from '../shared/filter-rules'
import type { AiGeneratedRuleKind } from '../shared/ai-rule'

const api: OrigReadDesktopApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getLibrarySnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getLibrarySnapshot),
  listFeeds: () => ipcRenderer.invoke(IPC_CHANNELS.listFeeds),
  listGroups: () => ipcRenderer.invoke(IPC_CHANNELS.listGroups),
  listArticles: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.listArticles, limit),
  setArticleUnread: (articleId: string, unread: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleUnread, articleId, unread),
  setArticleStarred: (articleId: string, starred: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleStarred, articleId, starred),
  addGroup: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.addGroup, name),
  updateFeedSettings: (feedId: string, patch: FeedSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateFeedSettings, feedId, patch),
  clearFeedArticles: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.clearFeedArticles, feedId),
  deleteFeed: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteFeed, feedId),
  reloadFeedIcon: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.reloadFeedIcon, feedId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  updateSettings: (patch: DesktopSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, patch),
  listReaderFonts: () => ipcRenderer.invoke(IPC_CHANNELS.listReaderFonts),
  importReaderFont: () => ipcRenderer.invoke(IPC_CHANNELS.importReaderFont),
  deleteReaderFont: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteReaderFont, id),
  addRssSource: (inputUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.addRssSource, inputUrl),
  refreshRssSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshRssSource, feedId),
  getRssHubSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getRssHubSettings),
  setRssHubEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setRssHubEnabled, enabled),
  addRssHubInstance: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.addRssHubInstance, url),
  setRssHubInstanceEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setRssHubInstanceEnabled, id, enabled),
  deleteRssHubInstance: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteRssHubInstance, id),
  testRssHubInstance: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.testRssHubInstance, url),
  restoreDefaultRssHubSettings: () => ipcRenderer.invoke(IPC_CHANNELS.restoreDefaultRssHubSettings),
  getSourceCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.getSourceCatalog),
  listJsonRules: () => ipcRenderer.invoke(IPC_CHANNELS.listJsonRules),
  importJsonRules: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.importJsonRules, content),
  exportJsonRules: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRules),
  exportJsonRuleTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRuleTemplate),
  setJsonRuleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setJsonRuleEnabled, id, enabled),
  deleteJsonRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteJsonRule, id),
  getRuleGuide: (kind: 'website' | 'json', language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.getRuleGuide, kind, language),
  generateAiRule: (kind: AiGeneratedRuleKind, url: string) => ipcRenderer.invoke(IPC_CHANNELS.generateAiRule, kind, url),
  saveAiGeneratedRule: (previewId: string) => ipcRenderer.invoke(IPC_CHANNELS.saveAiGeneratedRule, previewId),
  exportRuleTemplateFile: (kind: 'website' | 'json') => ipcRenderer.invoke(IPC_CHANNELS.exportRuleTemplateFile, kind),
  inspectWebsiteStatic: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectWebsiteStatic, url),
  inspectWebsiteDynamic: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectWebsiteDynamic, url),
  refreshWebsiteSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshWebsiteSource, feedId),
  listWebsiteRules: () => ipcRenderer.invoke(IPC_CHANNELS.listWebsiteRules),
  importWebsiteRules: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.importWebsiteRules, content),
  exportWebsiteRules: () => ipcRenderer.invoke(IPC_CHANNELS.exportWebsiteRules),
  exportWebsiteRuleTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.exportWebsiteRuleTemplate),
  setWebsiteRuleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWebsiteRuleEnabled, id, enabled),
  deleteWebsiteRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteWebsiteRule, id),
  testWebsiteRule: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.testWebsiteRule, url),
  discoverSource: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.discoverSource, url),
  subscribeSource: (discoveryId: string, candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.subscribeSource, discoveryId, candidateId),
  refreshJsonSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshJsonSource, feedId),
  refreshSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshSource, feedId),
  refreshAllSources: () => ipcRenderer.invoke(IPC_CHANNELS.refreshAllSources),
  getSyncRuntimeState: () => ipcRenderer.invoke(IPC_CHANNELS.getSyncRuntimeState),
  onSyncRuntimeStateChanged: (listener: (state: SyncRuntimeState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: SyncRuntimeState): void => listener(state)
    ipcRenderer.on(IPC_CHANNELS.syncRuntimeStateChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.syncRuntimeStateChanged, wrapped)
  },
  getReaderContent: (articleId: string, preferFull?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.getReaderContent, articleId, preferFull),
  fetchFullContent: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.fetchFullContent, articleId),
  getAiSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAiSettings),
  getAiApiKey: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.getAiApiKey, providerId),
  updateAiSettings: (patch: AiSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiSettings, patch),
  addAiProvider: () => ipcRenderer.invoke(IPC_CHANNELS.addAiProvider),
  updateAiProvider: (patch: AiProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiProvider, patch),
  removeAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeAiProvider, providerId),
  refreshAiModels: (providerId: string, draftApiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshAiModels, providerId, draftApiKey),
  testAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.testAiProvider, providerId),
  summarizeArticle: (articleId: string, forceRefresh?: boolean, options?: AiSummaryRequestOptions) => ipcRenderer.invoke(IPC_CHANNELS.summarizeArticle, articleId, forceRefresh, options),
  getTranslationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getTranslationSettings),
  getTranslationApiKey: (type: TranslationProviderType) => ipcRenderer.invoke(IPC_CHANNELS.getTranslationApiKey, type),
  updateTranslationSettings: (patch: TranslationSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationSettings, patch),
  updateTranslationProvider: (patch: TranslationProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationProvider, patch),
  testTranslationProvider: (type: TranslationProviderType) => ipcRenderer.invoke(IPC_CHANNELS.testTranslationProvider, type),
  translateArticle: (articleId: string, target?: TranslationTarget, forceRefresh?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.translateArticle, articleId, target, forceRefresh),
  getArticleFilters: () => ipcRenderer.invoke(IPC_CHANNELS.getArticleFilters),
  addArticleFilter: (keyword: string, type: ArticleFilterRuleType, feedId?: string | null) => ipcRenderer.invoke(IPC_CHANNELS.addArticleFilter, keyword, type, feedId),
  setArticleFilterEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setArticleFilterEnabled, id, enabled),
  deleteArticleFilter: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteArticleFilter, id),
  getWebsiteSourceRuleSettings: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.getWebsiteSourceRuleSettings, feedId),
  evaluateWebsiteSourceRules: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.evaluateWebsiteSourceRules, feedId),
  setWebsiteSourcePreferredRule: (feedId: string, ruleId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.setWebsiteSourcePreferredRule, feedId, ruleId),
  setWebsiteSourceDynamicRendering: (feedId: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setWebsiteSourceDynamicRendering, feedId, enabled),
  importOpml: () => ipcRenderer.invoke(IPC_CHANNELS.importOpml),
  exportOpml: (attachInfo = true) => ipcRenderer.invoke(IPC_CHANNELS.exportOpml, attachInfo),
  exportConfigurationBackup: (password?: string) => ipcRenderer.invoke(IPC_CHANNELS.exportConfigurationBackup, password),
  restoreConfigurationBackup: (password?: string) => ipcRenderer.invoke(IPC_CHANNELS.restoreConfigurationBackup, password),
  importRuleFile: (kind: 'website' | 'json' | 'filter') => ipcRenderer.invoke(IPC_CHANNELS.importRuleFile, kind),
  exportRuleFile: (kind: 'website' | 'json' | 'filter') => ipcRenderer.invoke(IPC_CHANNELS.exportRuleFile, kind),
  openOriginalArticle: (url: string, bounds: OriginalViewBounds) =>
    ipcRenderer.invoke(IPC_CHANNELS.openOriginalArticle, url, bounds),
  updateOriginalArticleBounds: (bounds: OriginalViewBounds) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateOriginalArticleBounds, bounds),
  navigateOriginalArticle: (action: OriginalNavigationAction) =>
    ipcRenderer.invoke(IPC_CHANNELS.navigateOriginalArticle, action),
  closeOriginalArticle: () => ipcRenderer.invoke(IPC_CHANNELS.closeOriginalArticle),
  getOriginalArticleState: () => ipcRenderer.invoke(IPC_CHANNELS.getOriginalArticleState),
  onOriginalArticleStateChanged: (listener: (state: OriginalArticleViewState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: OriginalArticleViewState): void => listener(state)
    ipcRenderer.on(IPC_CHANNELS.originalArticleStateChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.originalArticleStateChanged, wrapped)
  },
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.openExternalUrl, url)
})

contextBridge.exposeInMainWorld('origread', api)

