import { app, BrowserWindow, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC_CHANNELS, type AppInfo } from '../shared/contracts'
import { resolveBrandName } from '../shared/locale'
import { DesktopDatabase } from './database/database'
import { LibraryRepository } from './database/library-repository'
import { SettingsRepository } from './database/settings-repository'
import { normalizeDesktopSettingsPatch } from '../shared/settings'
import { RssSubscriptionService } from './sources/rss/rss-subscription-service'
import { RssDiscoveryService } from './sources/rss/rss-discovery-service'
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
import { ContentExtractionService } from './content/content-extraction-service'
import {
  ReadabilityContentExtractor,
  StructuredMetadataContentExtractor,
  WeChatArticleContentExtractor,
  WebsiteRuleContentExtractor
} from './content/content-extractors'
import { DynamicArticleContentService } from './content/dynamic-article-content-service'
import { ArticleFullContentService } from './content/article-full-content-service'
import {
  OriginalArticleViewController,
  validateOriginalViewBounds
} from './content/original-article-view-controller'
import type { OriginalNavigationAction } from '../shared/original-view'
import { PeriodicSyncScheduler } from './sync/periodic-sync-scheduler'

const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL)
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

function isTrustedRendererUrl(url: string): boolean {
  if (isDevelopment && process.env.ELECTRON_RENDERER_URL) {
    return url.startsWith(process.env.ELECTRON_RENDERER_URL)
  }
  return url.startsWith('file:')
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
      webSecurity: true
    }
  })
  mainWindow = window
  originalArticleViewController?.dispose()
  originalArticleViewController = new OriginalArticleViewController(window, (state) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.originalArticleStateChanged, state)
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
      platform: process.platform
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
  ipcMain.handle(IPC_CHANNELS.listArticles, (event, limit?: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit))) {
      throw new TypeError('Article limit must be a finite number')
    }
    return libraryRepository.listArticles(limit === undefined ? 200 : limit)
  })
  ipcMain.handle(IPC_CHANNELS.setArticleUnread, (event, articleId: unknown, unread: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    libraryRepository.setArticleUnread(validateId(articleId, 'articleId'), validateBoolean(unread, 'unread'))
  })
  ipcMain.handle(IPC_CHANNELS.setArticleStarred, (event, articleId: unknown, starred: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    libraryRepository.setArticleStarred(validateId(articleId, 'articleId'), validateBoolean(starred, 'starred'))
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
  ipcMain.handle(IPC_CHANNELS.addRssSource, async (event, inputUrl: unknown) => {
    assertTrustedSender(event)
    if (!rssSubscriptionService) throw new Error('RSS service is not ready')
    return rssSubscriptionService.add(validateUrlInput(inputUrl))
  })
  ipcMain.handle(IPC_CHANNELS.refreshRssSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!rssSubscriptionService) throw new Error('RSS service is not ready')
    return rssSubscriptionService.refresh(validateId(feedId, 'feedId'))
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
  ipcMain.handle(IPC_CHANNELS.listJsonRules, (event) => {
    assertTrustedSender(event)
    if (!jsonRuleRepository) throw new Error('JSON rule repository is not ready')
    return jsonRuleRepository.listRules()
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
  ipcMain.handle(IPC_CHANNELS.discoverSource, async (event, url: unknown) => {
    assertTrustedSender(event)
    if (!sourceDiscoveryService) throw new Error('Source discovery service is not ready')
    return sourceDiscoveryService.discover(validateUrlInput(url))
  })
  ipcMain.handle(IPC_CHANNELS.subscribeSource, async (event, discoveryId: unknown, candidateId: unknown) => {
    assertTrustedSender(event)
    if (!sourceDiscoveryService) throw new Error('Source discovery service is not ready')
    return sourceDiscoveryService.subscribe(
      validateId(discoveryId, 'discoveryId'),
      validateText(candidateId, 'candidateId', 4_096)
    )
  })
  ipcMain.handle(IPC_CHANNELS.refreshJsonSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!jsonSubscriptionService) throw new Error('JSON subscription service is not ready')
    return jsonSubscriptionService.refresh(validateId(feedId, 'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.refreshSource, async (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!sourceSyncService) throw new Error('Source sync service is not ready')
    return sourceSyncService.refreshSource(validateId(feedId, 'feedId'))
  })
  ipcMain.handle(IPC_CHANNELS.refreshAllSources, async (event) => {
    assertTrustedSender(event)
    if (periodicSyncScheduler) return periodicSyncScheduler.runNow('manual')
    if (!sourceSyncService) throw new Error('Source sync service is not ready')
    return sourceSyncService.refreshAllSources()
  })
  ipcMain.handle(IPC_CHANNELS.getSyncRuntimeState, (event) => {
    assertTrustedSender(event)
    if (!periodicSyncScheduler) throw new Error('Periodic sync scheduler is not ready')
    return periodicSyncScheduler.currentState()
  })
  ipcMain.handle(IPC_CHANNELS.getReaderContent, (event, articleId: unknown) => {
    assertTrustedSender(event)
    if (!readerContentService) throw new Error('Reader content service is not ready')
    return readerContentService.get(validateId(articleId, 'articleId'))
  })
  ipcMain.handle(IPC_CHANNELS.fetchFullContent, async (event, articleId: unknown) => {
    assertTrustedSender(event)
    if (!articleFullContentService) throw new Error('Full content service is not ready')
    return articleFullContentService.readOrFetch(validateId(articleId, 'articleId'), true)
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

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
  desktopDatabase = new DesktopDatabase(join(app.getPath('userData'), 'origread.db'))
  libraryRepository = new LibraryRepository(desktopDatabase.connection)
  readerContentService = new ReaderContentService(libraryRepository)
  settingsRepository = new SettingsRepository(desktopDatabase.connection)
  rssHubSettingsRepository = new RssHubSettingsRepository(desktopDatabase.connection)
  rssHubResolver = new RssHubResolver(
    new RssHubRouteMatcher(loadBundledRssHubRoutes()),
    rssHubSettingsRepository
  )
  rssSubscriptionService = new RssSubscriptionService(
    libraryRepository,
    new RssDiscoveryService(),
    rssHubResolver
  )
  jsonRuleRepository = new JsonRuleRepository(join(app.getPath('userData'), 'json-source-rules.json'))
  jsonSourceService = new JsonSourceService(jsonRuleRepository, new JsonArticleParser())
  jsonSubscriptionService = new JsonSubscriptionService(libraryRepository, jsonSourceService)
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
  websiteSubscriptionService = new WebsiteSubscriptionService(libraryRepository, websiteSourceService)
  rssHubSubscriptionService = new RssHubSubscriptionService(libraryRepository)
  sourceDiscoveryService = new SourceDiscoveryService(
    new RssDiscoveryService(),
    rssSubscriptionService,
    rssHubResolver,
    rssHubSubscriptionService,
    jsonSourceService,
    jsonSubscriptionService,
    websiteSourceService,
    websiteSubscriptionService
  )
  sourceSyncService = new SourceSyncService(
    libraryRepository,
    rssSubscriptionService,
    jsonSubscriptionService,
    websiteSubscriptionService
  )
  periodicSyncScheduler = new PeriodicSyncScheduler(
    settingsRepository,
    sourceSyncService,
    (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.syncRuntimeStateChanged, state)
      }
    }
  )
  registerIpcHandlers()
  createMainWindow()
  periodicSyncScheduler.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  periodicSyncScheduler?.stop()
  periodicSyncScheduler = null
  originalArticleViewController?.dispose()
  originalArticleViewController = null
  mainWindow = null
  desktopDatabase?.close()
  desktopDatabase = null
  libraryRepository = null
  settingsRepository = null
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

