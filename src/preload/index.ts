import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type OrigReadDesktopApi } from '../shared/contracts'
import type { DesktopSettingsPatch } from '../shared/settings'
import type { SyncRuntimeState } from '../shared/sync-runtime'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from '../shared/original-view'
import type { AiProviderPatch, AiSettingsPatch } from '../shared/ai'
import type { TranslationProviderPatch, TranslationProviderType, TranslationSettingsPatch, TranslationTarget } from '../shared/translation'
import type { ArticleFilterRuleType } from '../shared/filter-rules'

const api: OrigReadDesktopApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getLibrarySnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getLibrarySnapshot),
  listFeeds: () => ipcRenderer.invoke(IPC_CHANNELS.listFeeds),
  listArticles: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.listArticles, limit),
  setArticleUnread: (articleId: string, unread: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleUnread, articleId, unread),
  setArticleStarred: (articleId: string, starred: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleStarred, articleId, starred),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  updateSettings: (patch: DesktopSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, patch),
  addRssSource: (inputUrl: string) => ipcRenderer.invoke(IPC_CHANNELS.addRssSource, inputUrl),
  refreshRssSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshRssSource, feedId),
  getRssHubSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getRssHubSettings),
  setRssHubEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setRssHubEnabled, enabled),
  addRssHubInstance: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.addRssHubInstance, url),
  setRssHubInstanceEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setRssHubInstanceEnabled, id, enabled),
  deleteRssHubInstance: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteRssHubInstance, id),
  testRssHubInstance: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.testRssHubInstance, url),
  listJsonRules: () => ipcRenderer.invoke(IPC_CHANNELS.listJsonRules),
  importJsonRules: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.importJsonRules, content),
  exportJsonRules: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRules),
  exportJsonRuleTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRuleTemplate),
  setJsonRuleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setJsonRuleEnabled, id, enabled),
  deleteJsonRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteJsonRule, id),
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
  getReaderContent: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.getReaderContent, articleId),
  fetchFullContent: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.fetchFullContent, articleId),
  getAiSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getAiSettings),
  updateAiSettings: (patch: AiSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiSettings, patch),
  addAiProvider: () => ipcRenderer.invoke(IPC_CHANNELS.addAiProvider),
  updateAiProvider: (patch: AiProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiProvider, patch),
  removeAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeAiProvider, providerId),
  refreshAiModels: (providerId: string, draftApiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshAiModels, providerId, draftApiKey),
  testAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.testAiProvider, providerId),
  summarizeArticle: (articleId: string, forceRefresh?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.summarizeArticle, articleId, forceRefresh),
  getTranslationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getTranslationSettings),
  updateTranslationSettings: (patch: TranslationSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationSettings, patch),
  updateTranslationProvider: (patch: TranslationProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationProvider, patch),
  testTranslationProvider: (type: TranslationProviderType) => ipcRenderer.invoke(IPC_CHANNELS.testTranslationProvider, type),
  translateArticle: (articleId: string, target?: TranslationTarget, forceRefresh?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.translateArticle, articleId, target, forceRefresh),
  getArticleFilters: () => ipcRenderer.invoke(IPC_CHANNELS.getArticleFilters),
  addArticleFilter: (keyword: string, type: ArticleFilterRuleType, feedId?: string | null) => ipcRenderer.invoke(IPC_CHANNELS.addArticleFilter, keyword, type, feedId),
  setArticleFilterEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setArticleFilterEnabled, id, enabled),
  deleteArticleFilter: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteArticleFilter, id),
  getWebsiteSourceRuleSettings: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.getWebsiteSourceRuleSettings, feedId),
  setWebsiteSourcePreferredRule: (feedId: string, ruleId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.setWebsiteSourcePreferredRule, feedId, ruleId),
  setWebsiteSourceDynamicRendering: (feedId: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setWebsiteSourceDynamicRendering, feedId, enabled),
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

