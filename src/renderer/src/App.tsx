import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Compass,
  Download,
  Languages,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Star,
  Rss,
  Inbox,
  ExternalLink,
  Headphones,
  Pause,
  Play,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import { resolveDesktopLanguage } from '../../shared/locale'
import type { ArticleRecord, FeedArticleStats, FeedRecord, GroupRecord, LibrarySnapshot } from '../../shared/library'
import type { AiSummaryPlacement, DesktopSettings } from '../../shared/settings'
import type { SourceDiscoveryProgress, SourceDiscoveryResult, SourceDiscoveryStage } from '../../shared/source-discovery'
import type { ReaderArticleContent } from '../../shared/reader'
import type { SyncRuntimeState } from '../../shared/sync-runtime'
import type { OriginalArticleViewState, OriginalViewBounds } from '../../shared/original-view'
import { SettingsPanel, type SettingsPage } from './SettingsPanel'
import { UpdateAvailableDialog } from './UpdateAvailableDialog'
import type { AiSummaryDocument, AiSummaryProgress, AiSummaryProgressStage } from '../../shared/ai'
import type { TranslationDocument, TranslationTarget } from '../../shared/translation'
import type { FeedCatalogEntry } from '../../shared/source-catalog'
import { SourceDiscoveryPanel } from './SourceDiscoveryPanel'
import { SourceSettingsDialog } from './SourceSettingsDialog'
import { AiSummaryOptionsDialog, TranslationTargetDialog } from './ReaderToolDialogs'
import type { AiSummaryRequestOptions } from '../../shared/ai'
import { ReaderSearchBar, SearchableHtml, nextSearchIndex } from './ReaderSearch'
import { BUILTIN_READER_FONTS, type ReaderFontEntry } from '../../shared/reader-font'
import type { UpdateCheckResult } from '../../shared/update'
import { selectMainSpeechSource, speechTextFromHtml, speechTextFromMarkdown, useReaderSpeech } from './useReaderSpeech'
import { readerToolFeedback, type ReaderToolFeedback } from './reader-tool-feedback'
import { isOrigReadDesktopReleaseFeed, toOrigReadDesktopReleaseLinks } from '../../shared/origread-release'

type Destination = 'all' | 'unread' | 'starred'
type ReaderMode = 'article' | 'ai' | 'translation'
type ArticleScope =
  | { kind: 'all' }
  | { kind: 'group'; id: string }
  | { kind: 'feed'; id: string }

type ContextMenuState =
  | { kind: 'feed'; x: number; y: number; feedId: string }
  | { kind: 'article'; x: number; y: number; articleId: string }

const destinations: Array<{ id: Destination; icon: typeof Inbox; labelKey: string }> = [
  { id: 'all', icon: Inbox, labelKey: 'allArticles' },
  { id: 'unread', icon: BookOpenText, labelKey: 'unread' },
  { id: 'starred', icon: Star, labelKey: 'starred' }
]

const sourceDiscoveryStageOrder: SourceDiscoveryStage[] = ['rss', 'rsshub', 'json', 'website', 'dynamic_website', 'ranking']
const aiSummaryPlacementOrder: AiSummaryPlacement[] = ['replace', 'left', 'right', 'top', 'bottom']
const AI_SUMMARY_PANEL_MIN = 220
const AI_SUMMARY_PANEL_MAX = 640
const AI_SUMMARY_PANEL_KEYBOARD_STEP = 20

export default function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [destination, setDestination] = useState<Destination>('all')
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [librarySnapshot, setLibrarySnapshot] = useState<LibrarySnapshot | null>(null)
  const [feeds, setFeeds] = useState<FeedRecord[]>([])
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [articles, setArticles] = useState<ArticleRecord[]>([])
  const [scopeArticles, setScopeArticles] = useState<ArticleRecord[] | null>(null)
  const [feedArticleStats, setFeedArticleStats] = useState<FeedArticleStats[]>([])
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [query, setQuery] = useState('')
  const [articleScope, setArticleScope] = useState<ArticleScope>({ kind: 'all' })
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [addSourceOpen, setAddSourceOpen] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [isAddingSource, setIsAddingSource] = useState(false)
  const [sourceDiscovery, setSourceDiscovery] = useState<SourceDiscoveryResult | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([])
  const [sourceDiscoveryRequestId, setSourceDiscoveryRequestId] = useState<string | null>(null)
  const [sourceDiscoveryStages, setSourceDiscoveryStages] = useState<Partial<Record<SourceDiscoveryStage, SourceDiscoveryProgress['state']>>>({})
  const [sourceDiscoveryStartedAt, setSourceDiscoveryStartedAt] = useState<number | null>(null)
  const [sourceDiscoveryElapsedSeconds, setSourceDiscoveryElapsedSeconds] = useState(0)
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [readerContent, setReaderContent] = useState<ReaderArticleContent | null>(null)
  const [readerContentLoading, setReaderContentLoading] = useState(false)
  const [readerContentError, setReaderContentError] = useState<string | null>(null)
  const [readerMode, setReaderMode] = useState<ReaderMode>('article')
  const [aiSummary, setAiSummary] = useState<AiSummaryDocument | null>(null)
  const [aiSummaryVisible, setAiSummaryVisible] = useState(false)
  const [aiSummaryProgress, setAiSummaryProgress] = useState<AiSummaryProgress | null>(null)
  const [aiSummaryStartedAt, setAiSummaryStartedAt] = useState<number | null>(null)
  const [aiSummaryElapsedSeconds, setAiSummaryElapsedSeconds] = useState(0)
  const [translationDocument, setTranslationDocument] = useState<TranslationDocument | null>(null)
  const [readerToolLoading, setReaderToolLoading] = useState<ReaderMode | null>(null)
  const [readerToolNotice, setReaderToolNotice] = useState<ReaderToolFeedback | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>('general')
  const [startupUpdate, setStartupUpdate] = useState<UpdateCheckResult | null>(null)
  const [sourceCatalogOpen, setSourceCatalogOpen] = useState(false)
  const [subscriptionMenuOpen, setSubscriptionMenuOpen] = useState(false)
  const [opmlExportOpen, setOpmlExportOpen] = useState(false)
  const [opmlAttachInfo, setOpmlAttachInfo] = useState(true)
  const [opmlBusy, setOpmlBusy] = useState(false)
  const [opmlStatus, setOpmlStatus] = useState<string | null>(null)
  const [sourceSettingsFeed, setSourceSettingsFeed] = useState<FeedRecord | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [aiOptionsOpen, setAiOptionsOpen] = useState(false)
  const [translationTargetOpen, setTranslationTargetOpen] = useState(false)
  const [readerSearchOpen, setReaderSearchOpen] = useState(false)
  const [readerSearchQuery, setReaderSearchQuery] = useState('')
  const [readerSearchCount, setReaderSearchCount] = useState(0)
  const [readerSearchIndex, setReaderSearchIndex] = useState(0)
  const [readerFonts, setReaderFonts] = useState<ReaderFontEntry[]>([])
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [syncRuntimeState, setSyncRuntimeState] = useState<SyncRuntimeState | null>(null)
  const [originalViewState, setOriginalViewState] = useState<OriginalArticleViewState>(closedOriginalState())
  const readerStageRef = useRef<HTMLDivElement>(null)
  const readerContentRef = useRef<HTMLDivElement>(null)
  const readerSearchInputRef = useRef<HTMLInputElement>(null)
  const selectedArticleIdRef = useRef<string | null>(null)
  const sourceDiscoveryRequestIdRef = useRef<string | null>(null)
  const aiSummaryRunRef = useRef(0)
  const lastObservedSyncFinish = useRef<number | null>(null)
  const autoUpdateCheckedRef = useRef(false)
  const speech = useReaderSpeech(settings?.ttsVoiceURI ?? '')

  const reloadLibrary = useCallback(async (): Promise<void> => {
    const [snapshot, loadedFeeds, loadedGroups, loadedArticles, loadedFeedStats] = await Promise.all([
      window.origread.getLibrarySnapshot(),
      window.origread.listFeeds(),
      window.origread.listGroups(),
      window.origread.listArticles(),
      window.origread.listFeedArticleStats()
    ])
    setLibrarySnapshot(snapshot)
    setFeeds(loadedFeeds)
    setGroups(loadedGroups)
    setArticles(loadedArticles)
    setFeedArticleStats(loadedFeedStats)
  }, [])

  const loadArticlesForScope = useCallback(async (scope: ArticleScope): Promise<ArticleRecord[] | null> => {
    if (scope.kind === 'all') return null
    if (scope.kind === 'feed') return window.origread.listArticlesByFeed(scope.id)
    return window.origread.listArticlesByGroup(scope.id)
  }, [])

  const reloadCurrentScope = useCallback(async (): Promise<void> => {
    const loaded = await loadArticlesForScope(articleScope)
    setScopeArticles(loaded)
  }, [articleScope, loadArticlesForScope])

  useEffect(() => {
    let cancelled = false
    if (articleScope.kind === 'all') {
      setScopeArticles(null)
      return
    }
    setScopeArticles([])
    void loadArticlesForScope(articleScope)
      .then((loaded) => {
        if (!cancelled) setScopeArticles(loaded)
      })
      .catch((error) => {
        if (!cancelled) setSourceError(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [articleScope, loadArticlesForScope])

  useEffect(() => {
    void Promise.all([
      window.origread.getAppInfo(),
      window.origread.getSettings(),
      window.origread.getSyncRuntimeState(),
      window.origread.getOriginalArticleState()
    ]).then(async ([info, loadedSettings, loadedSyncState, loadedOriginalState]) => {
      setAppInfo(info)
      const startupSettings = loadedSettings.workspaceCollapsed
        ? await window.origread.updateSettings({ workspaceCollapsed: false })
        : loadedSettings
      setSettings(startupSettings)
      setSyncRuntimeState(loadedSyncState)
      setOriginalViewState(loadedOriginalState)
      lastObservedSyncFinish.current = loadedSyncState.lastFinishedAt
      // 左侧工作区折叠只属于当前会话。应用启动时始终展开，避免用户下次打开时误以为文章列表丢失。
      setWorkspaceCollapsed(false)
      const language = startupSettings.language === 'system'
        ? resolveDesktopLanguage(info.locale)
        : startupSettings.language
      void i18n.changeLanguage(language)
    })
    void reloadLibrary()
  }, [i18n, reloadLibrary])

  useEffect(() => {
    if (!settings || !appInfo || !settings.autoCheckUpdates || autoUpdateCheckedRef.current) return
    autoUpdateCheckedRef.current = true
    const language = settings.language === 'system' ? resolveDesktopLanguage(appInfo.locale) : settings.language
    void window.origread.checkForUpdates(language).then((result) => {
      if (result.status === 'available' && result.release) setStartupUpdate(result)
    }).catch(() => undefined)
  }, [appInfo, settings])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => setSystemDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const closeContextMenu = (): void => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('pointerdown', closeContextMenu)
    window.addEventListener('blur', closeContextMenu)
    window.addEventListener('resize', closeContextMenu)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', closeContextMenu)
      window.removeEventListener('blur', closeContextMenu)
      window.removeEventListener('resize', closeContextMenu)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const resolvedTheme = settings?.theme === 'dark' ? 'dark' : settings?.theme === 'light' ? 'light' : systemDark ? 'dark' : 'light'
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    selectedArticleIdRef.current = selectedArticleId
  }, [selectedArticleId])

  useEffect(() => {
    const unsubscribeSync = window.origread.onSyncRuntimeStateChanged((state) => {
      setSyncRuntimeState(state)
      if (state.lastFinishedAt && state.lastFinishedAt !== lastObservedSyncFinish.current) {
        lastObservedSyncFinish.current = state.lastFinishedAt
        void reloadLibrary()
        void reloadCurrentScope()
      }
    })
    const unsubscribeOriginal = window.origread.onOriginalArticleStateChanged(setOriginalViewState)
    const unsubscribeAiProgress = window.origread.onAiSummaryProgress((progress) => {
      if (progress.articleId === selectedArticleIdRef.current) setAiSummaryProgress(progress)
    })
    const unsubscribeSourceDiscoveryProgress = window.origread.onSourceDiscoveryProgress((progress) => {
      if (progress.requestId !== sourceDiscoveryRequestIdRef.current) return
      setSourceDiscoveryStages((current) => ({ ...current, [progress.stage]: progress.state }))
    })
    return () => {
      unsubscribeSync()
      unsubscribeOriginal()
      unsubscribeAiProgress()
      unsubscribeSourceDiscoveryProgress()
    }
  }, [reloadCurrentScope, reloadLibrary])

  useEffect(() => {
    if (!sourceDiscoveryRequestId || sourceDiscoveryStartedAt === null) {
      setSourceDiscoveryElapsedSeconds(0)
      return
    }
    const update = (): void => setSourceDiscoveryElapsedSeconds(
      Math.max(0, Math.floor((Date.now() - sourceDiscoveryStartedAt) / 1000))
    )
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [sourceDiscoveryRequestId, sourceDiscoveryStartedAt])

  useEffect(() => {
    if (readerToolLoading !== 'ai' || aiSummaryStartedAt === null) {
      setAiSummaryElapsedSeconds(0)
      return
    }
    const update = (): void => setAiSummaryElapsedSeconds(Math.max(0, Math.floor((Date.now() - aiSummaryStartedAt) / 1000)))
    update()
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  }, [aiSummaryStartedAt, readerToolLoading])

  useEffect(() => {
    let cancelled = false
    void window.origread.listReaderFonts().then((fonts)=>{if(!cancelled)setReaderFonts(fonts)}).catch(()=>{})
    return()=>{cancelled=true}
  }, [])

  useEffect(() => {
    const id = settings?.readerFontId
    if (!id?.startsWith('custom:') || readerFonts.some((font)=>font.id===id)) return
    void window.origread.listReaderFonts().then(setReaderFonts).catch(()=>{})
  }, [readerFonts, settings?.readerFontId])

  useEffect(() => {
    const id = settings?.readerFontId
    if (!id?.startsWith('custom:')) return
    const font = readerFonts.find((item)=>item.id===id)
    if (!font) return
    const face = new FontFace(font.cssFamily, `url(${font.dataUrl})`)
    let active = true
    void face.load().then((loaded)=>{if(active)document.fonts.add(loaded)}).catch(()=>{})
    return()=>{active=false;document.fonts.delete(face)}
  }, [readerFonts, settings?.readerFontId])

  useEffect(() => {
    if (!originalViewState.open || !readerStageRef.current) return
    const host = readerStageRef.current
    const updateBounds = (): void => {
      void window.origread.updateOriginalArticleBounds(boundsForElement(host))
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(host)
    window.addEventListener('resize', updateBounds)
    updateBounds()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [originalViewState.open, workspaceCollapsed])

  useEffect(() => {
    let cancelled = false
    if (!selectedArticleId) {
      setReaderContent(null)
      setReaderContentError(null)
      setReaderContentLoading(false)
      return () => { cancelled = true }
    }

    setReaderContent(null)
    setReaderContentError(null)
    setReaderMode('article')
    setAiSummary(null)
    setAiSummaryVisible(false)
    setAiSummaryProgress(null)
    setAiSummaryStartedAt(null)
    setTranslationDocument(null)
    setReaderToolNotice(null)
    setReaderContentLoading(true)
    void window.origread.getReaderContent(selectedArticleId)
      .then(async (content) => {
        if (cancelled) return
        const article = scopeArticles?.find((item) => item.id === selectedArticleId)
          ?? articles.find((item) => item.id === selectedArticleId)
        const feed = article ? feeds.find((item) => item.id === article.feedId) : null
        if ((feed?.sourceType === 'website' || feed?.isFullContent) && content.mode !== 'full') {
          const result = await window.origread.fetchFullContent(selectedArticleId)
          if (cancelled) return
          if (result.ok && result.content) {
            setReaderContent(result.content)
          } else {
            setReaderContent(content)
            setReaderContentError(t(`fullContentFailure.${result.failureReason ?? 'UNKNOWN'}`))
          }
          return
        }
        setReaderContent(content)
      })
      .catch((error) => {
        if (!cancelled) setReaderContentError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setReaderContentLoading(false)
      })

    return () => { cancelled = true }
  }, [articles, feeds, scopeArticles, selectedArticleId, t])

  useEffect(() => {
    setReaderSearchOpen(false)
    setReaderSearchQuery('')
    setReaderSearchCount(0)
    setReaderSearchIndex(0)
  }, [selectedArticleId])

  const handleReaderSearchCount = useCallback((count: number): void => {
    setReaderSearchCount(count)
    setReaderSearchIndex((current) => count <= 0 ? 0 : Math.min(current, count - 1))
  }, [])

  const closeReaderSearch = useCallback((): void => {
    setReaderSearchOpen(false)
    setReaderSearchQuery('')
    setReaderSearchCount(0)
    setReaderSearchIndex(0)
  }, [])

  const activeLabel = useMemo(
    () => t(destinations.find((item) => item.id === destination)?.labelKey ?? 'allArticles'),
    [destination, t]
  )

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const scopedArticles = articleScope.kind === 'all' ? articles : (scopeArticles ?? [])
  const visibleArticles = useMemo(() => {
    return scopedArticles.filter((article) => {
      if (destination === 'unread' && !article.isUnread) return false
      if (destination === 'starred' && !article.isStarred) return false
      if (!normalizedQuery) return true
      return `${article.title} ${article.author ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [destination, normalizedQuery, scopedArticles])
  const visibleFeeds = useMemo(() => {
    if (!sourcePickerOpen) return feeds
    if (!normalizedQuery) return feeds
    return feeds.filter((feed) => `${feed.name} ${feed.url}`.toLocaleLowerCase().includes(normalizedQuery))
  }, [feeds, normalizedQuery, sourcePickerOpen])
  const groupedVisibleFeeds = useMemo(() => {
    const sortedGroups = groups.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    const knownIds = new Set(sortedGroups.map((group) => group.id))
    const result = sortedGroups
      .map((group) => ({ group, feeds: visibleFeeds.filter((feed) => feed.groupId === group.id) }))
      .filter((entry) => entry.feeds.length > 0)
    const ungrouped = visibleFeeds.filter((feed) => !knownIds.has(feed.groupId))
    if (ungrouped.length > 0) result.push({ group: { id: '__ungrouped__', name: t('ungroupedSources'), sortOrder: Number.MAX_SAFE_INTEGER, isDefault: false }, feeds: ungrouped })
    return result
  }, [groups, t, visibleFeeds])
  const feedStatsById = useMemo(
    () => new Map(feedArticleStats.map((stats) => [stats.feedId, stats])),
    [feedArticleStats]
  )
  const feedStats = (feedId: string): FeedArticleStats =>
    feedStatsById.get(feedId) ?? { feedId, total: 0, unread: 0, starred: 0 }
  const statsForFeeds = (targetFeeds: FeedRecord[]): FeedArticleStats =>
    targetFeeds.reduce<FeedArticleStats>((summary, feed) => {
      const stats = feedStats(feed.id)
      return {
        feedId: summary.feedId,
        total: summary.total + stats.total,
        unread: summary.unread + stats.unread,
        starred: summary.starred + stats.starred
      }
    }, { feedId: '__aggregate__', total: 0, unread: 0, starred: 0 })
  const selectedArticle = scopedArticles.find((article) => article.id === selectedArticleId)
    ?? articles.find((article) => article.id === selectedArticleId)
    ?? null
  const selectedFeed = selectedArticle ? feeds.find((feed) => feed.id === selectedArticle.feedId) ?? null : null
  const activeScopeFeed = articleScope.kind === 'feed' ? feeds.find((feed) => feed.id === articleScope.id) ?? null : null
  const activeScopeGroup = articleScope.kind === 'group' ? groups.find((group) => group.id === articleScope.id) ?? null : null
  const scopeLabel = activeScopeFeed?.name ?? activeScopeGroup?.name ?? t('allSources')
  const scopedUnreadCount = articleScope.kind === 'all'
    ? (librarySnapshot?.unread ?? scopedArticles.filter((article) => article.isUnread).length)
    : scopedArticles.filter((article) => article.isUnread).length
  const scopedStarredCount = articleScope.kind === 'all'
    ? (librarySnapshot?.starred ?? scopedArticles.filter((article) => article.isStarred).length)
    : scopedArticles.filter((article) => article.isStarred).length
  const originalUrl = normalizeHttpUrl(selectedArticle?.url)
  const origReadReleaseLinks = useMemo(
    () => toOrigReadDesktopReleaseLinks(selectedArticle?.url, appInfo?.platform, appInfo?.arch),
    [appInfo?.arch, appInfo?.platform, selectedArticle?.url]
  )

  const mainSpeechText = useMemo(() => {
    if (!selectedArticle) return ''
    const source = selectMainSpeechSource({
      mode: readerMode,
      articleTitle: selectedArticle.title,
      articleHtml: readerContent?.html || selectedArticle.description,
      translatedTitle: translationDocument?.translatedTitle,
      translatedHtml: translationDocument?.translatedContent
    })
    return speechTextFromHtml(source.title, source.html)
  }, [readerContent?.html, readerMode, selectedArticle, translationDocument])

  const summarySpeechText = useMemo(() => aiSummary?.status === 'GENERATED' ? speechTextFromMarkdown(stripRedundantSummaryHeading(aiSummary.summary)) : '', [aiSummary])

  useEffect(() => {
    speech.stop()
  }, [readerMode, selectedArticleId])

  const toggleMainSpeech = (): void => {
    if (speech.state.domain === 'main' && speech.state.status === 'speaking') { speech.pause(); return }
    if (speech.state.domain === 'main' && speech.state.status === 'paused') { speech.resume(); return }
    speech.start(mainSpeechText, 'main')
  }

  const toggleSummarySpeech = (): void => {
    if (speech.state.domain === 'summary' && speech.state.status === 'speaking') { speech.pause(); return }
    if (speech.state.domain === 'summary' && speech.state.status === 'paused') { speech.resume(); return }
    speech.start(summarySpeechText, 'summary')
  }

  const aiSummaryPlacement = settings?.aiSummaryPlacement ?? 'replace'
  const aiLoading = readerToolLoading === 'ai'
  const aiSummaryDocked = Boolean((aiSummary || aiLoading) && aiSummaryVisible && aiSummaryPlacement !== 'replace')

  const toggleAiSummaryDisplay = (): void => {
    if (!aiSummary) { void generateAiSummary(); return }
    if (aiSummaryPlacement === 'replace') {
      const nextMode = readerMode === 'ai' ? 'article' : 'ai'
      setReaderMode(nextMode)
      setAiSummaryVisible(nextMode === 'ai')
      return
    }
    setAiSummaryVisible((visible)=>!visible)
    if (readerMode === 'ai') setReaderMode('article')
  }

  const changeAiSummaryPlacement = async (placement: AiSummaryPlacement): Promise<void> => {
    await updateDesktopSettings({ aiSummaryPlacement: placement })
    if (!aiSummary) return
    setAiSummaryVisible(true)
    setReaderMode(placement === 'replace' ? 'ai' : 'article')
  }

  const cycleAiSummaryPlacement = (direction: -1 | 1): void => {
    const currentIndex = aiSummaryPlacementOrder.indexOf(aiSummaryPlacement)
    const nextIndex = (currentIndex + direction + aiSummaryPlacementOrder.length) % aiSummaryPlacementOrder.length
    void changeAiSummaryPlacement(aiSummaryPlacementOrder[nextIndex]!)
  }

  const resizeAiSummaryPanel = (direction: -1 | 1): void => {
    if (aiSummaryPlacement === 'replace') return
    const current = settings?.aiSummaryPanelSize ?? 360
    const next = Math.max(
      AI_SUMMARY_PANEL_MIN,
      Math.min(AI_SUMMARY_PANEL_MAX, current + direction * AI_SUMMARY_PANEL_KEYBOARD_STEP)
    )
    if (next !== current) void updateDesktopSettings({ aiSummaryPanelSize: next })
  }

  const toggleWorkspace = (): void => {
    const next = !workspaceCollapsed
    setWorkspaceCollapsed(next)
    setSettings((current) => current ? { ...current, workspaceCollapsed: next } : current)
  }

  const generateAiSummary = async (forceRefresh = false, options?: AiSummaryRequestOptions): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    const requestArticleId = selectedArticleId
    const runId = ++aiSummaryRunRef.current
    if (originalViewState.open) await closeOriginalArticle()
    setSettingsOpen(false)
    setReaderToolLoading('ai')
    setReaderToolNotice(null)
    setAiSummaryProgress({ articleId: requestArticleId, stage: 'PREPARING' })
    setAiSummaryStartedAt(Date.now())
    setAiSummaryVisible(true)
    if (aiSummaryPlacement !== 'replace') setReaderMode('article')
    try {
      const result = await window.origread.summarizeArticle(requestArticleId, forceRefresh, options)
      if (runId !== aiSummaryRunRef.current || selectedArticleIdRef.current !== requestArticleId) return
      setAiSummary(result)
      setAiSummaryVisible(true)
      setReaderMode((settings?.aiSummaryPlacement ?? 'replace') === 'replace' ? 'ai' : 'article')
    } catch (error) {
      if (runId === aiSummaryRunRef.current && selectedArticleIdRef.current === requestArticleId) {
        setReaderToolNotice(readerToolFeedback(error, 'ai'))
        if (!aiSummary) setAiSummaryVisible(false)
      }
    } finally {
      if (runId === aiSummaryRunRef.current) {
        setReaderToolLoading(null)
        setAiSummaryProgress(null)
        setAiSummaryStartedAt(null)
      }
    }
  }

  const stopAiSummary = (): void => {
    const articleId = selectedArticleIdRef.current
    if (!articleId || readerToolLoading !== 'ai') return
    aiSummaryRunRef.current += 1
    void window.origread.stopAiSummary(articleId).catch(() => undefined)
    setReaderToolLoading(null)
    setAiSummaryProgress(null)
    setAiSummaryStartedAt(null)
    setReaderToolNotice(null)
    if (!aiSummary) {
      setAiSummaryVisible(false)
      if (readerMode === 'ai') setReaderMode('article')
    }
  }

  const translateSelectedArticle = async (forceRefresh = false, target?: TranslationTarget): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    if (originalViewState.open) await closeOriginalArticle()
    setSettingsOpen(false)
    setReaderToolLoading('translation')
    setReaderToolNotice(null)
    try {
      const result = await window.origread.translateArticle(selectedArticleId, target, forceRefresh)
      setTranslationDocument(result)
      setReaderMode('translation')
    } catch (error) {
      setReaderToolNotice(readerToolFeedback(error, 'translation'))
    } finally {
      setReaderToolLoading(null)
    }
  }

  const handleConfigurationRestored = async (): Promise<void> => {
    const [nextSettings, nextSync] = await Promise.all([window.origread.getSettings(), window.origread.getSyncRuntimeState()])
    const visibleSettings = nextSettings.workspaceCollapsed
      ? await window.origread.updateSettings({ workspaceCollapsed: false })
      : nextSettings
    setSettings(visibleSettings)
    setSyncRuntimeState(nextSync)
    setWorkspaceCollapsed(false)
    const language = visibleSettings.language === 'system' ? resolveDesktopLanguage(appInfo?.locale ?? navigator.language) : visibleSettings.language
    await i18n.changeLanguage(language)
    await reloadLibrary()
  }

  const handleAccountChanged = async (): Promise<void> => {
    setSelectedArticleId(null)
    setReaderContent(null)
    setAiSummary(null)
    setTranslationDocument(null)
    setReaderMode('article')
    if (originalViewState.open) await closeOriginalArticle()
    await reloadLibrary()
    setSyncRuntimeState(await window.origread.getSyncRuntimeState())
  }

  const updateDesktopSettings = async (patch: Parameters<typeof window.origread.updateSettings>[0]): Promise<void> => {
    setSettingsError(null)
    try {
      const next = await window.origread.updateSettings(patch)
      setSettings(next)
      if (patch.language !== undefined) {
        const language = next.language === 'system'
          ? resolveDesktopLanguage(appInfo?.locale ?? navigator.language)
          : next.language
        await i18n.changeLanguage(language)
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : String(error))
    }
  }

  const showSettings = async (page: SettingsPage = 'general'): Promise<void> => {
    if (originalViewState.open) await closeOriginalArticle()
    setSourceCatalogOpen(false)
    setSettingsInitialPage(page)
    setSettingsOpen(true)
    setReaderToolNotice(null)
    setSettingsError(null)
  }

  const closeOriginalArticle = async (): Promise<void> => {
    try {
      await window.origread.closeOriginalArticle()
      setOriginalViewState(closedOriginalState())
    } catch (error) {
      setReaderContentError(error instanceof Error ? error.message : String(error))
    }
  }

  const showOriginalArticle = async (): Promise<void> => {
    if (!originalUrl || !readerStageRef.current) return
    setSettingsOpen(false)
    setReaderContentError(null)
    try {
      const state = await window.origread.openOriginalArticle(originalUrl, boundsForElement(readerStageRef.current))
      setOriginalViewState(state)
    } catch (error) {
      setReaderContentError(error instanceof Error ? error.message : String(error))
    }
  }

  const navigateOriginalArticle = async (action: 'back' | 'forward' | 'reload'): Promise<void> => {
    try {
      setOriginalViewState(await window.origread.navigateOriginalArticle(action))
    } catch (error) {
      setReaderContentError(error instanceof Error ? error.message : String(error))
    }
  }

  const fetchSelectedFullContent = async (): Promise<void> => {
    if (!selectedArticleId || readerContentLoading) return
    setReaderContentLoading(true)
    setReaderContentError(null)
    try {
      const result = await window.origread.fetchFullContent(selectedArticleId)
      if (result.ok && result.content) {
        setReaderContent(result.content)
        await reloadLibrary()
      } else {
        setReaderContentError(t(`fullContentFailure.${result.failureReason ?? 'UNKNOWN'}`))
      }
    } catch (error) {
      setReaderContentError(error instanceof Error ? error.message : String(error))
    } finally {
      setReaderContentLoading(false)
    }
  }

  const openExternal = async (url: string): Promise<void> => {
    try {
      await window.origread.openExternalUrl(url)
    } catch (error) {
      setReaderContentError(`${t('openExternalFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleReaderHtmlClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a[href]')
    if (!anchor) return
    const url = normalizeHttpUrl(anchor.getAttribute('href'))
    if (!url) return
    event.preventDefault()
    void openExternal(url)
  }

  const selectArticle = (article: ArticleRecord): void => {
    if (article.isUnread) {
      setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isUnread: false } : item))
      setScopeArticles((current) => current?.map((item) => item.id === article.id ? { ...item, isUnread: false } : item) ?? current)
      setFeedArticleStats((current) => current.map((stats) => stats.feedId === article.feedId
        ? { ...stats, unread: Math.max(0, stats.unread - 1) }
        : stats))
      setLibrarySnapshot((current) => current ? { ...current, unread: Math.max(0, current.unread - 1) } : current)
      void window.origread.setArticleUnread(article.id, false)
    }
    const feed = feeds.find((item) => item.id === article.feedId)
    if (feed?.isBrowser) {
      const url = normalizeHttpUrl(article.url)
      if (url) void openExternal(url)
      return
    }
    if (settingsOpen) setSettingsOpen(false)
    if (originalViewState.open) void closeOriginalArticle()
    setSelectedArticleId(article.id)
  }

  const toggleStarred = (article: ArticleRecord): void => {
    const next = !article.isStarred
    setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isStarred: next } : item))
    setScopeArticles((current) => current?.map((item) => item.id === article.id ? { ...item, isStarred: next } : item) ?? current)
    setFeedArticleStats((current) => current.map((stats) => stats.feedId === article.feedId
      ? { ...stats, starred: Math.max(0, stats.starred + (next ? 1 : -1)) }
      : stats))
    setLibrarySnapshot((current) => current ? {
      ...current,
      starred: Math.max(0, current.starred + (next ? 1 : -1))
    } : current)
    void window.origread.setArticleStarred(article.id, next)
  }

  const toggleUnread = (article: ArticleRecord): void => {
    const next = !article.isUnread
    setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isUnread: next } : item))
    setScopeArticles((current) => current?.map((item) => item.id === article.id ? { ...item, isUnread: next } : item) ?? current)
    setFeedArticleStats((current) => current.map((stats) => stats.feedId === article.feedId
      ? { ...stats, unread: Math.max(0, stats.unread + (next ? 1 : -1)) }
      : stats))
    setLibrarySnapshot((current) => current ? {
      ...current,
      unread: Math.max(0, current.unread + (next ? 1 : -1))
    } : current)
    void window.origread.setArticleUnread(article.id, next)
  }

  const nextArticle = selectedArticle
    ? visibleArticles[visibleArticles.findIndex((item) => item.id === selectedArticle.id) + 1] ?? null
    : null
  const previousArticle = selectedArticle
    ? visibleArticles[visibleArticles.findIndex((item) => item.id === selectedArticle.id) - 1] ?? null
    : null

  const toggleFullContent = async (): Promise<void> => {
    if (!selectedArticleId || readerContentLoading) return
    if (readerMode !== 'article') setReaderMode('article')
    if (readerContent?.mode !== 'full') {
      await fetchSelectedFullContent()
      return
    }
    setReaderContentLoading(true)
    setReaderContentError(null)
    try {
      setReaderContent(await window.origread.getReaderContent(selectedArticleId, false))
    } catch (error) {
      setReaderContentError(error instanceof Error ? error.message : String(error))
    } finally {
      setReaderContentLoading(false)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      const target = event.target instanceof HTMLElement ? event.target : null
      const interactiveTarget = Boolean(target?.closest('input, textarea, select, button, a, [contenteditable="true"]'))

      if ((event.ctrlKey || event.metaKey) && key === 'f' && selectedArticleId && !settingsOpen && !sourceCatalogOpen && !originalViewState.open) {
        if (interactiveTarget && !readerSearchOpen) return
        event.preventDefault()
        if (readerMode === 'ai') setReaderMode('article')
        setReaderSearchOpen(true)
        window.setTimeout(() => readerSearchInputRef.current?.focus(), 0)
        return
      }
      if (event.key === 'Escape' && readerSearchOpen) {
        setReaderSearchOpen(false)
        setReaderSearchQuery('')
        setReaderSearchCount(0)
        setReaderSearchIndex(0)
        return
      }
      if (interactiveTarget || event.ctrlKey || event.metaKey || event.altKey || settingsOpen || sourceCatalogOpen || sourcePickerOpen || subscriptionMenuOpen || document.querySelector('[role="dialog"]')) return

      if (key === '[') {
        event.preventDefault()
        toggleWorkspace()
        return
      }
      if (originalViewState.open) {
        if (key === 'u' && selectedArticle) {
          event.preventDefault()
          void closeOriginalArticle()
        }
        return
      }
      if (key === 'arrowup' || key === 'arrowdown') {
        const content = readerContentRef.current
        if (content) {
          event.preventDefault()
          const distance = Math.max(120, Math.round(content.clientHeight * 0.18))
          content.scrollBy({ top: key === 'arrowup' ? -distance : distance, behavior: 'smooth' })
        }
        return
      }
      if (key === 'arrowleft' || key === 'arrowright') {
        if (event.repeat) return
        const targetArticle = key === 'arrowright'
          ? (selectedArticle ? nextArticle : visibleArticles[0] ?? null)
          : (selectedArticle ? previousArticle : visibleArticles.at(-1) ?? null)
        if (targetArticle) {
          event.preventDefault()
          selectArticle(targetArticle)
        }
        return
      }
      if (key === 'j') {
        const targetArticle = selectedArticle ? nextArticle : visibleArticles[0] ?? null
        if (targetArticle) {
          event.preventDefault()
          selectArticle(targetArticle)
        }
        return
      }
      if (key === 'k') {
        const targetArticle = selectedArticle ? previousArticle : visibleArticles.at(-1) ?? null
        if (targetArticle) {
          event.preventDefault()
          selectArticle(targetArticle)
        }
        return
      }
      if (!selectedArticle || event.repeat) return
      if (key === 'm') {
        event.preventDefault()
        toggleUnread(selectedArticle)
      } else if (key === 's') {
        event.preventDefault()
        toggleStarred(selectedArticle)
      } else if (key === 'u' && originalUrl) {
        event.preventDefault()
        void showOriginalArticle()
      } else if ((event.code === 'Comma' || event.code === 'Period') && aiSummaryVisible && (aiSummary || aiLoading)) {
        event.preventDefault()
        cycleAiSummaryPlacement(event.code === 'Comma' ? -1 : 1)
      } else if ((key === '-' || key === '=' || key === '+') && aiSummaryVisible && (aiSummary || aiLoading)) {
        event.preventDefault()
        resizeAiSummaryPanel(key === '-' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [aiLoading, aiSummary, aiSummaryPlacement, aiSummaryVisible, nextArticle, originalUrl, originalViewState.open, previousArticle, readerMode, readerSearchOpen, selectedArticle, selectedArticleId, settings?.aiSummaryPanelSize, settingsOpen, sourceCatalogOpen, sourcePickerOpen, subscriptionMenuOpen, visibleArticles, workspaceCollapsed])

  const openAddSource = (): void => {
    setSubscriptionMenuOpen(false)
    setSourceCatalogOpen(false)
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
    setSelectedCandidateIds([])
    setAddSourceOpen(true)
  }

  const importOpml = async (): Promise<void> => {
    if (opmlBusy) return
    setSubscriptionMenuOpen(false)
    setOpmlBusy(true)
    setSourceError(null)
    setOpmlStatus(null)
    try {
      const result = await window.origread.importOpml()
      if (result.cancelled) return
      if (!result.ok || !result.importResult) {
        setSourceError(result.error ?? t('opmlImportFailed'))
        return
      }
      await reloadLibrary()
      setDestination('all')
      setOpmlStatus(t('opmlImportSuccess', {
        feeds: result.importResult.feedsAdded,
        groups: result.importResult.groupsAdded,
        skipped: result.importResult.feedsSkipped
      }))
    } catch (error) {
      setSourceError(`${t('opmlImportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOpmlBusy(false)
    }
  }

  const exportOpml = async (): Promise<void> => {
    if (opmlBusy) return
    setOpmlBusy(true)
    setSourceError(null)
    setOpmlStatus(null)
    try {
      const result = await window.origread.exportOpml(opmlAttachInfo)
      if (result.cancelled) return
      if (!result.ok) {
        setSourceError(result.error ?? t('opmlExportFailed'))
        return
      }
      setOpmlExportOpen(false)
      setOpmlStatus(t('opmlExportSuccess'))
    } catch (error) {
      setSourceError(`${t('opmlExportFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOpmlBusy(false)
    }
  }

  const showSourceCatalog = async (): Promise<void> => {
    if (originalViewState.open) await closeOriginalArticle()
    setSettingsOpen(false)
    setSourceCatalogOpen(true)
  }

  const discoverSourceWithProgress = async (url: string): Promise<SourceDiscoveryResult> => {
    const requestId = crypto.randomUUID()
    sourceDiscoveryRequestIdRef.current = requestId
    setSourceDiscoveryRequestId(requestId)
    setSourceDiscoveryStages({})
    setSourceDiscoveryStartedAt(Date.now())
    try {
      return await window.origread.discoverSource(url, requestId)
    } finally {
      if (sourceDiscoveryRequestIdRef.current === requestId) sourceDiscoveryRequestIdRef.current = null
      setSourceDiscoveryRequestId((current) => current === requestId ? null : current)
      setSourceDiscoveryStartedAt(null)
    }
  }

  const subscribeCatalogFeed = async (feed: FeedCatalogEntry): Promise<void> => {
    setSourceCatalogOpen(false)
    setSettingsOpen(false)
    setSourceUrl(feed.feedUrl)
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
    setSelectedCandidateIds([])
    setAddSourceOpen(true)
    setIsAddingSource(true)
    try {
      const discovered = await discoverSourceWithProgress(feed.feedUrl)
      setSourceDiscovery(discovered)
      setSelectedCandidateId(discovered.selectedCandidateId)
      setSelectedCandidateIds(discovered.selectedCandidateId ? [discovered.selectedCandidateId] : [])
      if (discovered.candidates.length === 0) setSourceError(discovered.error ?? t('noSourceCandidate'))
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsAddingSource(false)
    }
  }

  const closeAddSource = (): void => {
    if (isAddingSource) return
    setAddSourceOpen(false)
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
    setSelectedCandidateIds([])
  }

  const submitSource = async (): Promise<void> => {
    if (!sourceUrl.trim() || isAddingSource) return
    setIsAddingSource(true)
    setSourceError(null)
    try {
      if (!sourceDiscovery) {
        const discovered = await discoverSourceWithProgress(sourceUrl)
        setSourceDiscovery(discovered)
        setSelectedCandidateId(discovered.selectedCandidateId)
        setSelectedCandidateIds(discovered.selectedCandidateId ? [discovered.selectedCandidateId] : [])
        if (discovered.candidates.length === 0) {
          setSourceError(discovered.error ?? t('noSourceCandidate'))
        }
        return
      }
      const fallbackCandidateId = selectedCandidateId ?? sourceDiscovery.selectedCandidateId
      const candidateIds = selectedCandidateIds.length > 0
        ? selectedCandidateIds
        : fallbackCandidateId ? [fallbackCandidateId] : []
      if (candidateIds.length === 0) {
        setSourceError(t('selectSourceCandidate'))
        return
      }
      await window.origread.subscribeSource(sourceDiscovery.discoveryId, candidateIds)
      await reloadLibrary()
      setSourceUrl('')
      setSourceDiscovery(null)
      setSelectedCandidateId(null)
      setSelectedCandidateIds([])
      setAddSourceOpen(false)
      setDestination('all')
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsAddingSource(false)
    }
  }

  const refreshFeed = async (feed: FeedRecord, scopeAfterRefresh?: ArticleScope): Promise<void> => {
    if (refreshingFeedId || isRefreshingAll) return
    setRefreshingFeedId(feed.id)
    setSourceError(null)
    try {
      await window.origread.refreshSource(feed.id)
      if (scopeAfterRefresh) {
        const [_, loadedScopeArticles] = await Promise.all([
          reloadLibrary(),
          loadArticlesForScope(scopeAfterRefresh)
        ])
        setScopeArticles(loadedScopeArticles)
      } else {
        await Promise.all([reloadLibrary(), reloadCurrentScope()])
      }
    } catch (error) {
      setSourceError(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRefreshingFeedId(null)
    }
  }

  const selectFeedScope = (feed: FeedRecord): void => {
    const scope: ArticleScope = { kind: 'feed', id: feed.id }
    setArticleScope(scope)
    setSourcePickerOpen(false)
    setSelectedArticleId(null)
    setQuery('')
    if (isOrigReadDesktopReleaseFeed(feed.url) && feedStats(feed.id).total === 0) {
      void refreshFeed(feed, scope)
    }
  }

  const deleteFeedFromMenu = async (feed: FeedRecord): Promise<void> => {
    setContextMenu(null)
    if (!window.confirm(t('confirmDeleteSource'))) return
    setSourceError(null)
    try {
      await window.origread.deleteFeed(feed.id)
      if (articleScope.kind === 'feed' && articleScope.id === feed.id) setArticleScope({ kind: 'all' })
      if (selectedArticle?.feedId === feed.id) setSelectedArticleId(null)
      if (sourceSettingsFeed?.id === feed.id) setSourceSettingsFeed(null)
      await reloadLibrary()
    } catch (error) {
      setSourceError(`${t('deleteSource')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const moveFeedFromMenu = async (feed: FeedRecord, groupId: string): Promise<void> => {
    setContextMenu(null)
    if (feed.groupId === groupId) return
    setSourceError(null)
    try {
      await window.origread.updateFeedSettings(feed.id, { groupId })
      await Promise.all([reloadLibrary(), reloadCurrentScope()])
    } catch (error) {
      setSourceError(`${t('moveToGroup')}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const refreshAllSources = async (): Promise<void> => {
    if (isRefreshingAll || refreshingFeedId || feeds.length === 0) return
    setIsRefreshingAll(true)
    setSourceError(null)
    try {
      const result = await window.origread.refreshAllSources()
      await Promise.all([reloadLibrary(), reloadCurrentScope()])
      if (result.failedCount > 0) {
        const firstFailure = result.results.find((item) => item.status === 'failed')
        setSourceError(t('syncPartialFailure', {
          failed: result.failedCount,
          total: result.sourceCount,
          error: firstFailure?.error ?? t('unknownError')
        }))
      }
    } catch (error) {
      setSourceError(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsRefreshingAll(false)
    }
  }

  const readerBackground = resolveReaderBackground(
    settings?.readerBackground ?? 'theme',
    resolvedTheme,
    settings?.readerBackgroundCustom ?? '#eef7ee'
  )
  const readerColors = resolveReaderColors(readerBackground)
  const readerStyle = {
    '--reader-font-size': `${settings?.readerFontSize ?? 17}px`,
    '--reader-line-height': String(settings?.readerLineHeight ?? 1.85),
    '--reader-content-width': `${settings?.readerContentWidth ?? 760}px`,
    '--reader-font-family': resolveReaderFontFamily(settings?.readerFontId ?? 'system', readerFonts),
    '--reader-background': readerBackground,
    '--reader-text-color': readerColors.text,
    '--reader-heading-color': readerColors.heading,
    '--reader-muted-color': readerColors.muted,
    '--reader-soft-background': readerColors.softBackground,
    '--reader-border-color': readerColors.border,
    '--reader-link-color': readerColors.link,
    '--ai-summary-panel-size': `${settings?.aiSummaryPanelSize ?? 360}px`
  } as CSSProperties

  const renderAiSummaryPanel = (replaceMode = false): React.JSX.Element | null => aiSummary || aiLoading ? (
    <AiSummaryPanel
      summary={aiSummary}
      loading={aiLoading}
      progressStage={aiSummaryProgress?.stage ?? null}
      elapsedSeconds={aiSummaryElapsedSeconds}
      placement={aiSummaryPlacement}
      panelSize={settings?.aiSummaryPanelSize ?? 360}
      speechActive={speech.state.domain==='summary'}
      speechStatus={speech.state.status}
      onToggleSpeech={toggleSummarySpeech}
      onStopSpeech={speech.stop}
      onPlacementChange={(placement)=>void changeAiSummaryPlacement(placement)}
      onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
      onRegenerate={()=>{if(!aiLoading)setAiOptionsOpen(true)}}
      onStop={stopAiSummary}
      onClose={()=>{if(speech.state.domain==='summary')speech.stop();setAiSummaryVisible(false);if(readerMode==='ai')setReaderMode('article')}}
      replaceMode={replaceMode}
    />
  ) : null

  return (
    <main className={`app-shell ${workspaceCollapsed ? 'workspace-collapsed' : ''}`} style={readerStyle}>
      {!workspaceCollapsed && (
        <section className="workspace-pane" aria-label={activeLabel}>
          <header className="brand-row">
            <div className="brand-lockup">
              <img className="brand-logo" src="./logo.png" alt="" />
              <div>
                <div className="brand-name">{t('brand')}</div>
                <div className="brand-tagline">{t('tagline')}</div>
              </div>
            </div>
            <div className="brand-actions">
              <button className="icon-button source-discovery-button" type="button" title={t('sourceDiscoveryTitle')} aria-label={t('sourceDiscoveryTitle')} onClick={()=>void showSourceCatalog()}>
                <Compass size={17}/>
              </button>
              <div className="subscription-menu-anchor">
                <button className="primary-action subscription-trigger" type="button" title={t('addSubscription')} aria-label={t('addSubscription')} onClick={()=>setSubscriptionMenuOpen((open)=>!open)} disabled={opmlBusy} aria-expanded={subscriptionMenuOpen}>
                  <Plus size={14} strokeWidth={2.2} />
                  {t('add')}
                  <ChevronDown size={12}/>
                </button>
                {subscriptionMenuOpen && (
                  <>
                    <button className="subscription-menu-backdrop" type="button" aria-label={t('cancel')} onClick={()=>setSubscriptionMenuOpen(false)}/>
                    <div className="subscription-menu" role="menu">
                      <button type="button" role="menuitem" onClick={openAddSource}><Rss size={16}/><span>{t('addSourceTitle')}</span></button>
                      <button type="button" role="menuitem" onClick={()=>void importOpml()}><Upload size={16}/><span>{t('importOpml')}</span></button>
                      <button type="button" role="menuitem" onClick={()=>{setSubscriptionMenuOpen(false);setOpmlExportOpen(true)}}><Download size={16}/><span>{t('exportOpml')}</span></button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </header>

          <nav className="destination-tabs" aria-label="Article filters">
            {destinations.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                type="button"
                className={`destination-tab ${destination === id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedArticleId(null)
                  setQuery('')
                  setDestination(id)
                  setSourcePickerOpen(false)
                }}
              >
                <Icon size={16} />
                <span>{t(labelKey)}</span>
                {id === 'unread' && <span className="count-badge">{scopedUnreadCount}</span>}
                {id === 'starred' && scopedStarredCount > 0 && <span className="count-badge">{scopedStarredCount}</span>}
              </button>
            ))}
          </nav>

          <div className="article-scope-bar">
            <div className="article-scope-current">
              {activeScopeFeed ? <FeedIcon feed={activeScopeFeed} /> : <div className="scope-icon"><Rss size={15}/></div>}
              <div>
                <span>{t('readingScope')}</span>
                <strong>{scopeLabel}</strong>
              </div>
            </div>
            <div className="article-scope-actions">
              {articleScope.kind !== 'all' && (
                <button type="button" className="icon-button" title={t('clearSourceFilter')} aria-label={t('clearSourceFilter')} onClick={()=>{setArticleScope({kind:'all'});setSelectedArticleId(null)}}><X size={14}/></button>
              )}
              <button type="button" className={`scope-picker-button ${sourcePickerOpen?'active':''}`} aria-expanded={sourcePickerOpen} onClick={()=>{setSourcePickerOpen((open)=>!open);setSelectedArticleId(null);setQuery('')}}>
                <Rss size={14}/><span>{sourcePickerOpen?t('backToArticles'):t('chooseSourceScope')}</span><ChevronDown size={13}/>
              </button>
            </div>
          </div>

          <div className="list-toolbar">
            <div className="search-field">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={sourcePickerOpen ? t('searchSources') : t('searchArticles')}
                placeholder={sourcePickerOpen ? t('searchSources') : t('searchArticles')}
              />
              <kbd>Ctrl K</kbd>
            </div>
            <div className="list-meta">
              <span>
                {sourcePickerOpen
                  ? t('sourceCount', { count: visibleFeeds.length })
                  : t('articleCount', { count: visibleArticles.length })}
              </span>
              <button
                type="button"
                className="icon-button refresh-all-button"
                aria-label={activeScopeFeed ? t('refresh') : t('refreshAll')}
                title={activeScopeFeed ? t('reloadSourceArticles') : t('refreshAll')}
                disabled={feeds.length === 0 || isRefreshingAll || refreshingFeedId !== null}
                onClick={() => activeScopeFeed ? void refreshFeed(activeScopeFeed) : void refreshAllSources()}
              >
                <RefreshCw size={16} className={isRefreshingAll || refreshingFeedId === activeScopeFeed?.id ? 'spinning' : ''} />
              </button>
              <button type="button" className="icon-button" aria-label={t('more')}>
                <MoreHorizontal size={17} />
              </button>
            </div>
          </div>

          <div className="workspace-list-stage">
            {opmlStatus && !addSourceOpen && (
              <div className="workspace-notice">{opmlStatus}</div>
            )}
            {sourceError && !addSourceOpen && (
              <div className="workspace-error">{sourceError}</div>
            )}

            {sourcePickerOpen ? (
              <div className="list-content source-list source-scope-picker">
                <button className={`source-scope-all ${articleScope.kind==='all'?'selected':''}`} type="button" onClick={()=>{setArticleScope({kind:'all'});setSourcePickerOpen(false);setSelectedArticleId(null);setQuery('')}}>
                  <div className="scope-icon"><Inbox size={15}/></div>
                  <div><strong>{t('allSources')}</strong><span>{t('articleCount',{count:librarySnapshot?.articles ?? articles.length})}</span></div>
                  <span className="scope-unread-count">{t('unreadCountShort',{count:librarySnapshot?.unread ?? articles.filter((article)=>article.isUnread).length})}</span>
                </button>
                {groupedVisibleFeeds.map(({group,feeds:groupFeeds})=><section className="source-group-section" key={group.id}>
                  <button className={`source-group-header source-group-scope ${articleScope.kind==='group'&&articleScope.id===group.id?'selected':''}`} type="button" onClick={()=>{setArticleScope({kind:'group',id:group.id});setSourcePickerOpen(false);setSelectedArticleId(null);setQuery('')}}>
                    <span className="source-group-name"><strong>{group.name}</strong><small>{t('sourceCount',{count:groupFeeds.length})}</small></span>
                    <span>{t('unreadCountShort',{count:statsForFeeds(groupFeeds).unread})}</span>
                  </button>
                  <div className="source-group-items">{groupFeeds.map((feed) => (
                    <article className={`source-item ${articleScope.kind==='feed'&&articleScope.id===feed.id?'selected':''}`} key={feed.id} tabIndex={0} role="button" onClick={()=>selectFeedScope(feed)} onContextMenu={(event)=>{event.preventDefault();event.stopPropagation();setContextMenu({kind:'feed',x:event.clientX,y:event.clientY,feedId:feed.id})}} onKeyDown={(event)=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();selectFeedScope(feed)}}}>
                      <FeedIcon feed={feed} />
                      <div className="source-copy">
                        <strong>{feed.name}</strong>
                        <span>{t('sourceArticleStats',{total:feedStats(feed.id).total,unread:feedStats(feed.id).unread})}</span>
                      </div>
                      <div className="source-actions">
                        <span className="source-type">{feed.sourceType.toUpperCase()}</span>
                        <button
                          type="button"
                          className="source-refresh-button"
                          title={t('refresh')}
                          aria-label={t('refresh')}
                          disabled={refreshingFeedId !== null || isRefreshingAll}
                          onClick={(event) => {event.stopPropagation();void refreshFeed(feed)}}
                        >
                          <RefreshCw size={13} className={refreshingFeedId === feed.id ? 'spinning' : ''} />
                        </button>
                        <button
                          type="button"
                          className="source-settings-button"
                          title={t('sourceSettings')}
                          aria-label={t('sourceSettings')}
                          onClick={(event) => {event.stopPropagation();setSourceSettingsFeed(feed)}}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                    </article>
                  ))}</div>
                </section>)}
              </div>
            ) : visibleArticles.length > 0 ? (
              <div className="list-content article-list">
                {visibleArticles.map((article) => (
                  <article
                    className={`article-item ${article.isUnread?'unread':'read'} ${selectedArticleId === article.id ? 'selected' : ''}`}
                    key={article.id}
                    data-article-id={article.id}
                    data-feed-id={article.feedId}
                    onClick={() => selectArticle(article)}
                    onContextMenu={(event)=>{event.preventDefault();event.stopPropagation();setContextMenu({kind:'article',x:event.clientX,y:event.clientY,articleId:article.id})}}
                  >
                    <div className="article-topline">
                      <span className={`unread-dot ${article.isUnread ? 'visible' : ''}`} />
                      <strong>{article.title}</strong>
                      <button
                        className={`star-button ${article.isStarred ? 'active' : ''}`}
                        type="button"
                        aria-label={t('starred')}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleStarred(article)
                        }}
                      >
                        <Star size={15} fill={article.isStarred ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                    <p>{article.description || t('sourcePreviewUnavailable')}</p>
                    <div className="article-meta">
                      <span>{feeds.find((feed) => feed.id === article.feedId)?.name ?? ''}</span>
                      <span>{article.isUnread ? t('unreadStatus') : t('readStatus')}</span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-list-state">
                <div className="empty-icon"><Rss size={22} /></div>
                <h1>{t('timelineEmpty')}</h1>
                <p>{t('timelineEmptyDesc')}</p>
                <button className="secondary-action" type="button" onClick={openAddSource}>
                  <Plus size={16} />
                  {t('addSourceNow')}
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      <div className="pane-divider" aria-hidden="true">
        <button
          className="collapse-handle"
          type="button"
          aria-label={workspaceCollapsed ? t('expandWorkspace') : t('collapseWorkspace')}
          title={workspaceCollapsed ? t('expandWorkspace') : t('collapseWorkspace')}
          onClick={toggleWorkspace}
        >
          {workspaceCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>

      <section className="reader-pane">
        <header className="reader-toolbar">
          <div className="reader-title">
            {settingsOpen ? t('settings') : sourceCatalogOpen ? t('sourceDiscoveryTitle') : originalViewState.open ? (originalViewState.title || t('original')) : t('reader')}
          </div>
          <div className="reader-actions">
            {settingsOpen ? (
              <button type="button" className="settings-close-button" onClick={() => setSettingsOpen(false)}>
                <X size={17} /><span>{t('closeSettings')}</span>
              </button>
            ) : sourceCatalogOpen ? (
              <button type="button" className="settings-close-button" onClick={() => setSourceCatalogOpen(false)}>
                <X size={17} /><span>{t('back')}</span>
              </button>
            ) : originalViewState.open ? (
              <>
                <button type="button" className="icon-button" disabled={!originalViewState.canGoBack} aria-label={t('back')} onClick={() => void navigateOriginalArticle('back')}>
                  <ArrowLeft size={17} />
                </button>
                <button type="button" className="icon-button" disabled={!originalViewState.canGoForward} aria-label={t('forward')} onClick={() => void navigateOriginalArticle('forward')}>
                  <ArrowRight size={17} />
                </button>
                <button type="button" className="icon-button" aria-label={t('refresh')} onClick={() => void navigateOriginalArticle('reload')}>
                  <RefreshCw size={16} className={originalViewState.loading ? 'spinning' : ''} />
                </button>
                <button type="button" disabled={!originalViewState.url} onClick={() => originalViewState.url && void openExternal(originalViewState.url)}>
                  <ExternalLink size={17} /><span>{t('externalBrowser')}</span>
                </button>
                <button type="button" className="reader-mode-button" onClick={() => void closeOriginalArticle()}>
                  <BookOpenText size={17} /><span>{t('backToReader')}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`ai-summary-button ${(readerMode === 'ai' || aiSummaryDocked) && aiSummaryVisible ? 'active' : ''}`}
                  disabled={!selectedArticle || readerToolLoading !== null}
                  onClick={toggleAiSummaryDisplay}
                >
                  <AiSummaryAccentIcon variant="toolbar" loading={readerToolLoading === 'ai'} />
                  <span>{t('aiSummary')}</span>
                </button>
                <button type="button" className="icon-button reader-tool-options" disabled={!selectedArticle || readerToolLoading !== null} title={t('aiSummaryOptions')} aria-label={t('aiSummaryOptions')} onClick={()=>setAiOptionsOpen(true)}><ChevronDown size={15}/></button>
                <button
                  type="button"
                  className={`translation-button ${readerMode === 'translation' ? 'active' : ''}`}
                  disabled={!selectedArticle || readerToolLoading !== null}
                  onClick={() => readerMode === 'translation' ? setReaderMode('article') : translationDocument ? setReaderMode('translation') : void translateSelectedArticle()}
                >
                  {readerToolLoading === 'translation' ? <RefreshCw size={17} className="spinning" /> : <Languages size={17} />}
                  <span>{t('translation')}</span>
                </button>
                <button type="button" className="icon-button reader-tool-options" disabled={!selectedArticle || readerToolLoading !== null} title={t('translationTarget')} aria-label={t('translationTarget')} onClick={()=>setTranslationTargetOpen(true)}><ChevronDown size={15}/></button>
                <button type="button" className={`icon-button ${selectedArticle?.isUnread ? 'active' : ''}`} disabled={!selectedArticle} title={selectedArticle?.isUnread?t('markRead'):t('markUnread')} aria-label={selectedArticle?.isUnread?t('markRead'):t('markUnread')} onClick={()=>selectedArticle&&toggleUnread(selectedArticle)}><BookOpenText size={16}/></button>
                <button type="button" className={`icon-button ${selectedArticle?.isStarred ? 'active' : ''}`} disabled={!selectedArticle} title={selectedArticle?.isStarred?t('unstar'):t('starArticle')} aria-label={selectedArticle?.isStarred?t('unstar'):t('starArticle')} onClick={()=>selectedArticle&&toggleStarred(selectedArticle)}><Star size={16} fill={selectedArticle?.isStarred?'currentColor':'none'}/></button>
                <button type="button" className="icon-button" disabled={!nextArticle} title={t('nextArticle')} aria-label={t('nextArticle')} onClick={()=>nextArticle&&selectArticle(nextArticle)}><ChevronRight size={17}/></button>
                <button type="button" className={`icon-button reader-tts-button ${speech.state.domain==='main'?'active':''}`} disabled={!selectedArticle||!mainSpeechText} title={speech.state.domain==='main'&&speech.state.status==='speaking'?t('pauseReading'):speech.state.domain==='main'&&speech.state.status==='paused'?t('resumeReading'):t('readArticle')} aria-label={t('readArticle')} onClick={toggleMainSpeech}>
                  {speech.state.domain==='main'&&speech.state.status==='speaking'
                    ? <Pause size={16}/>
                    : speech.state.domain==='main'&&speech.state.status==='paused'
                      ? <Play size={16}/>
                      : <Headphones size={16}/>
                  }
                </button>
                {speech.state.status!=='idle'&&<button type="button" className="icon-button reader-tts-stop" title={t('stopReading')} aria-label={t('stopReading')} onClick={speech.stop}><Square size={14}/></button>}
                <select className="reader-voice-select" value={settings?.ttsVoiceURI??''} title={t('readingVoice')} aria-label={t('readingVoice')} onChange={(event)=>void updateDesktopSettings({ttsVoiceURI:event.target.value})}>
                  <option value="">{t('systemDefaultVoice')}</option>
                  {speech.voices.map((voice)=><option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
                </select>
                <button
                  type="button"
                  className={`full-content-button ${readerContent?.mode === 'full' ? 'active' : ''}`}
                  disabled={!selectedArticle || !originalUrl || readerContentLoading}
                  onClick={() => void toggleFullContent()}
                >
                  <BookOpenText size={17} /><span>{readerContent?.mode === 'full' ? t('feedContent') : t('fullContent')}</span>
                </button>
                <button
                  type="button"
                  className="original-button"
                  disabled={!originalUrl}
                  onClick={() => void showOriginalArticle()}
                >
                  <ExternalLink size={17} /><span>{t('original')}</span>
                </button>
                <button type="button" className="icon-button settings-button" aria-label={t('settings')} title={t('settings')} onClick={() => void showSettings()}>
                  <Settings size={17} />
                </button>
              </>
            )}
          </div>
        </header>

        <div className={`reader-stage ${originalViewState.open ? 'original-active' : ''}`} ref={readerStageRef}>
        {settingsOpen && settings ? (
          <>
            {settingsError && <div className="settings-error">{settingsError}</div>}
            <SettingsPanel
              settings={settings}
              appInfo={appInfo}
              syncState={syncRuntimeState}
              initialPage={settingsInitialPage}
              onChange={(patch) => void updateDesktopSettings(patch)}
              onConfigurationRestored={() => void handleConfigurationRestored()}
              onAccountChanged={() => void handleAccountChanged()}
            />
          </>
        ) : sourceCatalogOpen ? (
          <SourceDiscoveryPanel onSubscribe={(feed)=>void subscribeCatalogFeed(feed)}/>
        ) : selectedArticle ? (
          <div className={`reader-composite ${aiSummaryDocked ? `summary-docked summary-${aiSummaryPlacement}` : ''}`}>
          {aiSummaryDocked && (aiSummaryPlacement==='left'||aiSummaryPlacement==='top') && renderAiSummaryPanel()}
          <div ref={readerContentRef} className={`reader-content reader-mode-${readerMode}`}>
            {readerSearchOpen && readerMode !== 'ai' && (
              <ReaderSearchBar
                query={readerSearchQuery}
                count={readerSearchCount}
                activeIndex={readerSearchIndex}
                inputRef={readerSearchInputRef}
                onQueryChange={(value)=>{setReaderSearchQuery(value);setReaderSearchIndex(0)}}
                onPrevious={()=>setReaderSearchIndex((current)=>nextSearchIndex(current,readerSearchCount,-1))}
                onNext={()=>setReaderSearchIndex((current)=>nextSearchIndex(current,readerSearchCount,1))}
                onClose={closeReaderSearch}
              />
            )}
            <div className="article-heading">
              <span>{selectedFeed?.name ?? ''}</span>
              <h1>{readerMode === 'translation' && translationDocument ? translationDocument.translatedTitle : selectedArticle.title}</h1>
              {readerMode === 'translation' && translationDocument && translationDocument.translatedTitle.trim() !== selectedArticle.title.trim() && (
                <div className="article-original-title"><strong>{t('originalTitle')}：</strong>{selectedArticle.title}</div>
              )}
              <div>{selectedArticle.author ?? ''}</div>
            </div>
            {readerToolNotice && (
              <div className="reader-tool-notice" role="status" aria-live="polite">
                <div className="reader-tool-notice-copy">
                  <strong>{t(readerToolNotice.code)}</strong>
                </div>
                {readerToolNotice.settingsPage && (
                  <button type="button" className="reader-tool-notice-action" onClick={()=>void showSettings(readerToolNotice.settingsPage!)}>
                    <Settings size={14}/>
                    <span>{t(readerToolNotice.settingsPage === 'ai' ? 'openAiSettings' : 'openTranslationSettings')}</span>
                  </button>
                )}
                <button type="button" className="reader-tool-notice-close" aria-label={t('close')} onClick={()=>setReaderToolNotice(null)}><X size={14}/></button>
              </div>
            )}
            {aiLoading && aiSummaryPlacement === 'replace' && !aiSummary && (
              <AiSummaryProgressBanner stage={aiSummaryProgress?.stage ?? null} elapsedSeconds={aiSummaryElapsedSeconds} onStop={stopAiSummary}/>
            )}
            {readerMode === 'ai' && aiSummary && aiSummaryVisible ? (
              renderAiSummaryPanel(true)
            ) : readerMode === 'translation' && translationDocument ? (
              <>
                <div className="translation-result-meta">{translationTargetLabel(translationDocument.target)} · {translationDocument.targetLanguage} · {translationDocument.displayMode === 'BILINGUAL' ? t('bilingual') : t('translatedOnly')}</div>
                <SearchableHtml
                  html={translationDocument.translatedContent}
                  className="article-body translated-article-body"
                  query={readerSearchQuery}
                  activeIndex={readerSearchIndex}
                  onMatchCount={handleReaderSearchCount}
                  onClick={handleReaderHtmlClick}
                />
                <button className="mini-action regenerate-button" onClick={() => void translateSelectedArticle(true, translationDocument.target)}><RefreshCw size={13}/>{t('retranslate')}</button>
              </>
            ) : readerContentLoading ? (
              <div className="article-body-status">{t('loadingContent')}</div>
            ) : readerContentError ? (
              <div className="article-body-status error">{t('readerContentFailed')}: {readerContentError}</div>
            ) : readerContent?.html ? (
              <SearchableHtml
                html={readerContent.html}
                className="article-body"
                query={readerSearchQuery}
                activeIndex={readerSearchIndex}
                onMatchCount={handleReaderSearchCount}
                onClick={handleReaderHtmlClick}
              />
            ) : (
              <div className="article-body-status">{selectedArticle.description || t('readerTextUnavailable')}</div>
            )}
            {origReadReleaseLinks && (
              <section className="origread-release-actions" aria-label={t('projectReleaseActions')}>
                <div className="origread-release-actions-copy">
                  <strong>{t('projectReleaseActions')}</strong>
                  {origReadReleaseLinks.assetName ? (
                    <span>{t('projectReleaseAssetForDevice', { asset: origReadReleaseLinks.assetName })}</span>
                  ) : (
                    <span>{t('projectReleaseNoAssetForDevice')}</span>
                  )}
                </div>
                <div className="origread-release-actions-buttons">
                  {origReadReleaseLinks.downloadUrl && (
                    <button type="button" className="origread-release-download" onClick={()=>void openExternal(origReadReleaseLinks.downloadUrl!)}>
                      <Download size={15}/><span>{t('downloadUpdate')}</span>
                    </button>
                  )}
                  <button type="button" className="origread-release-page" onClick={()=>void openExternal(origReadReleaseLinks.releasePageUrl)}>
                    <ExternalLink size={15}/><span>{t('openReleasePage')}</span>
                  </button>
                </div>
              </section>
            )}
          </div>
          {aiSummaryDocked && (aiSummaryPlacement==='right'||aiSummaryPlacement==='bottom') && renderAiSummaryPanel()}
          </div>
        ) : (
          <div className="reader-empty-state">
            <div className="reader-empty-mark"><BookOpenText size={30}/></div>
            {articles.length === 0 ? (
              <>
                <h2>{t('readerLibraryEmpty')}</h2>
                <p>{t('readerLibraryEmptyDesc')}</p>
                <div className="reader-empty-actions">
                  <button type="button" className="secondary-action" onClick={openAddSource}><Plus size={15}/>{t('addSourceTitle')}</button>
                  <button type="button" className="mini-action" onClick={()=>void showSourceCatalog()}><Compass size={15}/>{t('sourceDiscoveryTitle')}</button>
                </div>
              </>
            ) : visibleArticles.length === 0 ? (
              <>
                <h2>{t('readerScopeEmpty')}</h2>
                <p>{t('readerScopeEmptyDesc')}</p>
              </>
            ) : (
              <>
                <h2>{t('readerEmpty')}</h2>
                <p>{t('readerEmptyDesc')}</p>
                <div className="reader-shortcuts" aria-label={t('keyboardShortcuts')}>
                  <span><kbd>← / K</kbd>{t('shortcutPreviousArticle')}</span>
                  <span><kbd>→ / J</kbd>{t('shortcutNextArticle')}</span>
                  <span><kbd>↑</kbd>{t('shortcutScrollUp')}</span>
                  <span><kbd>↓</kbd>{t('shortcutScrollDown')}</span>
                  <span><kbd>M</kbd>{t('shortcutToggleRead')}</span>
                  <span><kbd>S</kbd>{t('shortcutToggleStar')}</span>
                  <span><kbd>U</kbd>{t('shortcutOriginal')}</span>
                  <span><kbd>[</kbd>{t('shortcutSidebar')}</span>
                  <span><kbd>{'<'}</kbd>{t('shortcutSummaryPlacementPrevious')}</span>
                  <span><kbd>{'>'}</kbd>{t('shortcutSummaryPlacementNext')}</span>
                  <span><kbd>-</kbd>{t('shortcutSummarySizeDecrease')}</span>
                  <span><kbd>+</kbd>{t('shortcutSummarySizeIncrease')}</span>
                </div>
                <small>{t('shortcutSearchHint')}</small>
              </>
            )}
          </div>
        )}
        </div>
      </section>

      {addSourceOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeAddSource}>
          <section
            className="source-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-source-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <div>
                <h2 id="add-source-title">{t('addSourceTitle')}</h2>
                <p>{sourceDiscovery ? t('chooseSourceDescription') : t('addSourceDescription')}</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                aria-label={t('cancel')}
                disabled={isAddingSource}
                onClick={closeAddSource}
              >
                <X size={17} />
              </button>
            </header>
            <label className="dialog-field">
              <span>{t('sourceUrl')}</span>
              <input
                autoFocus
                value={sourceUrl}
                placeholder={t('sourceUrlPlaceholder')}
                disabled={isAddingSource || sourceDiscovery !== null}
                onChange={(event) => {
                  setSourceUrl(event.target.value)
                  setSourceDiscovery(null)
                  setSelectedCandidateId(null)
                  setSelectedCandidateIds([])
                  setSourceError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitSource()
                  if (event.key === 'Escape') closeAddSource()
                }}
              />
            </label>
            {isAddingSource && !sourceDiscovery && sourceDiscoveryRequestId && (
              <div className="source-discovery-progress" role="status" aria-live="polite">
                <div className="source-discovery-progress-head">
                  <div>
                    <strong>{t('sourceDiscoveryWorking')}</strong>
                    <span>{t('sourceDiscoveryElapsed', { count: sourceDiscoveryElapsedSeconds })}</span>
                  </div>
                  <RefreshCw size={16} className="spinning" aria-hidden="true" />
                </div>
                <div className="source-discovery-progress-bar" aria-hidden="true"><span /></div>
                <div className="source-discovery-stage-list">
                  {sourceDiscoveryStageOrder
                    .filter((stage) => ['rss', 'rsshub', 'json', 'website'].includes(stage) || sourceDiscoveryStages[stage] !== undefined)
                    .map((stage) => {
                      const state = sourceDiscoveryStages[stage] ?? 'running'
                      return (
                        <div key={stage} className={`source-discovery-stage ${state}`}>
                          <span className="source-discovery-stage-dot" aria-hidden="true" />
                          <span>{t(`sourceDiscoveryStage.${stage}`)}</span>
                          <small>{t(`sourceDiscoveryStageState.${state}`)}</small>
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
            {sourceDiscovery && sourceDiscovery.rssHubRoutes.length > 0 && (
              <div className="source-candidate-section rsshub-route-section">
                <div className="source-candidate-heading">
                  <span>{t('rssHubRoutes')}</span>
                  <span>{t('rssHubMatchedCount', { count: sourceDiscovery.rssHubRoutes.length })}</span>
                </div>
                {sourceDiscovery.rssHubRoutes.filter((route) => route.candidateId).length > 1 && (
                  <p className="source-candidate-hint">{t('rssHubMultiSelectHint')}</p>
                )}
                <div className="source-candidate-list" aria-label={t('rssHubRoutes')}>
                  {sourceDiscovery.rssHubRoutes.map((route) => {
                    const candidate = route.candidateId
                      ? sourceDiscovery.candidates.find((item) => item.id === route.candidateId && item.kind === 'RSSHUB')
                      : undefined
                    const selected = candidate ? selectedCandidateIds.includes(candidate.id) : false
                    const content = (
                      <>
                        <span className={`candidate-radio multi ${candidate ? '' : 'unavailable'}`} aria-hidden="true"><span /></span>
                        <span className="candidate-main">
                          <strong>{route.name}</strong>
                          <span className="candidate-notice">
                            {t(`rssHubRouteState.${route.state}`, { count: route.articleCount })}
                          </span>
                        </span>
                        <span className="candidate-stats">
                          <span className="candidate-kind kind-rsshub">RSSHub</span>
                        </span>
                      </>
                    )
                    if (!candidate) {
                      return (
                        <div key={`${route.routeId}:${route.feedUrl ?? route.state}`} className="source-candidate rsshub-route-status unavailable">
                          {content}
                        </div>
                      )
                    }
                    const chooseCandidate = (): void => {
                      const selectedCandidates = sourceDiscovery.candidates.filter((item) => selectedCandidateIds.includes(item.id))
                      const currentRssHubOnly = selectedCandidates.length > 0 && selectedCandidates.every((item) => item.kind === 'RSSHUB')
                      const base = currentRssHubOnly ? selectedCandidateIds : []
                      const next = base.includes(candidate.id)
                        ? (base.length > 1 ? base.filter((id) => id !== candidate.id) : base)
                        : [...base, candidate.id]
                      setSelectedCandidateIds(next)
                      setSelectedCandidateId(next.includes(candidate.id) ? candidate.id : (next[0] ?? null))
                    }
                    return (
                      <button
                        key={`${route.routeId}:${route.feedUrl ?? route.state}`}
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        className={`source-candidate rsshub-route-status ${selected ? 'selected' : ''}`}
                        onClick={chooseCandidate}
                      >
                        {content}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {sourceDiscovery && sourceDiscovery.candidates.some((candidate) => candidate.kind !== 'RSSHUB') && (
              <div className="source-candidate-section">
                <div className="source-candidate-heading">
                  <span>{t('sourceCandidates')}</span>
                  <span>{t('sourceCandidateCount', { count: sourceDiscovery.candidates.filter((candidate) => candidate.kind !== 'RSSHUB').length })}</span>
                </div>
                <div className="source-candidate-list" aria-label={t('sourceCandidates')}>
                  {sourceDiscovery.candidates.filter((candidate) => candidate.kind !== 'RSSHUB').map((candidate) => {
                    const selected = selectedCandidateIds.includes(candidate.id)
                    const chooseCandidate = (): void => {
                      setSelectedCandidateId(candidate.id)
                      setSelectedCandidateIds([candidate.id])
                    }
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`source-candidate ${selected ? 'selected' : ''}`}
                        onClick={chooseCandidate}
                      >
                        <span className="candidate-radio" aria-hidden="true"><span /></span>
                        <span className="candidate-main">
                          <strong>{candidate.title}</strong>
                          {candidate.sourceNotice && <span className="candidate-notice">{candidate.sourceNotice}</span>}
                          {candidate.kind === 'WEBSITE_DYNAMIC' && !candidate.diagnostics.accepted && (
                            <span className="candidate-notice warning">{t('dynamicWebsiteLowConfidenceNotice')}</span>
                          )}
                        </span>
                        <span className="candidate-stats">
                          <span className={`candidate-kind kind-${candidate.kind.toLowerCase()}`}>{t(`sourceKind.${candidate.kind}`)}</span>
                          <span>{t('candidateArticles', { count: candidate.diagnostics.articleCount })}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {sourceError && <div className="dialog-error">{sourceError}</div>}
            <footer className="dialog-footer">
              {sourceDiscovery && (
                <button
                  type="button"
                  className="dialog-cancel dialog-back"
                  disabled={isAddingSource}
                  onClick={() => {
                    setSourceDiscovery(null)
                    setSelectedCandidateId(null)
                    setSelectedCandidateIds([])
                    setSourceError(null)
                  }}
                >
                  {t('back')}
                </button>
              )}
              <span className="dialog-footer-spacer" />
              <button type="button" className="dialog-cancel" disabled={isAddingSource} onClick={closeAddSource}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className="dialog-submit"
                disabled={isAddingSource || !sourceUrl.trim() || (sourceDiscovery !== null && selectedCandidateIds.length === 0 && !selectedCandidateId && !sourceDiscovery.selectedCandidateId)}
                onClick={() => void submitSource()}
              >
                {isAddingSource && <RefreshCw size={14} className="spinning" />}
                {isAddingSource
                  ? (sourceDiscovery ? t('adding') : t('detecting'))
                  : (sourceDiscovery ? t('addSelectedSource') : t('detectSource'))}
              </button>
            </footer>
          </section>
        </div>
      )}
      {opmlExportOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={()=>{if(!opmlBusy)setOpmlExportOpen(false)}}>
          <section className="source-dialog opml-export-dialog" role="dialog" aria-modal="true" aria-labelledby="opml-export-title" onMouseDown={(event)=>event.stopPropagation()}>
            <header className="dialog-header">
              <div>
                <h2 id="opml-export-title">{t('exportOpml')}</h2>
                <p>{t('opmlExportDescription')}</p>
              </div>
              <button type="button" className="dialog-close" aria-label={t('cancel')} disabled={opmlBusy} onClick={()=>setOpmlExportOpen(false)}><X size={18}/></button>
            </header>
            <div className="opml-export-options">
              <label><input type="radio" name="opml-info" checked={opmlAttachInfo} onChange={()=>setOpmlAttachInfo(true)}/><span><strong>{t('opmlIncludeInfo')}</strong><small>{t('opmlIncludeInfoDescription')}</small></span></label>
              <label><input type="radio" name="opml-info" checked={!opmlAttachInfo} onChange={()=>setOpmlAttachInfo(false)}/><span><strong>{t('opmlExcludeInfo')}</strong><small>{t('opmlExcludeInfoDescription')}</small></span></label>
            </div>
            <footer className="dialog-footer">
              <span className="dialog-footer-spacer"/>
              <button type="button" className="dialog-cancel" disabled={opmlBusy} onClick={()=>setOpmlExportOpen(false)}>{t('cancel')}</button>
              <button type="button" className="dialog-submit" disabled={opmlBusy} onClick={()=>void exportOpml()}>{opmlBusy&&<RefreshCw size={14} className="spinning"/>}{t('exportOpml')}</button>
            </footer>
          </section>
        </div>
      )}
      {contextMenu && (() => {
        const menuStyle: CSSProperties = {
          left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 238)),
          top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 360))
        }
        if (contextMenu.kind === 'feed') {
          const feed = feeds.find((item) => item.id === contextMenu.feedId)
          if (!feed) return null
          return (
            <div className="desktop-context-menu" style={menuStyle} role="menu" onPointerDown={(event)=>event.stopPropagation()}>
              <button type="button" role="menuitem" disabled={refreshingFeedId !== null || isRefreshingAll} onClick={()=>{setContextMenu(null);void refreshFeed(feed)}}><RefreshCw size={14}/><span>{t('reloadSourceArticles')}</span></button>
              <button type="button" role="menuitem" onClick={()=>{setContextMenu(null);setSourceSettingsFeed(feed)}}><SlidersHorizontal size={14}/><span>{t('sourceSettings')}</span></button>
              <div className="context-menu-separator" />
              <div className="context-menu-label">{t('moveToGroup')}</div>
              <div className="context-menu-groups">
                {groups.map((group)=><button key={group.id} type="button" role="menuitemradio" aria-checked={feed.groupId===group.id} className={feed.groupId===group.id?'current':''} onClick={()=>void moveFeedFromMenu(feed,group.id)}><span>{group.name}</span>{feed.groupId===group.id&&<span className="context-menu-check">✓</span>}</button>)}
              </div>
              <div className="context-menu-separator" />
              <button type="button" className="danger" role="menuitem" onClick={()=>void deleteFeedFromMenu(feed)}><Trash2 size={14}/><span>{t('deleteSource')}</span></button>
            </div>
          )
        }
        const article = scopedArticles.find((item)=>item.id===contextMenu.articleId)
          ?? articles.find((item)=>item.id===contextMenu.articleId)
        if (!article) return null
        return (
          <div className="desktop-context-menu" style={menuStyle} role="menu" onPointerDown={(event)=>event.stopPropagation()}>
            <button type="button" role="menuitem" onClick={()=>{setContextMenu(null);toggleUnread(article)}}><BookOpenText size={14}/><span>{article.isUnread?t('markRead'):t('markUnread')}</span></button>
            <button type="button" role="menuitem" onClick={()=>{setContextMenu(null);toggleStarred(article)}}><Star size={14} fill={article.isStarred?'currentColor':'none'}/><span>{article.isStarred?t('unstar'):t('starArticle')}</span></button>
          </div>
        )
      })()}
      {sourceSettingsFeed && (
        <SourceSettingsDialog
          feed={sourceSettingsFeed}
          onClose={()=>setSourceSettingsFeed(null)}
          onChanged={(updated)=>{
            if (!updated && selectedFeed?.id === sourceSettingsFeed.id) setSelectedArticleId(null)
            setSourceSettingsFeed(null)
            void Promise.all([reloadLibrary(), reloadCurrentScope()])
          }}
        />
      )}
      {startupUpdate?.status==='available'&&startupUpdate.release&&(
        <UpdateAvailableDialog result={startupUpdate} onClose={()=>setStartupUpdate(null)}/>
      )}
      {aiOptionsOpen && selectedArticle && (
        <AiSummaryOptionsDialog
          onClose={()=>setAiOptionsOpen(false)}
          onOpenSettings={()=>{setAiOptionsOpen(false);void showSettings('ai')}}
          onGenerate={(options)=>{void generateAiSummary(true,options)}}
        />
      )}
      {translationTargetOpen && selectedArticle && (
        <TranslationTargetDialog
          onClose={()=>setTranslationTargetOpen(false)}
          onOpenSettings={()=>{setTranslationTargetOpen(false);void showSettings('translation')}}
          onTranslate={async(target,setDefault)=>{
            if(setDefault) await window.origread.updateTranslationSettings({defaultTarget:target})
            await translateSelectedArticle(true,target)
          }}
        />
      )}
    </main>
  )
}

function FeedIcon({ feed }: { feed: FeedRecord }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(()=>setFailed(false),[feed.icon])
  const icon = failed ? null : normalizeHttpUrl(feed.icon)
  return <div className="source-icon">{icon?<img src={icon} alt="" onError={()=>setFailed(true)}/>:<Rss size={16}/>}</div>
}

function AiSummaryAccentIcon({
  variant,
  loading = false
}: {
  variant: 'toolbar' | 'panel'
  loading?: boolean
}): React.JSX.Element {
  const iconSize = variant === 'toolbar' ? 15 : 15
  return (
    <span className={`ai-summary-accent-icon ai-summary-accent-icon-${variant}`} aria-hidden="true">
      {loading
        ? <RefreshCw size={iconSize} className="spinning" />
        : <Sparkles size={iconSize} />}
    </span>
  )
}

function AiSummaryPanel({
  summary,
  loading,
  progressStage,
  elapsedSeconds,
  placement,
  panelSize,
  speechActive,
  speechStatus,
  onToggleSpeech,
  onStopSpeech,
  onPlacementChange,
  onPanelSizeChange,
  onRegenerate,
  onStop,
  onClose,
  replaceMode = false
}: {
  summary: AiSummaryDocument | null
  loading: boolean
  progressStage: AiSummaryProgressStage | null
  elapsedSeconds: number
  placement: AiSummaryPlacement
  panelSize: number
  speechActive: boolean
  speechStatus: 'idle'|'speaking'|'paused'
  onToggleSpeech(): void
  onStopSpeech(): void
  onPlacementChange(placement:AiSummaryPlacement):void
  onPanelSizeChange(size:number):void
  onRegenerate():void
  onStop():void
  onClose():void
  replaceMode?:boolean
}):React.JSX.Element{
  const {t}=useTranslation()
  const [sizeEditorOpen,setSizeEditorOpen]=useState(false)
  const summaryMarkdown=summary ? stripRedundantSummaryHeading(summary.summary) : ''
  const sizeLabel=placement==='top'||placement==='bottom'?t('summaryPanelHeight'):t('summaryPanelWidth')
  return <aside className={`ai-summary-panel ${replaceMode?'replace':'docked'} placement-${placement}`}>
    <header className="ai-summary-panel-header">
      <div className="ai-summary-panel-identity"><AiSummaryAccentIcon variant="panel" loading={loading}/><div><strong>{t('aiSummary')}</strong><span>{summary ? `${summary.providerName} · ${summary.model}` : t('aiSummaryWorking')}</span></div>{summary&&<span className="ai-summary-mode-badge">{t(summaryLengthLabelKey(summary.length))}</span>}</div>
      <div className="ai-summary-panel-actions">
        <select value={placement} aria-label={t('summaryPlacement')} title={t('summaryPlacement')} onChange={(event)=>{setSizeEditorOpen(false);onPlacementChange(event.target.value as AiSummaryPlacement)}}>
          <option value="replace">{t('summaryPlacementReplace')}</option>
          <option value="left">{t('summaryPlacementLeft')}</option>
          <option value="right">{t('summaryPlacementRight')}</option>
          <option value="top">{t('summaryPlacementTop')}</option>
          <option value="bottom">{t('summaryPlacementBottom')}</option>
        </select>
        {!replaceMode&&<div className="ai-summary-size-control">
          <button type="button" className={`icon-button ${sizeEditorOpen?'active':''}`} title={t('summaryPanelSize')} aria-label={t('summaryPanelSize')} aria-expanded={sizeEditorOpen} onClick={()=>setSizeEditorOpen((open)=>!open)}><SlidersHorizontal size={15}/></button>
          {sizeEditorOpen&&<div className="ai-summary-size-popover">
            <div><span>{sizeLabel}</span><strong>{panelSize}px</strong></div>
            <input aria-label={sizeLabel} type="range" min="220" max="640" step="10" value={panelSize} onChange={(event)=>onPanelSizeChange(Number(event.target.value))}/>
          </div>}
        </div>}
        {summary?.status==='GENERATED'&&<button type="button" className={`icon-button ${speechActive?'active':''}`} title={speechActive&&speechStatus==='speaking'?t('pauseReading'):speechActive&&speechStatus==='paused'?t('resumeReading'):t('readSummary')} aria-label={t('readSummary')} onClick={onToggleSpeech}>{speechActive&&speechStatus==='speaking'?<Pause size={15}/>:speechActive&&speechStatus==='paused'?<Play size={15}/>:<Headphones size={15}/>}</button>}
        {speechActive&&speechStatus!=='idle'&&<button type="button" className="icon-button" title={t('stopReading')} aria-label={t('stopReading')} onClick={onStopSpeech}><Square size={13}/></button>}
        <button type="button" className="icon-button" title={t('close')} aria-label={t('close')} onClick={onClose}><X size={15}/></button>
      </div>
    </header>
    <div className="ai-summary-panel-body">
      {loading&&<AiSummaryProgressStatus stage={progressStage} elapsedSeconds={elapsedSeconds}/>}
      {summary ? <>
        {summary.status==='NOT_NEEDED'
          ? <div className="ai-summary-not-needed"><strong>{t('aiSummaryNotNeeded')}</strong><span>{t(summary.skipReason==='local_source_already_concise'?'aiSummaryNotNeededLocal':'aiSummaryNotNeededModel')}</span></div>
          : <SimpleMarkdown text={summaryMarkdown}/>}
        {summary.reasoning&&<details className="ai-reasoning"><summary>{t('aiReasoning')}</summary><pre>{summary.reasoning}</pre></details>}
        {loading
          ? <button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button>
          : <button className="mini-action regenerate-button" type="button" onClick={onRegenerate}><RefreshCw size={13}/>{t('regenerateWithOptions')}</button>}
      </> : <div className="ai-summary-progress-empty"><AiSummaryAccentIcon variant="panel" loading/><strong>{t(aiSummaryProgressLabelKey(progressStage))}</strong><span>{t('aiSummaryElapsed',{count:elapsedSeconds})}</span><button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button></div>}
    </div>
  </aside>
}

function AiSummaryProgressBanner({stage,elapsedSeconds,onStop}:{stage:AiSummaryProgressStage|null;elapsedSeconds:number;onStop():void}):React.JSX.Element{
  const {t}=useTranslation()
  return <div className="ai-summary-progress-banner" role="status"><AiSummaryAccentIcon variant="toolbar" loading/><div><strong>{t(aiSummaryProgressLabelKey(stage))}</strong><span>{t('aiSummaryElapsed',{count:elapsedSeconds})} · {t('aiSummaryContinueReading')}</span></div><button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button></div>
}

function AiSummaryProgressStatus({stage,elapsedSeconds}:{stage:AiSummaryProgressStage|null;elapsedSeconds:number}):React.JSX.Element{
  const {t}=useTranslation()
  return <div className="ai-summary-progress-status" role="status"><span className="ai-summary-progress-track"><span/></span><div><strong>{t(aiSummaryProgressLabelKey(stage))}</strong><span>{t('aiSummaryElapsed',{count:elapsedSeconds})}</span></div></div>
}

function aiSummaryProgressLabelKey(stage:AiSummaryProgressStage|null):string{
  if(stage==='PREPARING')return'aiSummaryPreparing'
  if(stage==='FINALIZING')return'aiSummaryFinalizing'
  return'aiSummaryRequesting'
}

function stripRedundantSummaryHeading(text:string):string{
  return text.replace(/^\s{0,3}#{1,6}\s*(?:AI\s*)?(?:摘要|summary)\s*\r?\n+/i,'').trimStart()
}

function summaryLengthLabelKey(length:AiSummaryDocument['length']):string{
  return length==='BRIEF'?'summaryModeQuick':length==='DETAILED'?'summaryModeDeep':'summaryModeBalanced'
}

function resolveReaderFontFamily(id:string,customFonts:ReaderFontEntry[]):string{
  const custom=customFonts.find((font)=>font.id===id)
  if(custom)return `"${custom.cssFamily}"`
  return BUILTIN_READER_FONTS.find((font)=>font.id===id)?.cssFamily ?? 'inherit'
}

function resolveReaderBackground(background:DesktopSettings['readerBackground'],theme:'light'|'dark',custom:string):string{
  if(background==='custom')return custom
  const palette = theme === 'dark'
    ? { theme:'#1b1d22',paper:'#1d1f24',warm:'#25221d',sepia:'#2a241b',mint:'#1d2921' }
    : { theme:'#fbfbfc',paper:'#fffefb',warm:'#fbf6eb',sepia:'#f4ecd8',mint:'#eef7ee' }
  return palette[background]
}

function resolveReaderColors(background:string):{text:string;heading:string;muted:string;softBackground:string;border:string;link:string}{
  const rgb=parseHexColor(background)
  const dark=rgb ? relativeLuminance(rgb)<0.42 : false
  return dark
    ? {text:'#d9dce4',heading:'#eceef4',muted:'#9ca1ad',softBackground:'rgba(255,255,255,.055)',border:'rgba(255,255,255,.14)',link:'#80b8ef'}
    : {text:'#35373e',heading:'#24262c',muted:'#858791',softBackground:'rgba(67,65,85,.045)',border:'rgba(58,60,70,.14)',link:'#584bc0'}
}

function parseHexColor(value:string):[number,number,number]|null{
  const match=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim())
  return match ? [Number.parseInt(match[1]!,16),Number.parseInt(match[2]!,16),Number.parseInt(match[3]!,16)] : null
}

function relativeLuminance([r,g,b]:[number,number,number]):number{
  const channel=(value:number):number=>{const normalized=value/255;return normalized<=0.04045?normalized/12.92:Math.pow((normalized+0.055)/1.055,2.4)}
  return 0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b)
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function translationTargetLabel(target: TranslationTarget): string {
  if (target.type === 'ai') return `AI · ${target.providerName} · ${target.model}`
  return {
    ML_KIT: '—',
    MICROSOFT: 'Microsoft Translator',
    DEEPL: 'DeepL',
    GOOGLE_CLOUD: 'Google Cloud Translation',
    DLX: 'DeepLX / DLX'
  }[target.provider]
}

/**
 * AI 摘要只支持阅读所需的 Markdown 子集，绝不把模型输出当 HTML 注入 Renderer。
 * 这样即使模型返回 script/html，也只会作为普通文本显示。
 */
function SimpleMarkdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let listItems: string[] = []

  const flushList = (): void => {
    if (listItems.length === 0) return
    blocks.push(
      <ol key={`list-${blocks.length}`}>
        {listItems.map((item, index) => <li key={index}>{renderInlineMarkdown(item)}</li>)}
      </ol>
    )
    listItems = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushList()
      continue
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (numbered?.[1]) {
      listItems.push(numbered[1])
      continue
    }
    flushList()
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length
      const content = renderInlineMarkdown(heading[2])
      if (level === 1) blocks.push(<h1 key={blocks.length}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={blocks.length}>{content}</h2>)
      else if (level === 3) blocks.push(<h3 key={blocks.length}>{content}</h3>)
      else blocks.push(<h4 key={blocks.length}>{content}</h4>)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet?.[1]) {
      blocks.push(<p className="markdown-bullet" key={blocks.length}>• {renderInlineMarkdown(bullet[1])}</p>)
      continue
    }
    blocks.push(<p key={blocks.length}>{renderInlineMarkdown(line)}</p>)
  }
  flushList()
  return <div className="ai-summary-markdown">{blocks}</div>
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > start) result.push(text.slice(start, match.index))
    result.push(<strong key={`${match.index}-${match[1]}`}>{match[1]}</strong>)
    start = match.index + match[0].length
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

function boundsForElement(element: HTMLElement): OriginalViewBounds {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

function closedOriginalState(): OriginalArticleViewState {
  return {
    open: false,
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false
  }
}

