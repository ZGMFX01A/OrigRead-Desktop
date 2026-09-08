import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type FeedSettingsPatch, type OrigReadDesktopApi } from '../shared/contracts'
import type { DesktopSettingsPatch } from '../shared/settings'
import type { SyncRuntimeState } from '../shared/sync-runtime'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from '../shared/original-view'
import type { AiProviderPatch, AiSettingsPatch, AiSummaryProgress, AiSummaryRequestOptions, AiSummaryStreamUpdate } from '../shared/ai'
import type { TranslationProviderPatch, TranslationProviderType, TranslationSettingsPatch, TranslationTarget } from '../shared/translation'
import type { ArticleFilterRuleType } from '../shared/filter-rules'
import type { AiGeneratedRuleKind, AiRuleGenerationOptions, AiRuleGenerationProgress } from '../shared/ai-rule'
import type { SourceDiscoveryProgress } from '../shared/source-discovery'
import type { AccountCreateInput, AccountPatch } from '../shared/account'
import type {
  LlmAppendUserMessageRequest,
  LlmCreateConversationRequest,
  LlmExecuteManualToolRequest,
  LlmExecutionEvent,
  LlmReplaceConversationArticlesRequest,
  LlmStartExecutionRequest,
  LlmUpdateConversationRequest
} from '../shared/llm-ipc'
import type { LlmCustomizationSettingsPatch } from '../shared/llm-customization'
import type { LlmSkillCreateRequest, LlmSkillTask } from '../shared/llm-skill'
import type { WebSearchProviderKind, WebSearchProviderPatch, WebSearchSettingsPatch } from '../shared/web-search'
import type { McpLocalServerPatch, McpRemoteServerPatch } from '../shared/mcp'

const api: OrigReadDesktopApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getLibrarySnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getLibrarySnapshot),
  listFeeds: () => ipcRenderer.invoke(IPC_CHANNELS.listFeeds),
  listGroups: () => ipcRenderer.invoke(IPC_CHANNELS.listGroups),
  listArticles: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.listArticles, limit),
  getArticleById: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.getArticleById, articleId),
  searchArticles: (query: string, limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.searchArticles, query, limit),
  listArticlesByFeed: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.listArticlesByFeed, feedId),
  listArticlesByGroup: (groupId: string) => ipcRenderer.invoke(IPC_CHANNELS.listArticlesByGroup, groupId),
  listFeedArticleStats: () => ipcRenderer.invoke(IPC_CHANNELS.listFeedArticleStats),
  setArticleUnread: (articleId: string, unread: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleUnread, articleId, unread),
  setArticleStarred: (articleId: string, starred: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setArticleStarred, articleId, starred),
  getAccounts: () => ipcRenderer.invoke(IPC_CHANNELS.getAccounts),
  addAccount: (input: AccountCreateInput) => ipcRenderer.invoke(IPC_CHANNELS.addAccount, input),
  updateAccount: (patch: AccountPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAccount, patch),
  switchAccount: (accountId: number) => ipcRenderer.invoke(IPC_CHANNELS.switchAccount, accountId),
  deleteAccount: (accountId: number) => ipcRenderer.invoke(IPC_CHANNELS.deleteAccount, accountId),
  testAccountConnection: (accountId: number) => ipcRenderer.invoke(IPC_CHANNELS.testAccountConnection, accountId),
  clearAccountArticles: (accountId: number) => ipcRenderer.invoke(IPC_CHANNELS.clearAccountArticles, accountId),
  importAccountClientCertificate: (accountId: number, passphrase: string) => ipcRenderer.invoke(IPC_CHANNELS.importAccountClientCertificate, accountId, passphrase),
  clearAccountClientCertificate: (accountId: number) => ipcRenderer.invoke(IPC_CHANNELS.clearAccountClientCertificate, accountId),
  addGroup: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.addGroup, name),
  updateFeedSettings: (feedId: string, patch: FeedSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateFeedSettings, feedId, patch),
  clearFeedArticles: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.clearFeedArticles, feedId),
  deleteFeed: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteFeed, feedId),
  reloadFeedIcon: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.reloadFeedIcon, feedId),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  updateSettings: (patch: DesktopSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, patch),
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateState),
  checkForUpdates: (language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates, language),
  downloadUpdateAsset: (assetId: number) => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdateAsset, assetId),
  launchDownloadedUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.launchDownloadedUpdate),
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
  listJsonRulesForUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.listJsonRulesForUrl, url),
  importJsonRules: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.importJsonRules, content),
  exportJsonRules: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRules),
  exportJsonRuleTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.exportJsonRuleTemplate),
  setJsonRuleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setJsonRuleEnabled, id, enabled),
  deleteJsonRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteJsonRule, id),
  getRuleGuide: (kind: 'website' | 'json', language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.getRuleGuide, kind, language),
  getUserGuide: (language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.getUserGuide, language),
  generateAiRule: (kind: AiGeneratedRuleKind, url: string, options?: AiRuleGenerationOptions) => ipcRenderer.invoke(IPC_CHANNELS.generateAiRule, kind, url, options),
  saveAiGeneratedRule: (previewId: string) => ipcRenderer.invoke(IPC_CHANNELS.saveAiGeneratedRule, previewId),
  onAiRuleProgress: (listener: (progress: AiRuleGenerationProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: AiRuleGenerationProgress): void => listener(progress)
    ipcRenderer.on(IPC_CHANNELS.aiRuleProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aiRuleProgress, wrapped)
  },
  exportRuleTemplateFile: (kind: 'website' | 'json') => ipcRenderer.invoke(IPC_CHANNELS.exportRuleTemplateFile, kind),
  inspectWebsiteStatic: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectWebsiteStatic, url),
  inspectWebsiteDynamic: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectWebsiteDynamic, url),
  refreshWebsiteSource: (feedId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshWebsiteSource, feedId),
  listWebsiteRules: () => ipcRenderer.invoke(IPC_CHANNELS.listWebsiteRules),
  listWebsiteRulesForUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.listWebsiteRulesForUrl, url),
  importWebsiteRules: (content: string) => ipcRenderer.invoke(IPC_CHANNELS.importWebsiteRules, content),
  exportWebsiteRules: () => ipcRenderer.invoke(IPC_CHANNELS.exportWebsiteRules),
  exportWebsiteRuleTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.exportWebsiteRuleTemplate),
  setWebsiteRuleEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWebsiteRuleEnabled, id, enabled),
  deleteWebsiteRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteWebsiteRule, id),
  testWebsiteRule: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.testWebsiteRule, url),
  discoverSource: (url: string, requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.discoverSource, url, requestId),
  cancelSourceDiscovery: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelSourceDiscovery, requestId),
  onSourceDiscoveryProgress: (listener: (progress: SourceDiscoveryProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: SourceDiscoveryProgress): void => listener(progress)
    ipcRenderer.on(IPC_CHANNELS.sourceDiscoveryProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.sourceDiscoveryProgress, wrapped)
  },
  subscribeSource: (discoveryId: string, candidateIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.subscribeSource, discoveryId, candidateIds),
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
  revealAiApiKey: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealAiApiKey, providerId),
  updateAiSettings: (patch: AiSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiSettings, patch),
  addAiProvider: () => ipcRenderer.invoke(IPC_CHANNELS.addAiProvider),
  updateAiProvider: (patch: AiProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateAiProvider, patch),
  removeAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeAiProvider, providerId),
  refreshAiModels: (providerId: string, draftApiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshAiModels, providerId, draftApiKey),
  testAiProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.testAiProvider, providerId),
  getWebSearchSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getWebSearchSettings),
  revealWebSearchApiKey: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealWebSearchApiKey, providerId),
  updateWebSearchSettings: (patch: WebSearchSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateWebSearchSettings, patch),
  addWebSearchProvider: (kind: WebSearchProviderKind) => ipcRenderer.invoke(IPC_CHANNELS.addWebSearchProvider, kind),
  updateWebSearchProvider: (patch: WebSearchProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateWebSearchProvider, patch),
  removeWebSearchProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeWebSearchProvider, providerId),
  testWebSearchProvider: (providerId: string) => ipcRenderer.invoke(IPC_CHANNELS.testWebSearchProvider, providerId),
  getMcpRemoteSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpRemoteSettings),
  revealMcpRemoteCredential: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealMcpRemoteCredential, serverId),
  getMcpConnectionStates: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpConnectionStates),
  addMcpRemoteServer: () => ipcRenderer.invoke(IPC_CHANNELS.addMcpRemoteServer),
  updateMcpRemoteServer: (patch: McpRemoteServerPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateMcpRemoteServer, patch),
  removeMcpRemoteServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeMcpRemoteServer, serverId),
  testMcpRemoteServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.testMcpRemoteServer, serverId),
  connectMcpRemoteServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.connectMcpRemoteServer, serverId),
  authorizeMcpRemoteServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.authorizeMcpRemoteServer, serverId),
  disconnectMcpRemoteServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.disconnectMcpRemoteServer, serverId),
  getMcpLocalSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpLocalSettings),
  revealMcpLocalEnvironment: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealMcpLocalEnvironment, serverId),
  getMcpLocalConnectionStates: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpLocalConnectionStates),
  addMcpLocalServer: () => ipcRenderer.invoke(IPC_CHANNELS.addMcpLocalServer),
  updateMcpLocalServer: (patch: McpLocalServerPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateMcpLocalServer, patch),
  removeMcpLocalServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeMcpLocalServer, serverId),
  testMcpLocalServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.testMcpLocalServer, serverId),
  connectMcpLocalServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.connectMcpLocalServer, serverId),
  disconnectMcpLocalServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.disconnectMcpLocalServer, serverId),
  getMcpToolCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.getMcpToolCatalog),
  refreshMcpToolCatalog: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.refreshMcpToolCatalog, serverId),
  summarizeArticle: (articleId: string, forceRefresh?: boolean, options?: AiSummaryRequestOptions) => ipcRenderer.invoke(IPC_CHANNELS.summarizeArticle, articleId, forceRefresh, options),
  stopAiSummary: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.stopAiSummary, articleId),
  onAiSummaryProgress: (listener: (progress: AiSummaryProgress) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: AiSummaryProgress): void => listener(progress)
    ipcRenderer.on(IPC_CHANNELS.aiSummaryProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aiSummaryProgress, wrapped)
  },
  onAiSummaryStreamUpdate: (listener: (update: AiSummaryStreamUpdate) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, update: AiSummaryStreamUpdate): void => listener(update)
    ipcRenderer.on(IPC_CHANNELS.aiSummaryStreamUpdate, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.aiSummaryStreamUpdate, wrapped)
  },
  getLlmCustomizationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getLlmCustomizationSettings),
  updateLlmCustomizationSettings: (patch: LlmCustomizationSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateLlmCustomizationSettings, patch),
  getLlmSkills: () => ipcRenderer.invoke(IPC_CHANNELS.getLlmSkills),
  importLlmSkill: () => ipcRenderer.invoke(IPC_CHANNELS.importLlmSkill),
  createLlmSkill: (request: LlmSkillCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.createLlmSkill, request),
  getLlmSkillPreview: (skillId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmSkillPreview, skillId),
  setLlmSkillEnabled: (skillId: string, enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setLlmSkillEnabled, skillId, enabled),
  deleteLlmSkill: (skillId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteLlmSkill, skillId),
  setLlmSkillBinding: (task: LlmSkillTask, skillId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.setLlmSkillBinding, task, skillId),
  getLlmQuickMessages: (language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.getLlmQuickMessages, language),
  createLlmQuickMessage: (title: string, content: string, language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.createLlmQuickMessage, title, content, language),
  updateLlmQuickMessage: (id: string, title: string, content: string, language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.updateLlmQuickMessage, id, title, content, language),
  setLlmQuickMessageEnabled: (id: string, enabled: boolean, language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.setLlmQuickMessageEnabled, id, enabled, language),
  deleteLlmQuickMessage: (id: string, language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.deleteLlmQuickMessage, id, language),
  moveLlmQuickMessage: (id: string, direction: -1 | 1, language: 'zh' | 'en') => ipcRenderer.invoke(IPC_CHANNELS.moveLlmQuickMessage, id, direction, language),
  listLlmConversations: (articleId?: string | null) => ipcRenderer.invoke(IPC_CHANNELS.listLlmConversations, articleId),
  createLlmConversation: (request: LlmCreateConversationRequest) => ipcRenderer.invoke(IPC_CHANNELS.createLlmConversation, request),
  updateLlmConversation: (request: LlmUpdateConversationRequest) => ipcRenderer.invoke(IPC_CHANNELS.updateLlmConversation, request),
  deleteLlmConversation: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteLlmConversation, conversationId),
  listLlmArticleContextCandidates: (query?: string) => ipcRenderer.invoke(IPC_CHANNELS.listLlmArticleContextCandidates, query),
  getLlmConversationArticles: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmConversationArticles, conversationId),
  replaceLlmConversationArticles: (request: LlmReplaceConversationArticlesRequest) => ipcRenderer.invoke(IPC_CHANNELS.replaceLlmConversationArticles, request),
  getLlmMessages: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmMessages, conversationId),
  appendLlmUserMessage: (request: LlmAppendUserMessageRequest) => ipcRenderer.invoke(IPC_CHANNELS.appendLlmUserMessage, request),
  getLlmToolActivity: (conversationId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmToolActivity, conversationId),
  resolveLlmToolApproval: (toolCallId: string, decision: 'APPROVE' | 'DENY') => ipcRenderer.invoke(IPC_CHANNELS.resolveLlmToolApproval, toolCallId, decision),
  listLlmManualTools: () => ipcRenderer.invoke(IPC_CHANNELS.listLlmManualTools),
  executeLlmManualTool: (request: LlmExecuteManualToolRequest) => ipcRenderer.invoke(IPC_CHANNELS.executeLlmManualTool, request),
  discardLlmManualToolContext: (contextId: string) => ipcRenderer.invoke(IPC_CHANNELS.discardLlmManualToolContext, contextId),
  getLlmAssistantEvidence: (assistantMessageId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmAssistantEvidence, assistantMessageId),
  getLlmRestorableCitation: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.getLlmRestorableCitation, articleId),
  startLlmExecution: (request: LlmStartExecutionRequest) => ipcRenderer.invoke(IPC_CHANNELS.startLlmExecution, request),
  cancelLlmExecution: (requestId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelLlmExecution, requestId),
  onLlmExecutionEvent: (listener: (event: LlmExecutionEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, executionEvent: LlmExecutionEvent): void => listener(executionEvent)
    ipcRenderer.on(IPC_CHANNELS.llmExecutionEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.llmExecutionEvent, wrapped)
  },
  getTranslationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getTranslationSettings),
  getTranslationApiKey: (type: TranslationProviderType) => ipcRenderer.invoke(IPC_CHANNELS.getTranslationApiKey, type),
  updateTranslationSettings: (patch: TranslationSettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationSettings, patch),
  updateTranslationProvider: (patch: TranslationProviderPatch) => ipcRenderer.invoke(IPC_CHANNELS.updateTranslationProvider, patch),
  testTranslationProvider: (type: TranslationProviderType) => ipcRenderer.invoke(IPC_CHANNELS.testTranslationProvider, type),
  getDeepLUsage: () => ipcRenderer.invoke(IPC_CHANNELS.getDeepLUsage),
  translateArticle: (articleId: string, target?: TranslationTarget, forceRefresh?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.translateArticle, articleId, target, forceRefresh),
  stopTranslation: (articleId: string) => ipcRenderer.invoke(IPC_CHANNELS.stopTranslation, articleId),
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

