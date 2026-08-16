import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
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
import type { AiGeneratedRuleKind } from '../shared/ai-rule'
import type { TranslationProviderPatch, TranslationProviderType, TranslationSettingsPatch, TranslationTarget } from '../shared/translation'
import type { ArticleFilterRuleType } from '../shared/filter-rules'

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
let activeAiSummaryRequest: { articleId: string; controller: AbortController } | null = null
let translationSettingsRepository: TranslationSettingsRepository | null = null
let translationService: TranslationService | null = null
let articleFilterRepository: ArticleFilterRepository | null = null
let configurationBackupService: ConfigurationBackupService | null = null
let opmlService: OpmlService | null = null
let feedDiscoveryCatalog: FeedDiscoveryCatalog | null = null
let aiRuleGenerationService: AiRuleGenerationService | null = null

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
  ipcMain.handle(IPC_CHANNELS.addGroup, (event, name: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const normalizedName = validateText(name, 'groupName', 200).trim()
    const groups = libraryRepository.listGroups()
    if (!groups.some((group) => group.name === normalizedName)) {
      libraryRepository.upsertGroup({
        id: randomUUID(),
        name: normalizedName,
        sortOrder: Math.max(-1, ...groups.map((group) => group.sortOrder)) + 1,
        isDefault: false
      })
    }
    return libraryRepository.listGroups()
  })
  ipcMain.handle(IPC_CHANNELS.updateFeedSettings, (event, feedId: unknown, patch: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const id = validateId(feedId, 'feedId')
    const current = libraryRepository.getFeedById(id)
    if (!current) throw new Error('来源不存在')
    const nextPatch = validateFeedSettingsPatch(patch)
    if (nextPatch.groupId && !libraryRepository.listGroups().some((group) => group.id === nextPatch.groupId)) throw new Error('分组不存在')
    const next = {
      ...current,
      ...nextPatch,
      isFullContent: nextPatch.isFullContent === true ? true : (nextPatch.isBrowser === true ? false : nextPatch.isFullContent ?? current.isFullContent),
      isBrowser: nextPatch.isBrowser === true ? true : (nextPatch.isFullContent === true ? false : nextPatch.isBrowser ?? current.isBrowser),
      updatedAt: Date.now()
    }
    libraryRepository.upsertFeed(next)
    return libraryRepository.getFeedById(id)!
  })
  ipcMain.handle(IPC_CHANNELS.clearFeedArticles, (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const id = validateId(feedId, 'feedId')
    if (!libraryRepository.getFeedById(id)) throw new Error('来源不存在')
    libraryRepository.deleteArticlesByFeed(id, false)
  })
  ipcMain.handle(IPC_CHANNELS.deleteFeed, (event, feedId: unknown) => {
    assertTrustedSender(event)
    if (!libraryRepository) throw new Error('OrigRead database is not ready')
    const id = validateId(feedId, 'feedId')
    if (!libraryRepository.getFeedById(id)) return
    articleFilterRepository?.deleteByFeed(id)
    websitePreferenceRepository?.delete(id)
    libraryRepository.deleteArticlesByFeed(id, true)
    libraryRepository.deleteFeed(id)
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
  ipcMain.handle(IPC_CHANNELS.generateAiRule, async (event, kind: unknown, url: unknown) => {
    assertTrustedSender(event)
    if (!aiRuleGenerationService) throw new Error('AI rule generation service is not ready')
    const sourceUrl = validateUrlInput(url)
    return validateAiRuleKind(kind) === 'WEBSITE'
      ? aiRuleGenerationService.generateWebsiteRule(sourceUrl)
      : aiRuleGenerationService.generateJsonRule(sourceUrl)
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
  ipcMain.handle(IPC_CHANNELS.getAiApiKey, (event, providerId: unknown) => {
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
    assertTrustedSender(event); if(!translationService)throw new Error('Translation service is not ready');return translationService.translateArticle(validateId(articleId,'articleId'),target===undefined?undefined:validateRecord(target,'translation target') as unknown as TranslationTarget,forceRefresh===undefined?false:validateBoolean(forceRefresh,'forceRefresh'))
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
    if (!opmlService) throw new Error('OPML service is not ready')
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
    assertTrustedSender(event);if(!configurationBackupService)throw new Error('Backup service is not ready');try{const selected=await showOpenDialog({title:'恢复 OrigRead 配置备份',properties:['openFile'],filters:[{name:'OrigRead JSON Backup',extensions:['json']}]});if(selected.canceled||!selected.filePaths[0])return{ok:false,cancelled:true,path:null,error:null};const path=selected.filePaths[0];const restoreResult=configurationBackupService.restoreBackup(readFileSync(path,'utf8'),password===undefined?'':validateOptionalText(password,'password',1_024));periodicSyncScheduler?.reconfigure();return{ok:true,cancelled:false,path,restoreResult,error:null}}catch(error){return{ok:false,cancelled:false,path:null,error:error instanceof Error?error.message:String(error)}}
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

app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }
  desktopDatabase = new DesktopDatabase(join(app.getPath('userData'), 'origread.db'))
  libraryRepository = new LibraryRepository(desktopDatabase.connection)
  opmlService = new OpmlService(libraryRepository)
  readerContentService = new ReaderContentService(libraryRepository)
  settingsRepository = new SettingsRepository(desktopDatabase.connection)
  readerFontRepository = new ReaderFontRepository(join(app.getPath('userData'), 'reader-fonts'))
  const secretStore = new ElectronSecretStore(join(app.getPath('userData'), 'secrets.json'))
  aiSettingsRepository = new AiSettingsRepository(desktopDatabase.connection, secretStore)
  translationSettingsRepository = new TranslationSettingsRepository(desktopDatabase.connection, secretStore)
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
  aiSummaryService = new AiSummaryService(libraryRepository, readerContentService, aiSettingsRepository, join(app.getPath('userData'), 'cache', 'ai-summary'))
  aiRuleGenerationService = new AiRuleGenerationService(aiSettingsRepository, websiteRuleRepository, jsonRuleRepository, new JsonArticleParser())
  translationService = new TranslationService(libraryRepository, readerContentService, translationSettingsRepository, aiSettingsRepository, join(app.getPath('userData'), 'cache', 'translation'))
  configurationBackupService = new ConfigurationBackupService(
    app.getVersion(), libraryRepository, settingsRepository, websiteRuleRepository, jsonRuleRepository,
    articleFilterRepository, websitePreferenceRepository, rssHubSettingsRepository, translationSettingsRepository, aiSettingsRepository
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

