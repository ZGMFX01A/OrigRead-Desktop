import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, powerMonitor, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { IPC_CHANNELS, type AppInfo, type FeedSettingsPatch } from '../shared/contracts'
import { resolveBrandName } from '../shared/locale'
import { DesktopDatabase } from './database/database'
import { LibraryRepository } from './database/library-repository'
import { SettingsRepository } from './database/settings-repository'
import { normalizeDesktopSettingsPatch } from '../shared/settings'
import { RssSubscriptionService } from './sources/rss/rss-subscription-service'
import { RssDiscoveryService } from './sources/rss/rss-discovery-service'
import { BestIconFinder, extractIconDomain } from './sources/rss/best-icon-finder'
import { loadBundledRssHubRoutes } from './sources/rsshub/rsshub-route-catalog'
import { RssHubRouteMatcher } from './sources/rsshub/rsshub-route-matcher'
import { RssHubResolver } from './sources/rsshub/rsshub-resolver'
import { RssHubSettingsRepository } from './sources/rsshub/rsshub-settings-repository'
import { JsonArticleParser } from './sources/json/json-article-parser'
import { JsonRuleRepository } from './sources/json/json-rule-repository'
import { JsonSourceService } from './sources/json/json-source-service'
import { JsonSubscriptionService } from './sources/json/json-subscription-service'
import { WebsiteRuleRepository } from './sources/website/website-rule-repository'
import { WebsiteParsePreferenceRepository } from './sources/website/website-parse-preference-repository'
import { WebsiteSourceService } from './sources/website/website-source-service'
import { WebsiteSubscriptionService } from './sources/website/website-subscription-service'
import { ElectronDynamicWebsiteRenderer } from './sources/website/electron-dynamic-website-renderer'
import { RssHubSubscriptionService } from './sources/rsshub/rsshub-subscription-service'
import { SourceDiscoveryService } from './sources/source-discovery-service'
import { SourceSyncService } from './sources/source-sync-service'
import { ReaderContentService } from './content/reader-content-service'
import { ReaderFontRepository } from './fonts/reader-font-repository'
import { ContentExtractionService } from './content/content-extraction-service'
import {
  ReadabilityContentExtractor,
  StructuredMetadataContentExtractor,
  WeChatArticleContentExtractor,
  WebsiteRuleContentExtractor
} from './content/content-extractors'
import { DynamicArticleContentService } from './content/dynamic-article-content-service'
import { ArticleFullContentService } from './content/article-full-content-service'
import { withReaderImageReferer } from './content/reader-image-request-headers'
import {
  OriginalArticleViewController,
  validateOriginalViewBounds
} from './content/original-article-view-controller'
import type { OriginalNavigationAction } from '../shared/original-view'
import { PeriodicSyncScheduler } from './sync/periodic-sync-scheduler'
import { ElectronSecretStore } from './security/secret-store'
import { isAllowedRendererUrl } from './security/renderer-trust'
import { AiSettingsRepository } from './ai/ai-settings-repository'
import { AiSummaryService } from './ai/ai-summary-service'
import { TranslationSettingsRepository } from './translation/translation-settings-repository'
import { TranslationService } from './translation/translation-service'
import { ArticleFilterRepository } from './filter/article-filter-repository'
import { ConfigurationBackupService } from './backup/configuration-backup-service'
import { OpmlService } from './import-export/opml-service'
import { FeedDiscoveryCatalog } from './discovery/feed-discovery-catalog'
import { AiRuleGenerationService } from './ai/ai-rule-generation-service'
import type { AiProviderPatch, AiSettingsPatch, AiSummaryLength, AiSummaryRequestOptions } from '../shared/ai'
import type { AiGeneratedRuleKind, AiRuleGenerationOptions } from '../shared/ai-rule'
import type { TranslationProviderPatch, TranslationProviderType, TranslationSettingsPatch, TranslationTarget } from '../shared/translation'
import type { ArticleFilterRuleType } from '../shared/filter-rules'
import type { UpdateCheckResult } from '../shared/update'
import { ReleaseUpdateService } from './update/release-update-service'
import { DESKTOP_BROWSER_USER_AGENT } from './network/user-agent-policy'
import { AccountRepository } from './accounts/account-repository'
import { RemoteAccountSyncService } from './accounts/remote-account-sync-service'
import { AccountSyncSettingsProvider, DesktopAccountService } from './accounts/desktop-account-service'
import type { AccountCreateInput, AccountPatch, AccountType } from '../shared/account'
import type {
  LlmAppendUserMessageRequest,
  LlmCreateConversationRequest,
  LlmExecuteManualToolRequest,
  LlmReaderContextSnapshot,
  LlmReplaceConversationArticlesRequest,
  LlmStartExecutionRequest,
  LlmStartExecutionProfile,
  LlmUpdateConversationRequest
} from '../shared/llm-ipc'
import type { LlmConversationRecord } from '../shared/llm-chat'
import type { LlmContextItem } from '../shared/llm-context'
import { LlmChatRepository } from './llm/chat-repository'
import { OpenAiCompatibleLlmAdapter } from './llm/openai-compatible-llm-adapter'
import { LlmContextComposer } from './llm/context-composer'
import { LlmToolRuntime } from './llm/tool-runtime'
import { ManualToolContextService } from './llm/manual-tool-context-service'
import { LlmRuntime, type LlmExecutionProfile } from './llm/execution-runtime'
import { LlmSkillRepository } from './llm/skill-repository'
import { LlmSkillRouter } from './llm/skill-router'
import { LlmCustomizationSettingsRepository } from './llm/customization-settings-repository'
import { LlmQuickMessageRepository } from './llm/quick-message-repository'
import { LlmTaskPromptCustomizer } from './llm/prompt-customization'
import { LlmExecutionRegistry } from './llm/execution-registry'
import { LlmChatExecutionService, type LlmExecutionEvidenceGroup } from './llm/chat-execution-service'
import { buildArticleEvidenceBlocks, buildSelectionEvidenceBlock } from './llm/evidence-block-builder'
import {
  buildReaderStateContextItems,
  buildRegeneratedReaderSelectionContextItems,
  validateLlmReaderContextSnapshot
} from './llm/reader-context-builder'
import {
  CURRENT_ARTICLE_CONTEXT_PRIORITY,
  additionalArticleContextPriority
} from './llm/context-priority'
import { OpenAiCompatibleProvider } from './ai/openai-compatible-provider'
import { normalizeLlmCustomizationSettingsPatch } from '../shared/llm-customization'
import { LLM_SKILL_TASKS, type LlmSkillManagementSnapshot, type LlmSkillState, type LlmSkillTask } from '../shared/llm-skill'
import { MAX_LLM_SKILL_IMPORT_BYTES } from './llm/skill-repository'
import { WebSearchRepository } from './search/web-search-repository'
import { WebSearchService } from './search/web-search-service'
import { WebSearchRouter } from './search/web-search-router'
import { WEB_SEARCH_PROVIDER_KINDS, type WebSearchProviderKind, type WebSearchProviderPatch, type WebSearchSettingsPatch } from '../shared/web-search'
import { McpRemoteRepository } from './mcp/mcp-remote-repository'
import { McpRemoteClientManager, createSdkMcpRemoteConnectorFactory } from './mcp/mcp-remote-client-manager'
import { createMcpOAuthProviderSession } from './mcp/mcp-oauth-provider'
import { McpToolCatalogService } from './mcp/mcp-tool-catalog-service'
import { McpToolRuntimeBridge } from './mcp/mcp-tool-runtime-bridge'
import { McpLocalRepository } from './mcp/mcp-local-repository'
import { McpLocalClientManager, createSdkMcpLocalConnectorFactory } from './mcp/mcp-local-client-manager'
import { McpCombinedRuntime } from './mcp/mcp-combined-runtime'
import type { McpLocalServerPatch, McpRemoteServerPatch } from '../shared/mcp'

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL)
const productionRendererUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
if (process.env.ORIGREAD_E2E_USER_DATA_DIR) {
  app.setPath('userData', process.env.ORIGREAD_E2E_USER_DATA_DIR)
}

function validateOriginalNavigationAction(value: unknown): OriginalNavigationAction {
  if (value === 'back' || value === 'forward' || value === 'reload') return value
  throw new TypeError('Unsupported original article navigation action')
}
let mainWindow: BrowserWindow | null = null
let desktopDatabase: DesktopDatabase | null = null
let libraryRepository: LibraryRepository | null = null
let settingsRepository: SettingsRepository | null = null
let releaseUpdateService: ReleaseUpdateService | null = null
let lastUpdateCheck: UpdateCheckResult | null = null
let lastDownloadedUpdatePath: string | null = null
let readerFontRepository: ReaderFontRepository | null = null
let rssSubscriptionService: RssSubscriptionService | null = null
let rssHubSettingsRepository: RssHubSettingsRepository | null = null
let rssHubResolver: RssHubResolver | null = null
let jsonRuleRepository: JsonRuleRepository | null = null
let jsonSourceService: JsonSourceService | null = null
let jsonSubscriptionService: JsonSubscriptionService | null = null
let websiteRuleRepository: WebsiteRuleRepository | null = null
let websitePreferenceRepository: WebsiteParsePreferenceRepository | null = null
let websiteSourceService: WebsiteSourceService | null = null
let websiteSubscriptionService: WebsiteSubscriptionService | null = null
let rssHubSubscriptionService: RssHubSubscriptionService | null = null
let sourceDiscoveryService: SourceDiscoveryService | null = null
let sourceSyncService: SourceSyncService | null = null
let readerContentService: ReaderContentService | null = null
let articleFullContentService: ArticleFullContentService | null = null
let originalArticleViewController: OriginalArticleViewController | null = null
let periodicSyncScheduler: PeriodicSyncScheduler | null = null
let aiSettingsRepository: AiSettingsRepository | null = null
let aiSummaryService: AiSummaryService | null = null
let webSearchRepository: WebSearchRepository | null = null
let webSearchService: WebSearchService | null = null
let webSearchRouter: WebSearchRouter | null = null
let mcpRemoteRepository: McpRemoteRepository | null = null
let mcpRemoteClientManager: McpRemoteClientManager | null = null
let mcpLocalRepository: McpLocalRepository | null = null
let mcpLocalClientManager: McpLocalClientManager | null = null
let mcpCombinedRuntime: McpCombinedRuntime | null = null
let mcpToolCatalogService: McpToolCatalogService | null = null
let mcpToolRuntimeBridge: McpToolRuntimeBridge | null = null
let activeAiSummaryRequest: { articleId: string; controller: AbortController } | null = null
let translationSettingsRepository: TranslationSettingsRepository | null = null
let translationService: TranslationService | null = null
let activeTranslationRequest: { articleId: string; controller: AbortController } | null = null
let articleFilterRepository: ArticleFilterRepository | null = null
let configurationBackupService: ConfigurationBackupService | null = null
let opmlService: OpmlService | null = null
let feedDiscoveryCatalog: FeedDiscoveryCatalog | null = null
let aiRuleGenerationService: AiRuleGenerationService | null = null
let accountRepository: AccountRepository | null = null
let accountService: DesktopAccountService | null = null
let llmChatRepository: LlmChatRepository | null = null
let llmSkillRepository: LlmSkillRepository | null = null
let llmSkillRouter: LlmSkillRouter | null = null
let llmCustomizationSettingsRepository: LlmCustomizationSettingsRepository | null = null
let llmQuickMessageRepository: LlmQuickMessageRepository | null = null
let llmToolRuntime: LlmToolRuntime | null = null
let manualToolContextService: ManualToolContextService | null = null
let llmRuntime: LlmRuntime | null = null
let llmExecutionService: LlmChatExecutionService | null = null
const llmExecutionRegistry = new LlmExecutionRegistry()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function localizedAppName(): string {
  return resolveBrandName(app.getLocale())
}

function validateExternalHttpUrl(value: unknown): string {
  const raw = validateUrlInput(value)
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Only http and https external URLs are supported')
  }
  return parsed.toString()
}

function validateUrlInput(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096) {
    throw new TypeError('Source URL must be a non-empty string')
  }
  return value.trim()
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? ''
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error('Rejected IPC request from an untrusted renderer')
  }
}

function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options)
}

function showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue> {
  return mainWindow ? dialog.showSaveDialog(mainWindow, options) : dialog.showSaveDialog(options)
}

function isTrustedRendererUrl(url: string): boolean {
  return isAllowedRendererUrl(url, {
    developmentUrl: isDevelopment ? process.env.ELECTRON_RENDERER_URL : null,
    productionUrl: productionRendererUrl
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: localizedAppName(),
    backgroundColor: '#f5f5f7',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: isDevelopment
    }
  })
  mainWindow = window
  // Renderer 本身加载本地 UI，但正文中的远程图片/媒体仍属于普通网页资源请求。
  // 统一使用 Desktop Chrome UA，避免这些子资源继续暴露 Electron 默认 UA。
  window.webContents.setUserAgent(DESKTOP_BROWSER_USER_AGENT)
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      callback({
        requestHeaders: withReaderImageReferer({
          url: details.url,
          resourceType: details.resourceType,
          requestHeaders: details.requestHeaders
        })
      })
    }
  )
  originalArticleViewController?.dispose()
  originalArticleViewController = new OriginalArticleViewController(window, (state) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.originalArticleStateChanged, state)
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const llmOwnerId = String(window.webContents.id)
  window.webContents.once('destroyed', () => {
    llmExecutionRegistry.cancelOwner(llmOwnerId, 'Renderer was destroyed')
  })
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) {
      event.preventDefault()
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) {
      event.preventDefault()
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    originalArticleViewController?.dispose()
    originalArticleViewController = null
  })

  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getAppInfo, (event): AppInfo => {
    assertTrustedSender(event)
    return {
      version: app.getVersion(),
      locale: app.getLocale(),
      platform: process.platform,
      arch: process.arch
    }
  })
  ipcMain.handle(IPC_CHANNELS.getLibrarySnapshot, (event) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.listFeeds, (event) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.listFeeds()
  })
  ipcMain.handle(IPC_CHANNELS.listGroups, (event) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.listGroups()
  })
  ipcMain.handle(IPC_CHANNELS.listArticles, (event, limit?: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
      throw new TypeError('Article limit must be a finite number')
    }
    return libraryRepository.listArticles(limit === undefined ? 200 : limit)
  })
  ipcMain.handle(IPC_CHANNELS.getArticleById, (event, articleId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.getArticleById(validateId(articleId, 'articleId'))
  })
  ipcMain.handle(IPC_CHANNELS.searchArticles, (event, query: unknown, limit?: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const validatedQuery = validateText(query, 'query', 200).trim()
    if (!validatedQuery) return []
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
      throw new TypeError('Search limit must be a finite number')
    }
    return libraryRepository.searchArticles(validatedQuery, limit === undefined ? 100 : limit)
  })
  ipcMain.handle(IPC_CHANNELS.listArticlesByFeed, (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.listArticlesByFeed(validateId(feedId, 'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.listArticlesByGroup, (event, groupId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.listArticlesByGroup(validateId(groupId, 'groupId'))
  })
  ipcMain.handle(IPC_CHANNELS.listFeedArticleStats, (event) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    return libraryRepository.listFeedArticleStats()
  })
  ipcMain.handle(IPC_CHANNELS.setArticleUnread, async (event, articleId: unknown, unread: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    await accountService.markArticleUnread(validateId(articleId, 'articleId'), validateBoolean(unread, 'unread'))
  })
  ipcMain.handle(IPC_CHANNELS.setArticleStarred, async (event, articleId: unknown, starred: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    await accountService.markArticleStarred(validateId(articleId, 'articleId'), validateBoolean(starred, 'starred'))
  })
  ipcMain.handle(IPC_CHANNELS.getAccounts, (event) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    return accountService.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.addAccount, async (event, input: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    const validated = validateAccountCreateInput(input)
    if (validated.useClientCertificate) {
      const selected = await dialog.showOpenDialog({
        title: '选择客户端证书',
        properties: ['openFile'],
        filters: [{ name: 'PKCS#12 client certificate', extensions: ['p12', 'pfx'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) throw new Error('客户端证书选择已取消')
      const bytes = readFileSync(selected.filePaths[0])
      if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('客户端证书文件无效或过大')
      validated.clientCertificateBase64 = bytes.toString('base64')
    }
    const result = await accountService.add(validated)
    periodicSyncScheduler?.reconfigure()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.updateAccount, (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    const result = accountService.update(validateAccountPatch(patch))
    periodicSyncScheduler?.reconfigure()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.switchAccount, (event, accountId: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    const result = accountService.switchTo(validateAccountId(accountId))
    periodicSyncScheduler?.reconfigure()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.deleteAccount, (event, accountId: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    const result = accountService.delete(validateAccountId(accountId))
    periodicSyncScheduler?.reconfigure()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.testAccountConnection, async (event, accountId: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    return accountService.testConnection(validateAccountId(accountId))
  })
  ipcMain.handle(IPC_CHANNELS.clearAccountArticles, (event, accountId: unknown) => {
    assertTrustedSender(event)
    if (!accountService) throw new Error('Account service is not ready')
    accountService.clearArticles(validateAccountId(accountId))
  })
  ipcMain.handle(IPC_CHANNELS.importAccountClientCertificate, async (event, accountId: unknown, passphrase: unknown) => {
    assertTrustedSender(event)
    if (!accountRepository) throw new Error('Account repository is not ready')
    const id = validateAccountId(accountId)
    if (typeof passphrase !== 'string' || passphrase.length > 4_096) throw new TypeError('client certificate passphrase is invalid')
    const selected = await dialog.showOpenDialog({
      title: '选择客户端证书',
      properties: ['openFile'],
      filters: [{ name: 'PKCS#12 client certificate', extensions: ['p12', 'pfx'] }]
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return accountRepository.setClientCertificate(id, readFileSync(selected.filePaths[0]), passphrase)
  })
  ipcMain.handle(IPC_CHANNELS.clearAccountClientCertificate, (event, accountId: unknown) => {
    assertTrustedSender(event)
    if (!accountRepository) throw new Error('Account repository is not ready')
    return accountRepository.clearClientCertificate(validateAccountId(accountId))
  })
  ipcMain.handle(IPC_CHANNELS.addGroup, async (event, name: unknown) => {
    assertTrustedSender(event)
    if (!accountService || !libraryRepository) throw new Error('Account service is not ready')
    const normalizedName = validateText(name, 'groupName', 200).trim()
    const groups = libraryRepository.listGroups()
    if (!groups.some((group) => group.name === normalizedName)) {
      await accountService.addGroup(normalizedName)
    }
    return libraryRepository.listGroups()
  })
  ipcMain.handle(IPC_CHANNELS.updateFeedSettings, async (event, feedId: unknown, patch: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository || !accountService) throw new Error('Account service is not ready')
    const id = validateId(feedId, 'feedId')
    const current = libraryRepository.getFeedById(id)
    if (!current) throw new Error('来源不存在')
    const nextPatch = validateFeedSettingsPatch(patch)
    if (nextPatch.groupId && !libraryRepository.listGroups().some((group) => group.id === nextPatch.groupId)) throw new Error('分组不存在')
    const normalizedPatch = {
      ...nextPatch,
      isFullContent: nextPatch.isFullContent === true ? true : (nextPatch.isBrowser === true ? false : nextPatch.isFullContent ?? current.isFullContent),
      isBrowser: nextPatch.isBrowser === true ? true : (nextPatch.isFullContent === true ? false : nextPatch.isBrowser ?? current.isBrowser),
    }
    return accountService.updateFeed(id, normalizedPatch)
  })
  ipcMain.handle(IPC_CHANNELS.clearFeedArticles, (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const id = validateId(feedId, 'feedId')
    if (!libraryRepository.getFeedById(id)) throw new Error('来源不存在')
    libraryRepository.deleteArticlesByFeed(id, false)
  })
  ipcMain.handle(IPC_CHANNELS.deleteFeed, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository || !accountService) throw new Error('Account service is not ready')
    const id = validateId(feedId, 'feedId')
    if (!libraryRepository.getFeedById(id)) return
    articleFilterRepository?.deleteByFeed(id)
    websitePreferenceRepository?.delete(id)
    await accountService.deleteFeed(id)
  })
  ipcMain.handle(IPC_CHANNELS.reloadFeedIcon, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const id = validateId(feedId, 'feedId')
    const feed = libraryRepository.getFeedById(id)
    if (!feed) throw new Error('来源不存在')
    const icon = await new BestIconFinder().findBestIcon(extractIconDomain(feed.url))
    if (!icon) throw new Error('未找到可用来源图标')
    const next = { ...feed, icon, updatedAt: Date.now() }
    libraryRepository.upsertFeed(next)
    return next
  })
  ipcMain.handle(IPC_CHANNELS.getSettings, (event) => {
    assertTrustedSender(event)
    if (!settingsRepository) throw new Error('OrigRead settings are not ready')
    return settingsRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.updateSettings, (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!settingsRepository) throw new Error('OrigRead settings are not ready')
    const next = settingsRepository.update(normalizeDesktopSettingsPatch(patch))
    periodicSyncScheduler?.reconfigure()
    return next
  })
  ipcMain.handle(IPC_CHANNELS.getUpdateState, (event) => {
    assertTrustedSender(event)
    return lastUpdateCheck
  })
  ipcMain.handle(IPC_CHANNELS.checkForUpdates, async (event, language: unknown) => {
    assertTrustedSender(event)
    if (!releaseUpdateService) throw new Error('更新服务尚未初始化')
    if (language !== 'zh' && language !== 'en') throw new TypeError('language must be zh or en')
    if (process.env.ORIGREAD_DISABLE_AUTO_UPDATE_CHECK === '1') {
      lastUpdateCheck = {
        status: 'unavailable',
        currentVersion: app.getVersion(),
        checkedAt: Date.now(),
        release: null,
        errorCode: 'DISABLED',
        errorMessage: '当前测试环境已关闭真实更新检查。'
      }
      return lastUpdateCheck
    }
    lastUpdateCheck = await releaseUpdateService.check(
      app.getVersion(),
      process.platform,
      process.arch,
      language,
      app.getLocale()
    )
    return lastUpdateCheck
  })
  ipcMain.handle(IPC_CHANNELS.downloadUpdateAsset, async (event, assetId: unknown) => {
    assertTrustedSender(event)
    if (!releaseUpdateService) throw new Error('更新服务尚未初始化')
    if (typeof assetId !== 'number' || !Number.isSafeInteger(assetId)) throw new TypeError('assetId must be an integer')
    const asset = lastUpdateCheck?.release?.asset
    if (!asset || asset.id !== assetId) throw new Error('当前没有可下载的安装包，请重新检查更新')
    const safeName = asset.name.replace(/[<>:"/\\|?*]/g, '_')
    const selected = process.env.ORIGREAD_E2E_DOWNLOAD_DIR
      ? { canceled: false, filePath: join(process.env.ORIGREAD_E2E_DOWNLOAD_DIR, safeName) }
      : await showSaveDialog({
          title: '下载 OrigRead Desktop 更新',
          defaultPath: join(app.getPath('downloads'), safeName),
          filters: [{ name: 'Installer', extensions: [safeName.split('.').pop() || 'bin'] }]
        })
    if (selected.canceled || !selected.filePath) return { cancelled: true, path: null, error: null }
    try {
      await releaseUpdateService.downloadAsset(asset, selected.filePath, app.getLocale())
      lastDownloadedUpdatePath = selected.filePath
      return { cancelled: false, path: selected.filePath, error: null }
    } catch (error) {
      return { cancelled: false, path: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.launchDownloadedUpdate, async (event) => {
    assertTrustedSender(event)
    if (!lastDownloadedUpdatePath) throw new Error('当前没有已下载的安装包')
    const error = await shell.openPath(lastDownloadedUpdatePath)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC_CHANNELS.listReaderFonts, (event) => {
    assertTrustedSender(event)
    if (!readerFontRepository) throw new Error('Reader font repository is not ready')
    return readerFontRepository.list()
  })
  ipcMain.handle(IPC_CHANNELS.importReaderFont, async (event) => {
    assertTrustedSender(event)
    if (!readerFontRepository) throw new Error('Reader font repository is not ready')
    try {
      const selected = await showOpenDialog({
        title: '导入阅读字体',
        properties: ['openFile'],
        filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true, font: null, error: null }
      return { ok: true, cancelled: false, font: readerFontRepository.importFile(selected.filePaths[0]), error: null }
    } catch (error) {
      return { ok: false, cancelled: false, font: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.deleteReaderFont, (event, id: unknown) => {
    assertTrustedSender(event)
    if (!readerFontRepository) throw new Error('Reader font repository is not ready')
    readerFontRepository.delete(validateId(id, 'fontId'))
    return readerFontRepository.list()
  })
  ipcMain.handle(IPC_CHANNELS.addRssSource, async (event, inputUrl: unknown) => {
    assertTrustedSender(event)
    if (!rssSubscriptionService || !accountService) throw new Error('RSS/account service is not ready')
    const url = validateUrlInput(inputUrl)
    if (accountService.current().type === 'local') return rssSubscriptionService.add(url)
    const discovered = await new RssDiscoveryService().discover(url)
    const feedId = await accountService.subscribeRss(discovered)
    return { feedId, feed: discovered, insertedArticles: 0 }
  })
  ipcMain.handle(IPC_CHANNELS.refreshRssSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!rssSubscriptionService || !accountService) throw new Error('RSS/account service is not ready')
    const id = validateId(feedId, 'feedId')
    if (accountService.current().type === 'local') return rssSubscriptionService.refresh(id)
    await accountService.syncCurrent()
    return { feedId: id, fetchedArticles: 0, insertedArticles: 0 }
  })
  ipcMain.handle(IPC_CHANNELS.getRssHubSettings, (event) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.setRssHubEnabled, (event, enabled: unknown) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.setEnabled(validateBoolean(enabled, 'enabled'))
  })
  ipcMain.handle(IPC_CHANNELS.addRssHubInstance, (event, url: unknown) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.addInstance(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.setRssHubInstanceEnabled, (event, id: unknown, enabled: unknown) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.setInstanceEnabled(
      validateId(id, 'instanceId'),
      validateBoolean(enabled, 'enabled')
    )
  })
  ipcMain.handle(IPC_CHANNELS.deleteRssHubInstance, (event, id: unknown) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.deleteInstance(validateId(id, 'instanceId'))
  })
  ipcMain.handle(IPC_CHANNELS.testRssHubInstance, async (event, url: unknown) => {
    assertTrustedSender(event)
    if (!rssHubResolver) throw new Error('RSSHub resolver is not ready')
    try {
      await rssHubResolver.testConnection(validateUrlInput(url))
      return { ok: true, error: null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.restoreDefaultRssHubSettings, (event) => {
    assertTrustedSender(event)
    if (!rssHubSettingsRepository) throw new Error('RSSHub settings are not ready')
    return rssHubSettingsRepository.restoreDefault()
  })
  ipcMain.handle(IPC_CHANNELS.getSourceCatalog, (event) => {
    assertTrustedSender(event)
    if (!feedDiscoveryCatalog) throw new Error('Source catalog is not ready')
    return feedDiscoveryCatalog.data
  })
  ipcMain.handle(IPC_CHANNELS.listJsonRules, (event) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.listRules()
  })
  ipcMain.handle(IPC_CHANNELS.listJsonRulesForUrl, (event, url: unknown) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.findConfiguredRules(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.importJsonRules, (event, content: unknown) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.importRules(validateText(content, 'content', 2_000_000))
  })
  ipcMain.handle(IPC_CHANNELS.exportJsonRules, (event) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.exportRules()
  })
  ipcMain.handle(IPC_CHANNELS.exportJsonRuleTemplate, (event) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.exportTemplate()
  })
  ipcMain.handle(IPC_CHANNELS.setJsonRuleEnabled, (event, id: unknown, enabled: unknown) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    jsonRuleRepository.setEnabled(validateId(id, 'ruleId'), validateBoolean(enabled, 'enabled'))
  })
  ipcMain.handle(IPC_CHANNELS.deleteJsonRule, (event, id: unknown) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    jsonRuleRepository.deleteRule(validateId(id, 'ruleId'))
  })
  ipcMain.handle(IPC_CHANNELS.getRuleGuide, (event, kind: unknown, language: unknown) => {
    assertTrustedSender(event)
    const ruleKind = validateGuideRuleKind(kind)
    const locale = language === 'zh' ? 'zh-CN' : language === 'en' ? 'en' : null
    if (!locale) throw new TypeError('Unknown guide language')
    return readFileSync(join(__dirname, `../../resources/rule-guides/${ruleKind}-rules-${locale}.md`), 'utf8')
  })
  ipcMain.handle(IPC_CHANNELS.getUserGuide, (event, language: unknown) => {
    assertTrustedSender(event)
    const locale = language === 'zh' ? 'zh-CN' : language === 'en' ? 'en' : null
    if (!locale) throw new TypeError('Unknown guide language')
    const fileName = locale === 'zh-CN' ? 'USER_GUIDE-zh-CN.md' : 'USER_GUIDE.md'
    return readFileSync(join(__dirname, `../../${fileName}`), 'utf8')
  })
  ipcMain.handle(IPC_CHANNELS.generateAiRule, async (event, kind: unknown, url: unknown, rawOptions?: unknown) => {
    assertTrustedSender(event)
    if (!aiRuleGenerationService) throw new Error('AI rule generation service is not ready')
    const sourceUrl = validateUrlInput(url)
    const options = validateAiRuleGenerationOptions(rawOptions)
    const requestId = options.requestId ?? randomUUID()
    const sendProgress = (stage: string, attempt: number, detail: string | null): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.aiRuleProgress, { requestId, stage, attempt, detail, at: Date.now() })
      }
    }
    sendProgress('PREPARING', 1, null)
    try {
      return validateAiRuleKind(kind) === 'WEBSITE'
        ? await aiRuleGenerationService.generateWebsiteRule(sourceUrl, options, sendProgress)
        : await aiRuleGenerationService.generateJsonRule(sourceUrl, options, sendProgress)
    } catch (error) {
      sendProgress('FAILED', 1, error instanceof Error ? error.message : String(error))
      throw error
    }
  })
  ipcMain.handle(IPC_CHANNELS.saveAiGeneratedRule, (event, previewId: unknown) => {
    assertTrustedSender(event)
    if (!aiRuleGenerationService) throw new Error('AI rule generation service is not ready')
    aiRuleGenerationService.save(validateId(previewId, 'previewId'))
  })
  ipcMain.handle(IPC_CHANNELS.exportRuleTemplateFile, async (event, kind: unknown) => {
    assertTrustedSender(event)
    const ruleKind = validateGuideRuleKind(kind)
    try {
      const content = ruleKind === 'website' ? websiteRuleRepository!.exportTemplate() : jsonRuleRepository!.exportTemplate()
      const selected = await showSaveDialog({
        title: ruleKind === 'website' ? '导出网站解析规则模板' : '导出 JSON 规则模板',
        defaultPath: ruleKind === 'website' ? 'website-rule-template.json' : 'json-rule-template.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (selected.canceled || !selected.filePath) return { ok:false,cancelled:true,path:null,error:null }
      writeFileSync(selected.filePath, content, 'utf8')
      return { ok:true,cancelled:false,path:selected.filePath,error:null }
    } catch (error) {
      return { ok:false,cancelled:false,path:null,error:error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.inspectWebsiteStatic, async (event, url: unknown) => {
    assertTrustedSender(event)
    if (!websiteSourceService) throw new Error('Website source service is not ready')
    return websiteSourceService.inspect(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.inspectWebsiteDynamic, async (event, url: unknown) => {
    assertTrustedSender(event)
    if (!websiteSourceService) throw new Error('Website source service is not ready')
    return websiteSourceService.inspectDynamic(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.refreshWebsiteSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!websiteSubscriptionService) throw new Error('Website subscription service is not ready')
    return websiteSubscriptionService.refresh(validateId(feedId, 'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.listWebsiteRules, (event) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    return websiteRuleRepository.listRules()
  })
  ipcMain.handle(IPC_CHANNELS.listWebsiteRulesForUrl, (event, url: unknown) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    return websiteRuleRepository.findConfiguredRules(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.importWebsiteRules, (event, content: unknown) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    return websiteRuleRepository.importRules(validateText(content, 'content', 2_000_000))
  })
  ipcMain.handle(IPC_CHANNELS.exportWebsiteRules, (event) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    return websiteRuleRepository.exportRules()
  })
  ipcMain.handle(IPC_CHANNELS.exportWebsiteRuleTemplate, (event) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    return websiteRuleRepository.exportTemplate()
  })
  ipcMain.handle(IPC_CHANNELS.setWebsiteRuleEnabled, (event, id: unknown, enabled: unknown) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    websiteRuleRepository.setEnabled(validateId(id, 'ruleId'), validateBoolean(enabled, 'enabled'))
  })
  ipcMain.handle(IPC_CHANNELS.deleteWebsiteRule, (event, id: unknown) => {
    assertTrustedSender(event)
    if (!websiteRuleRepository) throw new Error('Website rule repository is not ready')
    websiteRuleRepository.deleteRule(validateId(id, 'ruleId'))
  })
  ipcMain.handle(IPC_CHANNELS.testWebsiteRule, async (event, url: unknown) => {
    assertTrustedSender(event)
    if (!websiteSourceService) throw new Error('Website source service is not ready')
    try {
      const result = await websiteSourceService.inspect(validateUrlInput(url))
      return { ok:true,articleCount:result.candidate.articles.length,error:null }
    } catch (error) {
      return { ok:false,articleCount:0,error:error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.discoverSource, async (event, url: unknown, requestId: unknown) => {
    assertTrustedSender(event)
    if (!sourceDiscoveryService) throw new Error('Source discovery service is not ready')
    const validatedRequestId = validateText(requestId, 'requestId', 128)
    return sourceDiscoveryService.discover(validateUrlInput(url), (stage, state) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.sourceDiscoveryProgress, {
          requestId: validatedRequestId,
          stage,
          state,
          at: Date.now()
        })
      }
    })
  })
  ipcMain.handle(IPC_CHANNELS.subscribeSource, async (event, discoveryId: unknown, candidateIds: unknown) => {
    assertTrustedSender(event)
    if (!sourceDiscoveryService) throw new Error('Source discovery service is not ready')
    if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.length > 8) {
      throw new TypeError('candidateIds 必须包含 1 到 8 个来源候选')
    }
    return sourceDiscoveryService.subscribeMany(
      validateId(discoveryId, 'discoveryId'),
      [...new Set(candidateIds.map((candidateId) => validateText(candidateId, 'candidateId', 4_096)))]
    )
  })
  ipcMain.handle(IPC_CHANNELS.refreshJsonSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!jsonSubscriptionService) throw new Error('JSON subscription service is not ready')
    return jsonSubscriptionService.refresh(validateId(feedId, 'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.refreshSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!accountService || !libraryRepository) throw new Error('Account service is not ready')
    const id = validateId(feedId, 'feedId')
    if (accountService.current().type !== 'local') {
      await accountService.syncCurrent()
      const feed = libraryRepository.getFeedById(id)
      if (!feed) throw new Error('来源不存在')
      return { feedId:id, feedName:feed.name, sourceType:feed.sourceType, status:'success' as const, fetchedArticles:0, insertedArticles:0, deletedArticles:0, error:null }
    }
    if (!sourceSyncService) throw new Error('Source sync service is not ready')
    return sourceSyncService.refreshSource(id)
  })
  ipcMain.handle(IPC_CHANNELS.refreshAllSources, async (event) => {
    assertTrustedSender(event)
    if (periodicSyncScheduler) return periodicSyncScheduler.runNow('manual')
    if (!accountService) throw new Error('Account service is not ready')
    return accountService.refreshAllSources()
  })
  ipcMain.handle(IPC_CHANNELS.getSyncRuntimeState, (event) => {
    assertTrustedSender(event)
    if (!periodicSyncScheduler) throw new Error('Periodic sync scheduler is not ready')
    return periodicSyncScheduler.currentState()
  })
  ipcMain.handle(IPC_CHANNELS.getReaderContent, (event, articleId: unknown, preferFull?: unknown) => {
    assertTrustedSender(event)
    if (!readerContentService) throw new Error('Reader content service is not ready')
    return readerContentService.get(
      validateId(articleId, 'articleId'),
      preferFull === undefined ? true : validateBoolean(preferFull, 'preferFull')
    )
  })
  ipcMain.handle(IPC_CHANNELS.fetchFullContent, async (event, articleId: unknown) => {
    assertTrustedSender(event)
    if (!articleFullContentService) throw new Error('Full content service is not ready')
    return articleFullContentService.readOrFetch(validateId(articleId, 'articleId'), true)
  })
  ipcMain.handle(IPC_CHANNELS.getAiSettings, (event) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready'); return aiSettingsRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.revealAiApiKey, (event, providerId: unknown) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready'); return aiSettingsRepository.getApiKey(validateId(providerId, 'providerId'))
  })
  ipcMain.handle(IPC_CHANNELS.updateAiSettings, (event, patch: unknown) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready')
    const value = validateRecord(patch, 'AI settings patch') as AiSettingsPatch
    let result = aiSettingsRepository.current()
    if (value.enabled !== undefined) result = aiSettingsRepository.setEnabled(validateBoolean(value.enabled, 'enabled'))
    if (value.defaultProviderId !== undefined) result = aiSettingsRepository.setDefaultProvider(validateId(value.defaultProviderId, 'providerId'))
    if (value.outputLanguage !== undefined) result = aiSettingsRepository.setOutputLanguage(validateText(value.outputLanguage, 'outputLanguage', 64))
    if (value.summaryLength !== undefined) result = aiSettingsRepository.setSummaryLength(value.summaryLength)
    if (value.reasoningEffort !== undefined) result = aiSettingsRepository.setReasoningEffort(value.reasoningEffort)
    return result
  })
  ipcMain.handle(IPC_CHANNELS.addAiProvider, (event) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready'); return aiSettingsRepository.addProvider()
  })
  ipcMain.handle(IPC_CHANNELS.updateAiProvider, (event, patch: unknown) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready'); return aiSettingsRepository.updateProvider(validateRecord(patch, 'AI provider patch') as unknown as AiProviderPatch)
  })
  ipcMain.handle(IPC_CHANNELS.removeAiProvider, (event, providerId: unknown) => {
    assertTrustedSender(event); if (!aiSettingsRepository) throw new Error('AI settings are not ready'); return aiSettingsRepository.removeProvider(validateId(providerId, 'providerId'))
  })
  ipcMain.handle(IPC_CHANNELS.refreshAiModels, async (event, providerId: unknown, draftApiKey?: unknown) => {
    assertTrustedSender(event); if (!aiSummaryService) throw new Error('AI service is not ready'); return aiSummaryService.refreshModels(validateId(providerId, 'providerId'), draftApiKey === undefined ? undefined : validateOptionalText(draftApiKey, 'apiKey', 16_384))
  })
  ipcMain.handle(IPC_CHANNELS.testAiProvider, async (event, providerId: unknown) => {
    assertTrustedSender(event); if (!aiSummaryService) throw new Error('AI service is not ready'); try { await aiSummaryService.testProvider(validateId(providerId, 'providerId')); return { ok:true,error:null } } catch(error) { return { ok:false,error:error instanceof Error?error.message:String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.getWebSearchSettings, (event) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.revealWebSearchApiKey, (event, providerId: unknown) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.getApiKey(validateId(providerId, 'providerId'))
  })
  ipcMain.handle(IPC_CHANNELS.updateWebSearchSettings, (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.updateSettings(validateWebSearchSettingsPatch(patch))
  })
  ipcMain.handle(IPC_CHANNELS.addWebSearchProvider, (event, kind: unknown) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.addProvider(validateWebSearchProviderKind(kind))
  })
  ipcMain.handle(IPC_CHANNELS.updateWebSearchProvider, (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.updateProvider(validateWebSearchProviderPatch(patch))
  })
  ipcMain.handle(IPC_CHANNELS.removeWebSearchProvider, (event, providerId: unknown) => {
    assertTrustedSender(event)
    if (!webSearchRepository) throw new Error('Web Search settings are not ready')
    return webSearchRepository.removeProvider(validateId(providerId, 'providerId'))
  })
  ipcMain.handle(IPC_CHANNELS.testWebSearchProvider, async (event, providerId: unknown) => {
    assertTrustedSender(event)
    if (!webSearchService) throw new Error('Web Search service is not ready')
    try {
      return { ok: true, result: await webSearchService.checkHealth(validateId(providerId, 'providerId')), error: null }
    } catch (error) {
      return { ok: false, result: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.getMcpRemoteSettings, (event) => {
    assertTrustedSender(event)
    if (!mcpRemoteRepository) throw new Error('Remote MCP settings are not ready')
    return mcpRemoteRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.revealMcpRemoteCredential, (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteRepository) throw new Error('Remote MCP settings are not ready')
    return mcpRemoteRepository.getCredential(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.getMcpConnectionStates, (event) => {
    assertTrustedSender(event)
    if (!mcpRemoteClientManager) throw new Error('Remote MCP client is not ready')
    return mcpRemoteClientManager.statesSnapshot()
  })
  ipcMain.handle(IPC_CHANNELS.addMcpRemoteServer, (event) => {
    assertTrustedSender(event)
    if (!mcpRemoteRepository) throw new Error('Remote MCP settings are not ready')
    return mcpRemoteRepository.addServer()
  })
  ipcMain.handle(IPC_CHANNELS.updateMcpRemoteServer, async (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteRepository || !mcpRemoteClientManager) throw new Error('Remote MCP runtime is not ready')
    const value = validateMcpRemoteServerPatch(patch)
    const settings = mcpRemoteRepository.updateServer(value)
    await mcpRemoteClientManager.invalidate(value.id)
    mcpToolRuntimeBridge?.sync()
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.removeMcpRemoteServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteRepository || !mcpRemoteClientManager) throw new Error('Remote MCP runtime is not ready')
    const id = validateId(serverId, 'serverId')
    await mcpRemoteClientManager.invalidate(id)
    const settings = mcpRemoteRepository.removeServer(id)
    mcpToolCatalogService?.removeServer(id)
    mcpToolRuntimeBridge?.sync()
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.testMcpRemoteServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteClientManager) throw new Error('Remote MCP client is not ready')
    try {
      return { ok: true, result: await mcpRemoteClientManager.checkHealth(validateId(serverId, 'serverId')), error: null }
    } catch (error) {
      return { ok: false, result: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.connectMcpRemoteServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteClientManager) throw new Error('Remote MCP client is not ready')
    return mcpRemoteClientManager.connect(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.authorizeMcpRemoteServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteClientManager) throw new Error('Remote MCP client is not ready')
    const snapshot = await mcpRemoteClientManager.authorize(validateId(serverId, 'serverId'))
    // A different OAuth grant may expose a different tool set. Keep the old cache
    // visible for audit, but remove it from executable ToolRuntime until refreshed.
    mcpToolRuntimeBridge?.sync()
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.disconnectMcpRemoteServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpRemoteClientManager) throw new Error('Remote MCP client is not ready')
    await mcpRemoteClientManager.disconnect(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.getMcpLocalSettings, (event) => {
    assertTrustedSender(event)
    if (!mcpLocalRepository) throw new Error('Local MCP settings are not ready')
    return mcpLocalRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.revealMcpLocalEnvironment, (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalRepository) throw new Error('Local MCP settings are not ready')
    return mcpLocalRepository.getEnvironment(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.getMcpLocalConnectionStates, (event) => {
    assertTrustedSender(event)
    if (!mcpLocalClientManager) throw new Error('Local MCP client is not ready')
    return mcpLocalClientManager.statesSnapshot()
  })
  ipcMain.handle(IPC_CHANNELS.addMcpLocalServer, (event) => {
    assertTrustedSender(event)
    if (!mcpLocalRepository) throw new Error('Local MCP settings are not ready')
    return mcpLocalRepository.addServer()
  })
  ipcMain.handle(IPC_CHANNELS.updateMcpLocalServer, async (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalRepository || !mcpLocalClientManager) throw new Error('Local MCP runtime is not ready')
    const value = validateMcpLocalServerPatch(patch)
    const settings = mcpLocalRepository.updateServer(value)
    await mcpLocalClientManager.invalidate(value.id)
    mcpToolRuntimeBridge?.sync()
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.removeMcpLocalServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalRepository || !mcpLocalClientManager) throw new Error('Local MCP runtime is not ready')
    const id = validateId(serverId, 'serverId')
    await mcpLocalClientManager.invalidate(id)
    const settings = mcpLocalRepository.removeServer(id)
    mcpToolCatalogService?.removeServer(id)
    mcpToolRuntimeBridge?.sync()
    return settings
  })
  ipcMain.handle(IPC_CHANNELS.testMcpLocalServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalClientManager) throw new Error('Local MCP client is not ready')
    try {
      return { ok: true, result: await mcpLocalClientManager.checkHealth(validateId(serverId, 'serverId')), error: null }
    } catch (error) {
      return { ok: false, result: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.connectMcpLocalServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalClientManager) throw new Error('Local MCP client is not ready')
    return mcpLocalClientManager.connect(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.disconnectMcpLocalServer, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpLocalClientManager) throw new Error('Local MCP client is not ready')
    await mcpLocalClientManager.disconnect(validateId(serverId, 'serverId'))
  })
  ipcMain.handle(IPC_CHANNELS.getMcpToolCatalog, (event) => {
    assertTrustedSender(event)
    if (!mcpToolCatalogService) throw new Error('MCP tool catalog is not ready')
    return mcpToolCatalogService.current()
  })
  ipcMain.handle(IPC_CHANNELS.refreshMcpToolCatalog, async (event, serverId: unknown) => {
    assertTrustedSender(event)
    if (!mcpToolCatalogService) throw new Error('MCP tool catalog is not ready')
    const snapshot = await mcpToolCatalogService.refreshServer(validateId(serverId, 'serverId'))
    mcpToolRuntimeBridge?.sync()
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.summarizeArticle, async (event, articleId: unknown, forceRefresh?: unknown, options?: unknown) => {
    assertTrustedSender(event)
    if (!aiSummaryService) throw new Error('AI service is not ready')
    const validatedArticleId = validateId(articleId, 'articleId')
    activeAiSummaryRequest?.controller.abort()
    const request = { articleId: validatedArticleId, controller: new AbortController() }
    activeAiSummaryRequest = request
    try {
      return await aiSummaryService.summarize(
        validatedArticleId,
        forceRefresh === undefined ? false : validateBoolean(forceRefresh, 'forceRefresh'),
        options === undefined ? {} : validateAiSummaryRequestOptions(options),
        (stage) => {
          if (!event.sender.isDestroyed() && activeAiSummaryRequest === request) {
            event.sender.send(IPC_CHANNELS.aiSummaryProgress, { articleId: validatedArticleId, stage })
          }
        },
        (update) => {
          if (!event.sender.isDestroyed() && activeAiSummaryRequest === request) {
            event.sender.send(IPC_CHANNELS.aiSummaryStreamUpdate, { articleId: validatedArticleId, ...update })
          }
        },
        request.controller.signal
      )
    } finally {
      if (activeAiSummaryRequest === request) activeAiSummaryRequest = null
    }
  })
  ipcMain.handle(IPC_CHANNELS.stopAiSummary, (event, articleId: unknown) => {
    assertTrustedSender(event)
    const validatedArticleId = validateId(articleId, 'articleId')
    const active = activeAiSummaryRequest
    if (!active || active.articleId !== validatedArticleId) return false
    active.controller.abort()
    activeAiSummaryRequest = null
    return true
  })
  ipcMain.handle(IPC_CHANNELS.getLlmCustomizationSettings, (event) => {
    assertTrustedSender(event)
    if (!llmCustomizationSettingsRepository) throw new Error('LLM customization settings are not ready')
    return llmCustomizationSettingsRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.updateLlmCustomizationSettings, (event, patch: unknown) => {
    assertTrustedSender(event)
    if (!llmCustomizationSettingsRepository) throw new Error('LLM customization settings are not ready')
    return llmCustomizationSettingsRepository.update(normalizeLlmCustomizationSettingsPatch(patch))
  })
  ipcMain.handle(IPC_CHANNELS.getLlmSkills, (event) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    return toLlmSkillManagementSnapshot(llmSkillRepository.current())
  })
  ipcMain.handle(IPC_CHANNELS.importLlmSkill, async (event) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    const selected = await dialog.showOpenDialog({
      title: '导入 Skill',
      properties: ['openFile'],
      filters: [
        { name: 'Agent Skill', extensions: ['md', 'zip'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (selected.canceled || !selected.filePaths[0]) {
      return { ok: true, cancelled: true, replaced: false, skillId: null, snapshot: toLlmSkillManagementSnapshot(llmSkillRepository.current()), error: null }
    }
    const filePath = selected.filePaths[0]
    try {
      const size = statSync(filePath).size
      if (size <= 0 || size > MAX_LLM_SKILL_IMPORT_BYTES) throw new Error(`Skill 文件不能超过 ${MAX_LLM_SKILL_IMPORT_BYTES / 1_000_000} MB`)
      const imported = await llmSkillRepository.importBytes(readFileSync(filePath), basename(filePath))
      return {
        ok: true,
        cancelled: false,
        replaced: imported.replaced,
        skillId: imported.skill.id,
        snapshot: toLlmSkillManagementSnapshot(llmSkillRepository.current()),
        error: null
      }
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        replaced: false,
        skillId: null,
        snapshot: toLlmSkillManagementSnapshot(llmSkillRepository.current()),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle(IPC_CHANNELS.createLlmSkill, async (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    try {
      const imported = await llmSkillRepository.createFromMarkdown(buildCreatedLlmSkillMarkdown(request))
      return {
        ok: true,
        cancelled: false,
        replaced: imported.replaced,
        skillId: imported.skill.id,
        snapshot: toLlmSkillManagementSnapshot(llmSkillRepository.current()),
        error: null
      }
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        replaced: false,
        skillId: null,
        snapshot: toLlmSkillManagementSnapshot(llmSkillRepository.current()),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })
  ipcMain.handle(IPC_CHANNELS.getLlmSkillPreview, (event, skillId: unknown) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    const skill = llmSkillRepository.skill(validateId(skillId, 'skillId'))
    if (!skill) throw new Error('Skill 不存在')
    return {
      id: skill.id,
      description: skill.description,
      instructions: skill.instructions,
      license: skill.license,
      compatibility: skill.compatibility,
      allowedTools: skill.allowedTools,
      metadata: { ...skill.metadata },
      hasScripts: skill.hasScripts,
      resourcePaths: skill.resources.map((resource) => resource.path)
    }
  })
  ipcMain.handle(IPC_CHANNELS.setLlmSkillEnabled, (event, skillId: unknown, enabled: unknown) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    return toLlmSkillManagementSnapshot(llmSkillRepository.setEnabled(validateId(skillId, 'skillId'), validateBoolean(enabled, 'enabled')))
  })
  ipcMain.handle(IPC_CHANNELS.deleteLlmSkill, (event, skillId: unknown) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    return toLlmSkillManagementSnapshot(llmSkillRepository.delete(validateId(skillId, 'skillId')))
  })
  ipcMain.handle(IPC_CHANNELS.setLlmSkillBinding, (event, task: unknown, skillId: unknown) => {
    assertTrustedSender(event)
    if (!llmSkillRepository) throw new Error('LLM Skill repository is not ready')
    const id = skillId == null ? null : validateId(skillId, 'skillId')
    return toLlmSkillManagementSnapshot(llmSkillRepository.setBinding(validateLlmSkillTask(task), id))
  })
  ipcMain.handle(IPC_CHANNELS.getLlmQuickMessages, (event, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.createLlmQuickMessage, (event, title: unknown, content: unknown, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    llmQuickMessageRepository.create(validateText(title, 'title', 80), validateText(content, 'content', 4_000))
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.updateLlmQuickMessage, (event, id: unknown, title: unknown, content: unknown, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    llmQuickMessageRepository.update(validateId(id, 'quickMessageId'), validateText(title, 'title', 80), validateText(content, 'content', 4_000))
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.setLlmQuickMessageEnabled, (event, id: unknown, enabled: unknown, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    llmQuickMessageRepository.setEnabled(validateId(id, 'quickMessageId'), validateBoolean(enabled, 'enabled'))
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.deleteLlmQuickMessage, (event, id: unknown, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    llmQuickMessageRepository.delete(validateId(id, 'quickMessageId'))
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.moveLlmQuickMessage, (event, id: unknown, direction: unknown, language: unknown) => {
    assertTrustedSender(event)
    if (!llmQuickMessageRepository) throw new Error('LLM Quick Message repository is not ready')
    if (direction !== -1 && direction !== 1) throw new TypeError('Quick Message direction must be -1 or 1')
    llmQuickMessageRepository.move(validateId(id, 'quickMessageId'), direction)
    return resolvedLlmQuickMessages(llmQuickMessageRepository, validateUiLanguage(language))
  })
  ipcMain.handle(IPC_CHANNELS.listLlmConversations, (event, articleId?: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    return llmChatRepository.listConversations(articleId == null ? null : validateId(articleId, 'articleId'))
  })
  ipcMain.handle(IPC_CHANNELS.createLlmConversation, (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    return llmChatRepository.createConversation(validateLlmCreateConversationRequest(request))
  })
  ipcMain.handle(IPC_CHANNELS.updateLlmConversation, (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    const value = validateLlmUpdateConversationRequest(request)
    let updated = llmChatRepository.getConversation(value.conversationId)
    if (!updated) throw new Error('会话不存在')
    if (value.title !== undefined) updated = llmChatRepository.updateConversationTitle(value.conversationId, value.title)
    if (value.providerId !== undefined || value.model !== undefined) {
      updated = llmChatRepository.updateConversationModel(
        value.conversationId,
        value.providerId !== undefined ? value.providerId : updated.providerId,
        value.model !== undefined ? value.model : updated.model
      )
    }
    return updated
  })
  ipcMain.handle(IPC_CHANNELS.deleteLlmConversation, (event, conversationId: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    const id = validateId(conversationId, 'conversationId')
    return { conversationId: id, deleted: llmChatRepository.deleteConversation(id) }
  })
  ipcMain.handle(IPC_CHANNELS.listLlmArticleContextCandidates, (event, query?: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const normalizedQuery = query == null || query === '' ? '' : validateText(query, 'query', 200).trim()
    return libraryRepository.listArticleMetadata(30, normalizedQuery)
      .map((article) => ({
        articleId: article.id,
        title: article.title,
        link: article.url,
        feedName: article.feedName,
        publishedAt: article.publishedAt
      }))
  })
  ipcMain.handle(IPC_CHANNELS.getLlmConversationArticles, (event, conversationId: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    const id = validateId(conversationId, 'conversationId')
    if (!llmChatRepository.getConversation(id)) throw new Error('会话不存在')
    return llmChatRepository.getConversationArticles(id)
  })
  ipcMain.handle(IPC_CHANNELS.replaceLlmConversationArticles, (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository || !libraryRepository) throw new Error('LLM chat repository is not ready')
    const library = libraryRepository
    const value = validateLlmReplaceConversationArticlesRequest(request)
    const conversation = llmChatRepository.getConversation(value.conversationId)
    if (!conversation) throw new Error('会话不存在')
    const articleIds = value.articleIds.filter((articleId) => articleId !== conversation.articleId)
    const records = articleIds.map((articleId, position) => {
      const article = library.getArticleMetadataById(articleId)
      if (!article) throw new Error(`附加文章不存在: ${articleId}`)
      return {
        conversationId: conversation.id,
        articleId: article.id,
        title: article.title,
        link: article.url,
        originalContent: '',
        summary: null,
        position,
        createdAt: Date.now() + position
      }
    })
    llmChatRepository.replaceConversationArticles(conversation.id, records)
    return llmChatRepository.getConversationArticles(conversation.id)
  })
  ipcMain.handle(IPC_CHANNELS.getLlmMessages, (event, conversationId: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    return llmChatRepository.getMessages(validateId(conversationId, 'conversationId'))
  })
  ipcMain.handle(IPC_CHANNELS.appendLlmUserMessage, (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    const value = validateLlmAppendUserMessageRequest(request)
    if (!llmChatRepository.getConversation(value.conversationId)) throw new Error('会话不存在')
    return llmChatRepository.appendMessage(value.conversationId, {
      role: 'USER',
      content: value.content,
      requestTask: value.requestTask ?? 'CHAT'
    })
  })
  ipcMain.handle(IPC_CHANNELS.getLlmToolActivity, (event, conversationId: unknown) => {
    assertTrustedSender(event)
    if (!llmExecutionService) throw new Error('LLM execution service is not ready')
    return llmExecutionService.toolActivity(validateId(conversationId, 'conversationId'))
  })
  ipcMain.handle(IPC_CHANNELS.resolveLlmToolApproval, (event, toolCallId: unknown, decision: unknown) => {
    assertTrustedSender(event)
    if (!llmExecutionService) throw new Error('LLM execution service is not ready')
    const id = validateId(toolCallId, 'toolCallId')
    if (decision !== 'APPROVE' && decision !== 'DENY') throw new TypeError('Unknown Tool approval decision')
    return { toolCallId: id, accepted: llmExecutionService.resolveToolApproval(id, decision) }
  })
  ipcMain.handle(IPC_CHANNELS.listLlmManualTools, (event) => {
    assertTrustedSender(event)
    if (!manualToolContextService) throw new Error('Manual MCP Tool runtime is not ready')
    return manualToolContextService.listTools()
  })
  ipcMain.handle(IPC_CHANNELS.executeLlmManualTool, async (event, request: unknown) => {
    assertTrustedSender(event)
    if (!manualToolContextService || !llmChatRepository) throw new Error('Manual MCP Tool runtime is not ready')
    const value = validateLlmExecuteManualToolRequest(request)
    if (!llmChatRepository.getConversation(value.conversationId)) throw new Error('会话不存在')
    return manualToolContextService.execute(value)
  })
  ipcMain.handle(IPC_CHANNELS.discardLlmManualToolContext, (event, contextId: unknown) => {
    assertTrustedSender(event)
    if (!manualToolContextService) throw new Error('Manual MCP Tool runtime is not ready')
    return manualToolContextService.discard(validateId(contextId, 'contextId'))
  })
  ipcMain.handle(IPC_CHANNELS.getLlmAssistantEvidence, (event, assistantMessageId: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository) throw new Error('LLM chat repository is not ready')
    const id = validateId(assistantMessageId, 'assistantMessageId')
    const contextRefs = llmChatRepository.getContextRefsForAssistant(id)
    return {
      contextRefs,
      evidenceBlocks: contextRefs.flatMap((ref) => llmChatRepository!.getEvidenceBlocks(ref.id)),
      citations: llmChatRepository.getCitationRefsForAssistant(id)
    }
  })
  ipcMain.handle(IPC_CHANNELS.startLlmExecution, (event, request: unknown) => {
    assertTrustedSender(event)
    if (!llmChatRepository || !llmExecutionService) throw new Error('LLM runtime is not ready')
    const value = validateLlmStartExecutionRequest(request)
    if (llmExecutionRegistry.get(value.requestId)) throw new Error('LLM requestId 已存在')
    const conversation = llmChatRepository.getConversation(value.conversationId)
    if (!conversation) throw new Error('会话不存在')
    const context = buildMainLlmArticleContext(conversation)
    const readerContextItems = value.regenerateAssistantMessageId
      ? buildRegeneratedReaderSelectionContextItems(
          conversation,
          llmChatRepository.getContextRefsForAssistant(value.regenerateAssistantMessageId)
        )
      : buildReaderStateContextItems(conversation, value.readerContext)
    context.contextItems.push(...readerContextItems)
    for (const item of readerContextItems) {
      if (item.type !== 'SELECTED_TEXT') continue
      const block = buildSelectionEvidenceBlock(item.content, {
        articleId: conversation.articleId,
        sourceUrl: conversation.articleLink
      })
      if (block) {
        item.evidenceBlocks = [{ stableLocatorKey: block.stableLocatorKey, content: block.content }]
        context.evidenceGroups.push({ contextId: item.id, blocks: [block] })
      }
    }
    const assistant = value.regenerateAssistantMessageId
      ? llmChatRepository.appendRegeneratedAssistant(
          value.conversationId,
          value.regenerateAssistantMessageId,
          value.profile?.task ?? 'CHAT'
        ).assistant
      : llmChatRepository.appendMessage(value.conversationId, {
          role: 'ASSISTANT',
          content: '',
          requestTask: value.profile?.task ?? 'CHAT',
          status: 'STREAMING'
        })
    const identity = {
      requestId: value.requestId,
      conversationId: value.conversationId,
      assistantMessageId: assistant.id
    }
    const ownerId = String(event.sender.id)
    const executionProfile = toLlmExecutionProfile(value.profile)
    const executionTask = value.profile?.task ?? 'CHAT'
    if ((executionTask === 'CHAT' || executionTask === 'ARTICLE_ANALYSIS') && value.profile?.enabledToolIds === undefined) {
      // Enabled Remote MCP servers + a fresh user-refreshed catalog form the default
      // allow-list. Renderer can still pass an explicit list (including []) per request.
      executionProfile.enabledToolIds = new Set(mcpToolRuntimeBridge?.enabledToolIds() ?? [])
    }
    const latestUserInput = llmChatRepository.getMessages(value.conversationId, true)
      .filter((message) => message.role === 'USER')
      .at(-1)?.content ?? ''
    const webSearch = (executionTask === 'CHAT' || executionTask === 'ARTICLE_ANALYSIS') && webSearchRouter && webSearchRepository
      ? webSearchRouter.prepareSearch(value.profile?.webSearchMode ?? webSearchRepository.current().mode, latestUserInput, conversation.articleTitle)
      : undefined
    const customization = llmCustomizationSettingsRepository?.current()
    executionProfile.customInstructions = customization?.customInstructions || null
    if (customization?.skillsEnabled === false) {
      executionProfile.skillId = null
    } else if (value.profile?.skillId === undefined) {
      if (executionTask === 'CHAT' && llmSkillRouter) {
        executionProfile.skillId = llmSkillRouter.resolve(latestUserInput)?.id ?? null
      } else if (executionTask === 'ARTICLE_ANALYSIS' && llmSkillRepository) {
        executionProfile.skillId = llmSkillRepository.boundSkill('ARTICLE_ANALYSIS')?.id ?? null
      }
    }
    if (value.manualToolContextIds && value.manualToolContextIds.length > 0) {
      if (!manualToolContextService) throw new Error('Manual MCP Tool context runtime is not ready')
      const manual = manualToolContextService.consume(value.conversationId, value.manualToolContextIds)
      context.contextItems.push(...manual.contextItems)
      context.evidenceGroups.push(...manual.evidenceGroups)
    }
    void llmExecutionService.execute({
      ...identity,
      ownerId,
      profile: executionProfile,
      contextItems: context.contextItems,
      evidenceGroups: context.evidenceGroups,
      ...(webSearch ? { webSearch } : {})
    }, (executionEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.llmExecutionEvent, executionEvent)
    }).catch(() => undefined)
    return identity
  })
  ipcMain.handle(IPC_CHANNELS.cancelLlmExecution, (event, requestId: unknown) => {
    assertTrustedSender(event)
    const id = validateId(requestId, 'requestId')
    return {
      requestId: id,
      cancelled: llmExecutionRegistry.cancelOwned(id, String(event.sender.id))
    }
  })
  ipcMain.handle(IPC_CHANNELS.getTranslationSettings, (event) => {
    assertTrustedSender(event); if (!translationSettingsRepository) throw new Error('Translation settings are not ready'); return translationSettingsRepository.current()
  })
  ipcMain.handle(IPC_CHANNELS.getTranslationApiKey, (event, type: unknown) => {
    assertTrustedSender(event); if (!translationSettingsRepository) throw new Error('Translation settings are not ready'); return translationSettingsRepository.getApiKey(validateTranslationProviderType(type))
  })
  ipcMain.handle(IPC_CHANNELS.updateTranslationSettings, (event, patch: unknown) => {
    assertTrustedSender(event); if (!translationSettingsRepository) throw new Error('Translation settings are not ready')
    const value = validateRecord(patch, 'translation settings patch') as TranslationSettingsPatch; let result=translationSettingsRepository.current()
    if(value.defaultTarget!==undefined) result=translationSettingsRepository.setDefaultTarget(validateRecord(value.defaultTarget,'translation target') as unknown as TranslationTarget)
    if(value.targetLanguage!==undefined) result=translationSettingsRepository.setTargetLanguage(validateText(value.targetLanguage,'targetLanguage',64))
    if(value.displayMode!==undefined) result=translationSettingsRepository.setDisplayMode(value.displayMode)
    return result
  })
  ipcMain.handle(IPC_CHANNELS.updateTranslationProvider, (event, patch: unknown) => {
    assertTrustedSender(event); if(!translationSettingsRepository)throw new Error('Translation settings are not ready');return translationSettingsRepository.updateProvider(validateRecord(patch,'translation provider patch') as unknown as TranslationProviderPatch)
  })
  ipcMain.handle(IPC_CHANNELS.testTranslationProvider, async (event, type: unknown) => {
    assertTrustedSender(event); if(!translationService)throw new Error('Translation service is not ready');return translationService.testProvider(validateTranslationProviderType(type))
  })
  ipcMain.handle(IPC_CHANNELS.getDeepLUsage, async (event) => {
    assertTrustedSender(event); if(!translationService)throw new Error('Translation service is not ready');return translationService.getDeepLUsage()
  })
  ipcMain.handle(IPC_CHANNELS.translateArticle, async (event, articleId: unknown, target?: unknown, forceRefresh?: unknown) => {
    assertTrustedSender(event)
    if(!translationService)throw new Error('Translation service is not ready')
    const validatedArticleId=validateId(articleId,'articleId')
    activeTranslationRequest?.controller.abort()
    const request={articleId:validatedArticleId,controller:new AbortController()}
    activeTranslationRequest=request
    try{
      return await translationService.translateArticle(
        validatedArticleId,
        target===undefined?undefined:validateRecord(target,'translation target') as unknown as TranslationTarget,
        forceRefresh===undefined?false:validateBoolean(forceRefresh,'forceRefresh'),
        request.controller.signal
      )
    }finally{
      if(activeTranslationRequest===request)activeTranslationRequest=null
    }
  })
  ipcMain.handle(IPC_CHANNELS.stopTranslation, (event, articleId: unknown) => {
    assertTrustedSender(event)
    const validatedArticleId=validateId(articleId,'articleId')
    const active=activeTranslationRequest
    if(!active||active.articleId!==validatedArticleId)return false
    active.controller.abort()
    activeTranslationRequest=null
    return true
  })
  ipcMain.handle(IPC_CHANNELS.getArticleFilters, (event) => {
    assertTrustedSender(event); if(!articleFilterRepository)throw new Error('Article filters are not ready');return articleFilterRepository.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.addArticleFilter, (event, keyword: unknown, type: unknown, feedId?: unknown) => {
    assertTrustedSender(event); if(!articleFilterRepository||!libraryRepository)throw new Error('Article filters are not ready');const normalizedFeedId=feedId===undefined||feedId===null?null:validateId(feedId,'feedId');const feedName=normalizedFeedId?libraryRepository.getFeedById(normalizedFeedId)?.name??null:null;articleFilterRepository.add(validateText(keyword,'keyword',2_000),validateFilterRuleType(type),normalizedFeedId,feedName);return articleFilterRepository.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.setArticleFilterEnabled, (event, id: unknown, enabled: unknown) => {
    assertTrustedSender(event); if(!articleFilterRepository)throw new Error('Article filters are not ready');articleFilterRepository.setEnabled(validateId(id,'ruleId'),validateBoolean(enabled,'enabled'));return articleFilterRepository.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.deleteArticleFilter, (event, id: unknown) => {
    assertTrustedSender(event); if(!articleFilterRepository)throw new Error('Article filters are not ready');articleFilterRepository.delete(validateId(id,'ruleId'));return articleFilterRepository.snapshot()
  })
  ipcMain.handle(IPC_CHANNELS.getWebsiteSourceRuleSettings, (event, feedId: unknown) => {
    assertTrustedSender(event); return websiteSourceRuleSettings(validateId(feedId,'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.evaluateWebsiteSourceRules, async (event, feedId: unknown) => {
    assertTrustedSender(event);const id=validateId(feedId,'feedId');if(!websiteSourceService||!libraryRepository)throw new Error('Website source service is not ready');const feed=libraryRepository.getFeedById(id);if(!feed||feed.sourceType!=='website')throw new Error('来源不是网站类型');return websiteSourceService.evaluateCandidates(feed)
  })
  ipcMain.handle(IPC_CHANNELS.setWebsiteSourcePreferredRule, async (event, feedId: unknown, ruleId: unknown) => {
    assertTrustedSender(event);const id=validateId(feedId,'feedId');if(!websitePreferenceRepository||!websiteRuleRepository||!websiteSourceService||!libraryRepository)throw new Error('Website preferences are not ready');const normalized=ruleId===null?null:validateId(ruleId,'ruleId');let rule=normalized?websiteRuleRepository.listRules().find((item)=>item.id===normalized):null;if(normalized&&!rule&&normalized.startsWith('auto-dom:')){const feed=libraryRepository.getFeedById(id);if(!feed)throw new Error('来源不存在');const candidate=(await websiteSourceService.evaluateCandidates(feed)).find((item)=>item.rule.id===normalized);if(candidate){websitePreferenceRepository.saveAutomaticRule(id,candidate.rule);rule=candidate.rule}}if(normalized&&!rule)throw new Error('网站规则不存在');websitePreferenceRepository.setPreferredRule(id,normalized,rule?.name??null);return websiteSourceRuleSettings(id)!
  })
  ipcMain.handle(IPC_CHANNELS.setWebsiteSourceDynamicRendering, (event, feedId: unknown, enabled: unknown) => {
    assertTrustedSender(event);const id=validateId(feedId,'feedId');if(!websitePreferenceRepository)throw new Error('Website preferences are not ready');websitePreferenceRepository.setDynamicRenderingEnabled(id,validateBoolean(enabled,'enabled'));return websiteSourceRuleSettings(id)!
  })
  ipcMain.handle(IPC_CHANNELS.importOpml, async (event) => {
    assertTrustedSender(event)
    if (!opmlService || !accountService) throw new Error('OPML/account service is not ready')
    if (accountService.current().type !== 'local') {
      return { ok: false, cancelled: false, path: null, error: '当前远端账户不支持从客户端导入 OPML；请在服务端管理订阅，或切换到 Local 账户。' }
    }
    try {
      const selected = await showOpenDialog({
        title: '导入 OPML',
        properties: ['openFile'],
        filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }]
      })
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true, path: null, error: null }
      const path = selected.filePaths[0]
      const importResult = opmlService.importFromString(readFileSync(path, 'utf8'))
      try {
        if (periodicSyncScheduler) await periodicSyncScheduler.runNow('manual')
        else if (sourceSyncService) await sourceSyncService.refreshAllSources()
      } catch {
        // Android 在 OPML 写库后触发一次同步；同步失败不回滚已经成功导入的订阅。
      }
      return { ok: true, cancelled: false, path, importResult, error: null }
    } catch (error) {
      return { ok: false, cancelled: false, path: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.exportOpml, async (event, attachInfo?: unknown) => {
    assertTrustedSender(event)
    if (!opmlService) throw new Error('OPML service is not ready')
    try {
      const includeInfo = attachInfo === undefined ? true : validateBoolean(attachInfo, 'attachInfo')
      const content = opmlService.exportToString(includeInfo)
      const selected = await showSaveDialog({
        title: '导出 OPML',
        defaultPath: `OrigRead-Subscriptions-${new Date().toISOString().slice(0,10)}.opml`,
        filters: [{ name: 'OPML', extensions: ['opml'] }]
      })
      if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true, path: null, error: null }
      writeFileSync(selected.filePath, content, 'utf8')
      return { ok: true, cancelled: false, path: selected.filePath, error: null }
    } catch (error) {
      return { ok: false, cancelled: false, path: null, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC_CHANNELS.exportConfigurationBackup, async (event, password?: unknown) => {
    assertTrustedSender(event);if(!configurationBackupService)throw new Error('Backup service is not ready');try{const content=configurationBackupService.exportBackup(password===undefined?'':validateOptionalText(password,'password',1_024));const selected=await showSaveDialog({title:'导出 OrigRead 配置备份',defaultPath:`OrigRead-Configuration-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'OrigRead JSON Backup',extensions:['json']}]});if(selected.canceled||!selected.filePath)return{ok:false,cancelled:true,path:null,error:null};writeFileSync(selected.filePath,content,'utf8');return{ok:true,cancelled:false,path:selected.filePath,error:null}}catch(error){return{ok:false,cancelled:false,path:null,error:error instanceof Error?error.message:String(error)}}
  })
  ipcMain.handle(IPC_CHANNELS.restoreConfigurationBackup, async (event, password?: unknown) => {
    assertTrustedSender(event)
    if(!configurationBackupService)throw new Error('Backup service is not ready')
    try{
      const selected=await showOpenDialog({title:'恢复 OrigRead 配置备份',properties:['openFile'],filters:[{name:'OrigRead JSON Backup',extensions:['json']}]})
      if(selected.canceled||!selected.filePaths[0])return{ok:false,cancelled:true,path:null,error:null}
      const path=selected.filePaths[0]
      const restoreResult=configurationBackupService.restoreBackup(readFileSync(path,'utf8'),password===undefined?'':validateOptionalText(password,'password',1_024))
      await Promise.allSettled([mcpRemoteClientManager?.disconnectAll(),mcpLocalClientManager?.disconnectAll()])
      mcpToolCatalogService?.invalidateAll()
      mcpToolRuntimeBridge?.sync()
      periodicSyncScheduler?.reconfigure()
      return{ok:true,cancelled:false,path,restoreResult,error:null}
    }catch(error){return{ok:false,cancelled:false,path:null,error:error instanceof Error?error.message:String(error)}}
  })
  ipcMain.handle(IPC_CHANNELS.importRuleFile, async (event, kind: unknown) => {
    assertTrustedSender(event);const ruleKind=validateRuleKind(kind);try{const selected=await showOpenDialog({title:'导入 OrigRead 规则',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(selected.canceled||!selected.filePaths[0])return{ok:false,cancelled:true,count:0,error:null};const content=readFileSync(selected.filePaths[0],'utf8');const count=ruleKind==='website'?websiteRuleRepository!.importRules(content):ruleKind==='json'?jsonRuleRepository!.importRules(content):articleFilterRepository!.importRules(content);return{ok:true,cancelled:false,count,error:null}}catch(error){return{ok:false,cancelled:false,count:0,error:error instanceof Error?error.message:String(error)}}
  })
  ipcMain.handle(IPC_CHANNELS.exportRuleFile, async (event, kind: unknown) => {
    assertTrustedSender(event);const ruleKind=validateRuleKind(kind);try{const content=ruleKind==='website'?websiteRuleRepository!.exportRules():ruleKind==='json'?jsonRuleRepository!.exportRules():articleFilterRepository!.exportRules();const selected=await showSaveDialog({title:'导出 OrigRead 规则',defaultPath:`OrigRead-${ruleKind}-rules.json`,filters:[{name:'JSON',extensions:['json']}]});if(selected.canceled||!selected.filePath)return{ok:false,cancelled:true,path:null,error:null};writeFileSync(selected.filePath,content,'utf8');return{ok:true,cancelled:false,path:selected.filePath,error:null}}catch(error){return{ok:false,cancelled:false,path:null,error:error instanceof Error?error.message:String(error)}}
  })
  ipcMain.handle(IPC_CHANNELS.openOriginalArticle, (event, url: unknown, bounds: unknown) => {
    assertTrustedSender(event)
    if (!originalArticleViewController) throw new Error('Original article view is not ready')
    return originalArticleViewController.open(validateExternalHttpUrl(url), validateOriginalViewBounds(bounds))
  })
  ipcMain.handle(IPC_CHANNELS.updateOriginalArticleBounds, (event, bounds: unknown) => {
    assertTrustedSender(event)
    if (!originalArticleViewController) throw new Error('Original article view is not ready')
    originalArticleViewController.updateBounds(validateOriginalViewBounds(bounds))
  })
  ipcMain.handle(IPC_CHANNELS.navigateOriginalArticle, (event, action: unknown) => {
    assertTrustedSender(event)
    if (!originalArticleViewController) throw new Error('Original article view is not ready')
    return originalArticleViewController.navigate(validateOriginalNavigationAction(action))
  })
  ipcMain.handle(IPC_CHANNELS.closeOriginalArticle, (event) => {
    assertTrustedSender(event)
    originalArticleViewController?.close()
  })
  ipcMain.handle(IPC_CHANNELS.getOriginalArticleState, (event) => {
    assertTrustedSender(event)
    return originalArticleViewController?.currentState() ?? {
      open: false,
      url: null,
      title: null,
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
  })
  ipcMain.handle(IPC_CHANNELS.openExternalUrl, async (event, url: unknown) => {
    assertTrustedSender(event)
    await shell.openExternal(validateExternalHttpUrl(url))
  })
}

function validateId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

function validateOptionalText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new TypeError(`${field} must be a string no longer than ${maxLength}`)
  return value
}

function validateRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function validateWebSearchProviderKind(value: unknown): WebSearchProviderKind {
  if (typeof value === 'string' && (WEB_SEARCH_PROVIDER_KINDS as readonly string[]).includes(value)) return value as WebSearchProviderKind
  throw new TypeError('Unsupported Web Search Provider kind')
}

function validateWebSearchSettingsPatch(value: unknown): WebSearchSettingsPatch {
  const record = validateRecord(value, 'Web Search settings patch')
  const allowed = new Set(['mode', 'defaultProviderId', 'maxResults'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Web Search setting: ${key}`)
  const result: WebSearchSettingsPatch = {}
  if (record.mode !== undefined) {
    if (record.mode !== 'OFF' && record.mode !== 'AUTO') throw new TypeError('Persistent Web Search mode must be OFF or AUTO')
    result.mode = record.mode
  }
  if (record.defaultProviderId !== undefined) {
    result.defaultProviderId = record.defaultProviderId === null ? null : validateId(record.defaultProviderId, 'defaultProviderId')
  }
  if (record.maxResults !== undefined) {
    if (!Number.isInteger(record.maxResults)) throw new TypeError('maxResults must be an integer')
    result.maxResults = Number(record.maxResults)
  }
  return result
}

function validateWebSearchProviderPatch(value: unknown): WebSearchProviderPatch {
  const record = validateRecord(value, 'Web Search provider patch')
  const allowed = new Set(['id', 'name', 'endpoint', 'enabled', 'apiKey'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Web Search provider field: ${key}`)
  const result: WebSearchProviderPatch = { id: validateId(record.id, 'providerId') }
  if (record.name !== undefined) result.name = validateOptionalText(record.name, 'name', 80)
  if (record.endpoint !== undefined) result.endpoint = validateOptionalText(record.endpoint, 'endpoint', 2_000)
  if (record.enabled !== undefined) result.enabled = validateBoolean(record.enabled, 'enabled')
  if (record.apiKey !== undefined) result.apiKey = validateOptionalText(record.apiKey, 'apiKey', 16_384)
  return result
}

function validateMcpRemoteServerPatch(value: unknown): McpRemoteServerPatch {
  const record = validateRecord(value, 'Remote MCP server patch')
  const allowed = new Set(['id', 'name', 'url', 'enabled', 'authMode', 'oauthScopes', 'credential'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Remote MCP server field: ${key}`)
  const result: McpRemoteServerPatch = { id: validateId(record.id, 'serverId') }
  if (record.name !== undefined) result.name = validateOptionalText(record.name, 'name', 80)
  if (record.url !== undefined) result.url = validateOptionalText(record.url, 'url', 2_000)
  if (record.enabled !== undefined) result.enabled = validateBoolean(record.enabled, 'enabled')
  if (record.authMode !== undefined) {
    if (!['NONE', 'BEARER', 'CUSTOM_HEADERS', 'OAUTH'].includes(String(record.authMode))) throw new TypeError('Unsupported Remote MCP auth mode')
    result.authMode = record.authMode as McpRemoteServerPatch['authMode']
  }
  if (record.oauthScopes !== undefined) result.oauthScopes = validateOptionalText(record.oauthScopes, 'oauthScopes', 2_000)
  if (record.credential !== undefined) result.credential = validateOptionalText(record.credential, 'credential', 64_000)
  return result
}

function validateMcpLocalServerPatch(value: unknown): McpLocalServerPatch {
  const record = validateRecord(value, 'Local MCP server patch')
  const allowed = new Set(['id', 'name', 'enabled', 'command', 'args', 'cwd', 'environment'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Local MCP server field: ${key}`)
  const result: McpLocalServerPatch = { id: validateId(record.id, 'serverId') }
  if (record.name !== undefined) result.name = validateOptionalText(record.name, 'name', 80)
  if (record.enabled !== undefined) result.enabled = validateBoolean(record.enabled, 'enabled')
  if (record.command !== undefined) result.command = validateOptionalText(record.command, 'command', 2_048)
  if (record.cwd !== undefined) result.cwd = validateOptionalText(record.cwd, 'cwd', 4_096)
  if (record.environment !== undefined) result.environment = validateOptionalText(record.environment, 'environment', 256_000)
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.length > 128) throw new TypeError('Local MCP args must be an array of at most 128 strings')
    result.args = record.args.map((item) => {
      if (typeof item !== 'string' || item.length > 8_192) throw new TypeError('Local MCP argument is invalid')
      return item
    })
  }
  return result
}

function validateLlmCreateConversationRequest(value: unknown): LlmCreateConversationRequest {
  const record = validateRecord(value, 'LLM conversation request')
  const allowed = new Set(['title', 'providerId', 'model', 'skillId', 'articleId', 'articleTitle', 'articleLink'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM conversation field: ${key}`)
  const result: LlmCreateConversationRequest = {}
  if (record.title !== undefined) result.title = validateText(record.title, 'title', 500)
  if (record.providerId !== undefined) result.providerId = record.providerId === null ? null : validateId(record.providerId, 'providerId')
  if (record.model !== undefined) result.model = record.model === null ? null : validateText(record.model, 'model', 500)
  if (record.skillId !== undefined) result.skillId = record.skillId === null ? null : validateId(record.skillId, 'skillId')
  if (record.articleId !== undefined) result.articleId = record.articleId === null ? null : validateId(record.articleId, 'articleId')
  if (record.articleTitle !== undefined) result.articleTitle = record.articleTitle === null ? null : validateText(record.articleTitle, 'articleTitle', 2_000)
  if (record.articleLink !== undefined) result.articleLink = record.articleLink === null ? null : validateExternalHttpUrl(record.articleLink)
  return result
}

function validateLlmUpdateConversationRequest(value: unknown): LlmUpdateConversationRequest {
  const record = validateRecord(value, 'LLM conversation update request')
  const allowed = new Set(['conversationId', 'title', 'providerId', 'model'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM conversation update field: ${key}`)
  const result: LlmUpdateConversationRequest = { conversationId: validateId(record.conversationId, 'conversationId') }
  if (record.title !== undefined) result.title = validateText(record.title, 'title', 500)
  if (record.providerId !== undefined) result.providerId = record.providerId === null ? null : validateId(record.providerId, 'providerId')
  if (record.model !== undefined) result.model = record.model === null ? null : validateText(record.model, 'model', 500)
  if (result.title === undefined && result.providerId === undefined && result.model === undefined) {
    throw new TypeError('LLM conversation update must change at least one field')
  }
  return result
}

function validateLlmReplaceConversationArticlesRequest(value: unknown): LlmReplaceConversationArticlesRequest {
  const record = validateRecord(value, 'LLM conversation articles request')
  const allowed = new Set(['conversationId', 'articleIds'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM conversation articles field: ${key}`)
  if (!Array.isArray(record.articleIds)) throw new TypeError('articleIds must be an array')
  const articleIds = [...new Set(record.articleIds.map((item) => validateId(item, 'articleId')))]
  if (articleIds.length > 5) throw new TypeError('最多只能附加 5 篇文章')
  return {
    conversationId: validateId(record.conversationId, 'conversationId'),
    articleIds
  }
}

function validateLlmAppendUserMessageRequest(value: unknown): LlmAppendUserMessageRequest {
  const record = validateRecord(value, 'LLM user message request')
  const allowed = new Set(['conversationId', 'content', 'requestTask'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM message field: ${key}`)
  const requestTask = record.requestTask === undefined ? undefined : validateLlmTask(record.requestTask)
  return {
    conversationId: validateId(record.conversationId, 'conversationId'),
    content: validateText(record.content, 'content', 200_000),
    ...(requestTask ? { requestTask } : {})
  }
}

function validateLlmExecuteManualToolRequest(value: unknown): LlmExecuteManualToolRequest {
  const record = validateRecord(value, 'Manual MCP Tool request')
  const allowed = new Set(['conversationId', 'toolId', 'argumentsJson', 'confirmed'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Manual MCP Tool field: ${key}`)
  return {
    conversationId: validateId(record.conversationId, 'conversationId'),
    toolId: validateId(record.toolId, 'toolId'),
    argumentsJson: validateText(record.argumentsJson, 'argumentsJson', 64_000),
    confirmed: validateBoolean(record.confirmed, 'confirmed')
  }
}

function validateLlmStartExecutionRequest(value: unknown): LlmStartExecutionRequest {
  const record = validateRecord(value, 'LLM execution request')
  const allowed = new Set(['requestId', 'conversationId', 'regenerateAssistantMessageId', 'readerContext', 'manualToolContextIds', 'profile'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM execution field: ${key}`)
  let manualToolContextIds: string[] | undefined
  if (record.manualToolContextIds !== undefined) {
    if (!Array.isArray(record.manualToolContextIds) || record.manualToolContextIds.length > 20) {
      throw new TypeError('manualToolContextIds must be an array')
    }
    manualToolContextIds = [...new Set(record.manualToolContextIds.map((item) => validateId(item, 'manualToolContextId')))]
  }
  return {
    requestId: validateId(record.requestId, 'requestId'),
    conversationId: validateId(record.conversationId, 'conversationId'),
    ...(record.regenerateAssistantMessageId === undefined
      ? {}
      : { regenerateAssistantMessageId: validateId(record.regenerateAssistantMessageId, 'regenerateAssistantMessageId') }),
    ...(record.readerContext === undefined
      ? {}
      : { readerContext: validateLlmReaderContextSnapshot(record.readerContext) as LlmReaderContextSnapshot }),
    ...(manualToolContextIds === undefined ? {} : { manualToolContextIds }),
    ...(record.profile === undefined ? {} : { profile: validateLlmStartExecutionProfile(record.profile) })
  }
}

function validateLlmStartExecutionProfile(value: unknown): LlmStartExecutionProfile {
  const record = validateRecord(value, 'LLM execution profile')
  const allowed = new Set([
    'task', 'providerId', 'model', 'reasoning', 'skillId', 'customInstructions', 'enabledToolIds', 'contextMaxTokens', 'webSearchMode'
  ])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM profile field: ${key}`)
  const result: LlmStartExecutionProfile = {}
  if (record.task !== undefined) result.task = validateLlmTask(record.task)
  if (record.providerId !== undefined) result.providerId = record.providerId === null ? null : validateId(record.providerId, 'providerId')
  if (record.model !== undefined) result.model = record.model === null ? null : validateText(record.model, 'model', 500)
  if (record.skillId !== undefined) result.skillId = record.skillId === null ? null : validateId(record.skillId, 'skillId')
  if (record.customInstructions !== undefined) {
    result.customInstructions = record.customInstructions === null ? null : validateText(record.customInstructions, 'customInstructions', 8_000)
  }
  if (record.webSearchMode !== undefined) {
    if (record.webSearchMode !== 'OFF' && record.webSearchMode !== 'AUTO' && record.webSearchMode !== 'FORCE') {
      throw new TypeError('Unknown Web Search mode')
    }
    result.webSearchMode = record.webSearchMode
  }
  if (record.reasoning !== undefined) {
    const reasoning = validateRecord(record.reasoning, 'reasoning')
    const reasoningAllowed = new Set(['effort', 'showReasoning'])
    for (const key of Object.keys(reasoning)) if (!reasoningAllowed.has(key)) throw new TypeError(`Unsupported reasoning field: ${key}`)
    const effort = validateText(reasoning.effort, 'reasoning.effort', 32)
    if (!['AUTO', 'NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAXIMUM'].includes(effort)) {
      throw new TypeError('Unknown reasoning effort')
    }
    result.reasoning = {
      effort: effort as NonNullable<LlmStartExecutionProfile['reasoning']>['effort'],
      showReasoning: validateBoolean(reasoning.showReasoning, 'reasoning.showReasoning')
    }
  }
  if (record.enabledToolIds !== undefined) {
    if (!Array.isArray(record.enabledToolIds) || record.enabledToolIds.length > 100) throw new TypeError('enabledToolIds must be an array')
    result.enabledToolIds = record.enabledToolIds.map((item) => validateId(item, 'toolId'))
  }
  if (record.contextMaxTokens !== undefined) {
    if (!Number.isInteger(record.contextMaxTokens) || Number(record.contextMaxTokens) < 4_096 || Number(record.contextMaxTokens) > 4_000_000) {
      throw new TypeError('contextMaxTokens is invalid')
    }
    result.contextMaxTokens = Number(record.contextMaxTokens)
  }
  return result
}

function validateLlmTask(value: unknown): 'CHAT' | 'ARTICLE_ANALYSIS' {
  if (value === 'CHAT' || value === 'ARTICLE_ANALYSIS') return value
  throw new TypeError('Unknown LLM task')
}

function validateLlmSkillTask(value: unknown): LlmSkillTask {
  if (typeof value === 'string' && (LLM_SKILL_TASKS as readonly string[]).includes(value)) return value as LlmSkillTask
  throw new TypeError('Unknown LLM Skill task')
}

function buildCreatedLlmSkillMarkdown(value: unknown): string {
  const record = validateRecord(value, 'LLM Skill create request')
  const allowed = new Set(['id', 'description', 'instructions', 'triggers'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported Skill create field: ${key}`)
  const id = validateText(record.id, 'skillId', 64).trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new TypeError('Skill ID 只能使用小写字母、数字和单个连字符')
  const description = validateText(record.description, 'description', 1_024).trim()
  const instructions = validateText(record.instructions, 'instructions', 500_000).trim()
  const triggers = record.triggers === undefined ? '' : validateOptionalText(record.triggers, 'triggers', 2_000).trim()
  return [
    '---',
    `name: ${id}`,
    `description: ${JSON.stringify(description)}`,
    ...(triggers ? ['metadata:', `  origread-triggers: ${JSON.stringify(triggers)}`] : []),
    '---',
    instructions
  ].join('\n')
}

function validateUiLanguage(value: unknown): 'zh' | 'en' {
  if (value === 'zh' || value === 'en') return value
  throw new TypeError('Unsupported UI language')
}

function toLlmSkillManagementSnapshot(state: LlmSkillState): LlmSkillManagementSnapshot {
  return {
    bindings: { ...state.bindings },
    skills: state.skills.map((skill) => ({
      id: skill.id,
      description: skill.description,
      enabled: skill.enabled,
      license: skill.license,
      compatibility: skill.compatibility,
      allowedTools: skill.allowedTools,
      metadata: { ...skill.metadata },
      hasScripts: skill.hasScripts,
      contentHash: skill.contentHash,
      resourceCount: skill.resources.length,
      installedAt: skill.installedAt,
      updatedAt: skill.updatedAt
    }))
  }
}

function resolvedLlmQuickMessages(repository: LlmQuickMessageRepository, language: 'zh' | 'en') {
  return repository.current().map((message) => ({ ...message, ...repository.resolveText(message, language) }))
}

function toLlmExecutionProfile(profile?: LlmStartExecutionProfile): LlmExecutionProfile {
  if (!profile) return {}
  return {
    task: profile.task,
    providerId: profile.providerId,
    model: profile.model,
    reasoning: profile.reasoning,
    skillId: profile.skillId,
    customInstructions: profile.customInstructions,
    enabledToolIds: profile.enabledToolIds ? new Set(profile.enabledToolIds) : undefined,
    contextPolicy: profile.contextMaxTokens ? { maxTokens: profile.contextMaxTokens } : undefined
  }
}

function buildMainLlmArticleContext(conversation: LlmConversationRecord): {
  contextItems: LlmContextItem[]
  evidenceGroups: LlmExecutionEvidenceGroup[]
} {
  if (!conversation.articleId || !readerContentService) return { contextItems: [], evidenceGroups: [] }
  const contextItems: LlmContextItem[] = []
  const evidenceGroups: LlmExecutionEvidenceGroup[] = []
  const articleInputs = [
    {
      articleId: conversation.articleId,
      title: conversation.articleTitle,
      link: conversation.articleLink,
      priority: CURRENT_ARTICLE_CONTEXT_PRIORITY,
      reserveEvidenceBudget: true
    },
    ...(llmChatRepository?.getConversationArticles(conversation.id) ?? []).map((article, index) => ({
      articleId: article.articleId,
      title: article.title,
      link: article.link,
      priority: additionalArticleContextPriority(index),
      reserveEvidenceBudget: false
    }))
  ]
  for (const article of articleInputs) {
    const reader = readerContentService.get(article.articleId, true)
    const sourceUrl = reader.sourceUrl ?? article.link
    const blocks = buildArticleEvidenceBlocks(reader.html, {
      articleId: article.articleId,
      sourceUrl
    })
    if (blocks.length === 0) continue
    const contextId = `article:${article.articleId}:reader`
    contextItems.push({
      id: contextId,
      type: 'ARTICLE',
      content: blocks.map((block) => block.content).join('\n\n'),
      title: article.title,
      sourceId: sourceUrl,
      internalArticleId: article.articleId,
      reserveEvidenceBudget: article.reserveEvidenceBudget,
      evidenceBlocks: blocks,
      priority: article.priority
    })
    evidenceGroups.push({ contextId, blocks })
  }
  return { contextItems, evidenceGroups }
}

function validateFeedSettingsPatch(value: unknown): FeedSettingsPatch {
  const record = validateRecord(value, 'feed settings patch')
  const allowed = new Set(['name', 'url', 'groupId', 'isNotification', 'isFullContent', 'isBrowser'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported feed setting: ${key}`)
  const patch: FeedSettingsPatch = {}
  if (record.name !== undefined) patch.name = validateText(record.name, 'feedName', 500).trim()
  if (record.url !== undefined) patch.url = validateExternalHttpUrl(record.url)
  if (record.groupId !== undefined) patch.groupId = validateId(record.groupId, 'groupId')
  if (record.isNotification !== undefined) patch.isNotification = validateBoolean(record.isNotification, 'isNotification')
  if (record.isFullContent !== undefined) patch.isFullContent = validateBoolean(record.isFullContent, 'isFullContent')
  if (record.isBrowser !== undefined) patch.isBrowser = validateBoolean(record.isBrowser, 'isBrowser')
  return patch
}

function validateAiSummaryRequestOptions(value: unknown): AiSummaryRequestOptions {
  const record = validateRecord(value, 'AI summary options')
  const allowed = new Set(['providerId', 'model', 'length'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported AI summary option: ${key}`)
  const result: AiSummaryRequestOptions = {}
  if (record.providerId !== undefined) result.providerId = validateId(record.providerId, 'providerId')
  if (record.model !== undefined) result.model = validateText(record.model, 'model', 500).trim()
  if (record.length !== undefined) result.length = validateAiSummaryLength(record.length)
  return result
}

function validateAiSummaryLength(value: unknown): AiSummaryLength {
  if (value === 'BRIEF' || value === 'STANDARD' || value === 'DETAILED') return value
  throw new TypeError('Unknown AI summary length')
}

function validateTranslationProviderType(value: unknown): TranslationProviderType {
  if (value === 'ML_KIT' || value === 'MICROSOFT' || value === 'DEEPL' || value === 'GOOGLE_CLOUD' || value === 'DLX') return value
  throw new TypeError('Unknown translation provider type')
}

function validateFilterRuleType(value: unknown): ArticleFilterRuleType {
  if (value === 'KEYWORD' || value === 'REGEX') return value
  throw new TypeError('Unknown article filter rule type')
}

function validateRuleKind(value: unknown): 'website' | 'json' | 'filter' {
  if (value === 'website' || value === 'json' || value === 'filter') return value
  throw new TypeError('Unknown rule kind')
}

function validateGuideRuleKind(value: unknown): 'website' | 'json' {
  if (value === 'website' || value === 'json') return value
  throw new TypeError('Unknown guide rule kind')
}

function validateAiRuleKind(value: unknown): AiGeneratedRuleKind {
  if (value === 'WEBSITE' || value === 'JSON') return value
  throw new TypeError('Unknown AI rule kind')
}

function validateAiRuleGenerationOptions(value: unknown): AiRuleGenerationOptions {
  if (value === undefined) return {}
  const record = validateRecord(value, 'AI rule generation options')
  const allowed = new Set(['providerId', 'model', 'requestId'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unknown AI rule generation option: ${key}`)
  return {
    providerId: record.providerId === undefined ? undefined : validateId(record.providerId, 'providerId'),
    model: record.model === undefined ? undefined : validateOptionalText(record.model, 'model', 256).trim() || undefined,
    requestId: record.requestId === undefined ? undefined : validateId(record.requestId, 'requestId')
  }
}

function websiteSourceRuleSettings(feedId: string) {
  if (!libraryRepository || !websitePreferenceRepository) throw new Error('Website preferences are not ready')
  const feed = libraryRepository.getFeedById(feedId)
  if (!feed || feed.sourceType !== 'website') return null
  const preference = websitePreferenceRepository.get(feedId)
  return {
    feedId,
    preferredRuleId: preference?.preferredRuleId ?? null,
    preferredRuleName: preference?.preferredRuleName ?? null,
    dynamicRenderingEnabled: preference?.dynamicRenderingEnabled ?? feed.dynamicRendering,
    cachedAutomaticRuleId: preference?.cachedAutomaticRule?.id ?? null,
    cachedAutomaticRuleName: preference?.cachedAutomaticRule?.name ?? null
  }
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}

function validateText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string no longer than ${maxLength}`)
  }
  return value
}

function validateAccountId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError('accountId must be a positive integer')
  return value
}

function validateAccountType(value: unknown): AccountType {
  if (value === 'local' || value === 'fever' || value === 'google_reader' || value === 'fresh_rss') return value
  throw new TypeError('Unsupported account type')
}

function validateAccountCreateInput(value: unknown): AccountCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account input')
  const input = value as Record<string, unknown>
  const type = validateAccountType(input.type)
  const result: AccountCreateInput = { type }
  if (input.name !== undefined) result.name = validateText(input.name, 'name', 200)
  if (type !== 'local') {
    result.serverUrl = validateText(input.serverUrl, 'serverUrl', 4_096)
    result.username = validateText(input.username, 'username', 500)
    result.password = validateText(input.password, 'password', 4_096)
    if (input.useClientCertificate !== undefined) result.useClientCertificate = validateBoolean(input.useClientCertificate, 'useClientCertificate')
    if (input.clientCertificatePassphrase !== undefined) {
      if (typeof input.clientCertificatePassphrase !== 'string' || input.clientCertificatePassphrase.length > 4_096) throw new TypeError('clientCertificatePassphrase is invalid')
      result.clientCertificatePassphrase = input.clientCertificatePassphrase
    }
  }
  return result
}

function validateAccountPatch(value: unknown): AccountPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account patch')
  const input = value as Record<string, unknown>
  const result: AccountPatch = { id: validateAccountId(input.id) }
  if (input.name !== undefined) result.name = validateText(input.name, 'name', 200)
  if (input.serverUrl !== undefined) result.serverUrl = validateText(input.serverUrl, 'serverUrl', 4_096)
  if (input.username !== undefined) result.username = validateText(input.username, 'username', 500)
  if (input.password !== undefined) {
    if (typeof input.password !== 'string' || input.password.length > 4_096) throw new TypeError('password is invalid')
    result.password = input.password
  }
  if (input.syncIntervalMinutes !== undefined) {
    if (typeof input.syncIntervalMinutes !== 'number' || !Number.isFinite(input.syncIntervalMinutes)) throw new TypeError('syncIntervalMinutes is invalid')
    result.syncIntervalMinutes = input.syncIntervalMinutes
  }
  for (const key of ['syncOnStart', 'syncOnlyOnWiFi', 'syncOnlyWhenCharging'] as const) {
    if (input[key] !== undefined) result[key] = validateBoolean(input[key], key)
  }
  if (input.keepArchivedMillis !== undefined) {
    if (typeof input.keepArchivedMillis !== 'number' || !Number.isFinite(input.keepArchivedMillis)) throw new TypeError('keepArchivedMillis is invalid')
    result.keepArchivedMillis = input.keepArchivedMillis
  }
  if (input.syncBlockList !== undefined) {
    if (!Array.isArray(input.syncBlockList) || input.syncBlockList.some((item) => typeof item !== 'string')) throw new TypeError('syncBlockList is invalid')
    result.syncBlockList = input.syncBlockList.slice(0, 500) as string[]
  }
  return result
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
  desktopDatabase = new DesktopDatabase(join(app.getPath('userData'), 'origread.db'))
  libraryRepository = new LibraryRepository(desktopDatabase.connection)
  opmlService = new OpmlService(libraryRepository)
  readerContentService = new ReaderContentService(libraryRepository)
  settingsRepository = new SettingsRepository(desktopDatabase.connection)
  releaseUpdateService = new ReleaseUpdateService(
    (input, init) => net.fetch(input, init),
    process.env.ORIGREAD_UPDATE_API_BASE || 'https://api.github.com'
  )
  readerFontRepository = new ReaderFontRepository(join(app.getPath('userData'), 'reader-fonts'))
  const secretStore = new ElectronSecretStore(join(app.getPath('userData'), 'secrets.json'))
  accountRepository = new AccountRepository(desktopDatabase.connection, secretStore)
  const legacySettings = settingsRepository.current()
  accountRepository.migrateLegacySyncSettings(legacySettings.syncIntervalMinutes, legacySettings.syncOnStart)
  const systemLanguage = app.getLocale()
  aiSettingsRepository = new AiSettingsRepository(desktopDatabase.connection, secretStore, systemLanguage)
  webSearchRepository = new WebSearchRepository(desktopDatabase.connection, secretStore)
  webSearchService = new WebSearchService(webSearchRepository)
  webSearchRouter = new WebSearchRouter(webSearchRepository, webSearchService)
  mcpRemoteRepository = new McpRemoteRepository(desktopDatabase.connection, secretStore)
  mcpRemoteClientManager = new McpRemoteClientManager(
    mcpRemoteRepository,
    createSdkMcpRemoteConnectorFactory(
      'OrigRead Desktop',
      app.getVersion(),
      (server) => mcpRemoteRepository!.runtimeAuth(server.id),
      (server) => createMcpOAuthProviderSession({
        serverId: server.id,
        clientName: 'OrigRead Desktop',
        secrets: secretStore,
        openExternal: (url) => shell.openExternal(validateExternalHttpUrl(url))
      })
    )
  )
  mcpLocalRepository = new McpLocalRepository(desktopDatabase.connection, secretStore)
  mcpLocalClientManager = new McpLocalClientManager(
    mcpLocalRepository,
    createSdkMcpLocalConnectorFactory('OrigRead Desktop', app.getVersion(), mcpLocalRepository)
  )
  mcpCombinedRuntime = new McpCombinedRuntime(
    mcpRemoteRepository,
    mcpRemoteClientManager,
    mcpLocalRepository,
    mcpLocalClientManager
  )
  mcpToolCatalogService = new McpToolCatalogService(
    desktopDatabase.connection,
    mcpCombinedRuntime,
    mcpCombinedRuntime
  )
  llmChatRepository = new LlmChatRepository(desktopDatabase.connection)
  llmChatRepository.recoverInterruptedState()
  llmSkillRepository = new LlmSkillRepository(desktopDatabase.connection)
  llmCustomizationSettingsRepository = new LlmCustomizationSettingsRepository(desktopDatabase.connection)
  llmQuickMessageRepository = new LlmQuickMessageRepository(desktopDatabase.connection)
  llmSkillRouter = new LlmSkillRouter(llmSkillRepository, () => llmCustomizationSettingsRepository?.current().skillsEnabled !== false)
  const llmTaskPromptCustomizer = new LlmTaskPromptCustomizer(llmSkillRepository, llmCustomizationSettingsRepository)
  llmToolRuntime = new LlmToolRuntime()
  mcpToolRuntimeBridge = new McpToolRuntimeBridge(mcpToolCatalogService, mcpCombinedRuntime, llmToolRuntime)
  // Startup only projects the persisted catalog; it never contacts MCP servers.
  mcpToolRuntimeBridge.sync()
  manualToolContextService = new ManualToolContextService(llmToolRuntime)
  llmRuntime = new LlmRuntime(
    new OpenAiCompatibleLlmAdapter(aiSettingsRepository),
    new LlmContextComposer(),
    llmToolRuntime,
    llmSkillRepository
  )
  llmExecutionService = new LlmChatExecutionService(
    llmChatRepository,
    llmRuntime,
    new OpenAiCompatibleProvider(),
    llmToolRuntime,
    llmExecutionRegistry,
    webSearchRouter
  )
  translationSettingsRepository = new TranslationSettingsRepository(desktopDatabase.connection, secretStore, systemLanguage)
  articleFilterRepository = new ArticleFilterRepository(join(app.getPath('userData'), 'article-filter-rules.json'))
  feedDiscoveryCatalog = new FeedDiscoveryCatalog()
  rssHubSettingsRepository = new RssHubSettingsRepository(desktopDatabase.connection)
  rssHubResolver = new RssHubResolver(
    new RssHubRouteMatcher(loadBundledRssHubRoutes()),
    rssHubSettingsRepository
  )
  rssSubscriptionService = new RssSubscriptionService(
    libraryRepository,
    new RssDiscoveryService(),
    rssHubResolver,
    articleFilterRepository
  )
  jsonRuleRepository = new JsonRuleRepository(join(app.getPath('userData'), 'json-source-rules.json'))
  jsonSourceService = new JsonSourceService(jsonRuleRepository, new JsonArticleParser())
  jsonSubscriptionService = new JsonSubscriptionService(libraryRepository, jsonSourceService, articleFilterRepository)
  websiteRuleRepository = new WebsiteRuleRepository(join(app.getPath('userData'), 'website-rules.json'))
  websitePreferenceRepository = new WebsiteParsePreferenceRepository(join(app.getPath('userData'), 'website-parse-preferences.json'))
  const dynamicWebsiteRenderer = new ElectronDynamicWebsiteRenderer()
  websiteSourceService = new WebsiteSourceService(
    websiteRuleRepository,
    websitePreferenceRepository,
    undefined,
    dynamicWebsiteRenderer
  )
  const contentExtractionService = new ContentExtractionService([
    new WeChatArticleContentExtractor(),
    WebsiteRuleContentExtractor.fromRepository(websiteRuleRepository),
    new StructuredMetadataContentExtractor(),
    new ReadabilityContentExtractor()
  ])
  articleFullContentService = new ArticleFullContentService(
    libraryRepository,
    contentExtractionService,
    new DynamicArticleContentService(dynamicWebsiteRenderer, contentExtractionService)
  )
  websiteSubscriptionService = new WebsiteSubscriptionService(libraryRepository, websiteSourceService, articleFilterRepository)
  rssHubSubscriptionService = new RssHubSubscriptionService(libraryRepository)
  aiSummaryService = new AiSummaryService(
    libraryRepository,
    readerContentService,
    aiSettingsRepository,
    join(app.getPath('userData'), 'cache', 'ai-summary'),
    new OpenAiCompatibleProvider(),
    llmTaskPromptCustomizer
  )
  aiRuleGenerationService = new AiRuleGenerationService(aiSettingsRepository, websiteRuleRepository, jsonRuleRepository, new JsonArticleParser())
  translationService = new TranslationService(
    libraryRepository,
    readerContentService,
    translationSettingsRepository,
    aiSettingsRepository,
    join(app.getPath('userData'), 'cache', 'translation'),
    new OpenAiCompatibleProvider(),
    llmTaskPromptCustomizer
  )
  configurationBackupService = new ConfigurationBackupService(
    app.getVersion(), libraryRepository, settingsRepository, websiteRuleRepository, jsonRuleRepository,
    articleFilterRepository, websitePreferenceRepository, rssHubSettingsRepository, translationSettingsRepository, aiSettingsRepository,
    accountRepository, llmSkillRepository, llmQuickMessageRepository, llmCustomizationSettingsRepository, webSearchRepository,
    mcpRemoteRepository, mcpLocalRepository, desktopDatabase.connection, secretStore
  )
  sourceSyncService = new SourceSyncService(
    libraryRepository,
    rssSubscriptionService,
    jsonSubscriptionService,
    websiteSubscriptionService,
    (feed, articles) => {
      if (!Notification.isSupported() || articles.length === 0) return
      const first = articles[0]!
      const body = articles.length === 1
        ? first.title
        : `${first.title}\n${articles.length - 1} 篇新文章`
      const notification = new Notification({ title: feed.name, body })
      notification.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      })
      notification.show()
    }
  )
  const remoteAccountSyncService = new RemoteAccountSyncService(accountRepository, libraryRepository)
  accountService = new DesktopAccountService(accountRepository, libraryRepository, remoteAccountSyncService, sourceSyncService)
  sourceDiscoveryService = new SourceDiscoveryService(
    new RssDiscoveryService(),
    rssSubscriptionService,
    rssHubResolver,
    rssHubSubscriptionService,
    jsonSourceService,
    jsonSubscriptionService,
    websiteSourceService,
    websiteSubscriptionService,
    accountService,
    feedDiscoveryCatalog
  )
  periodicSyncScheduler = new PeriodicSyncScheduler(
    new AccountSyncSettingsProvider(accountRepository),
    accountService,
    (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.syncRuntimeStateChanged, state)
      }
    },
    () => {
      const account = accountRepository?.current()
      return !account?.syncOnlyWhenCharging || !powerMonitor.isOnBatteryPower()
    }
  )
  registerIpcHandlers()
  createMainWindow()
  if (process.env.ORIGREAD_DISABLE_PERIODIC_SYNC !== '1') periodicSyncScheduler.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
}).catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  console.error('[OrigRead] startup failed before the main window was ready', error)
  const isChinese = app.getLocale().toLowerCase().startsWith('zh')
  dialog.showErrorBox(
    localizedAppName(),
    isChinese
      ? `OrigRead 启动失败。\n\n${message}\n\n现有数据不会被自动清除，请保留此错误信息用于排查。`
      : `OrigRead failed to start.\n\n${message}\n\nExisting data will not be cleared automatically. Keep this error for troubleshooting.`
  )
  app.quit()
})

let applicationShutdownStarted = false
app.on('before-quit', (event) => {
  if (applicationShutdownStarted) return
  event.preventDefault()
  applicationShutdownStarted = true
  void (async () => {
    await Promise.allSettled([
      mcpRemoteClientManager?.disconnectAll(),
      mcpLocalClientManager?.disconnectAll()
    ])
    manualToolContextService = null
    mcpToolRuntimeBridge = null
    mcpToolCatalogService = null
    mcpCombinedRuntime = null
    mcpLocalClientManager = null
    mcpLocalRepository = null
    mcpRemoteClientManager = null
    mcpRemoteRepository = null
    periodicSyncScheduler?.stop()
    periodicSyncScheduler = null
    originalArticleViewController?.dispose()
    originalArticleViewController = null
    mainWindow = null
    desktopDatabase?.close()
    desktopDatabase = null
    libraryRepository = null
    settingsRepository = null
    readerFontRepository = null
    rssSubscriptionService = null
    rssHubSettingsRepository = null
    rssHubResolver = null
    jsonSubscriptionService = null
    jsonSourceService = null
    jsonRuleRepository = null
    websiteSubscriptionService = null
    websiteSourceService = null
    websitePreferenceRepository = null
    websiteRuleRepository = null
    sourceDiscoveryService = null
    sourceSyncService = null
    readerContentService = null
    articleFullContentService = null
    rssHubSubscriptionService = null
    aiSettingsRepository = null
    aiSummaryService = null
    translationSettingsRepository = null
    translationService = null
    articleFilterRepository = null
    configurationBackupService = null
    opmlService = null
    feedDiscoveryCatalog = null
    aiRuleGenerationService = null
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

