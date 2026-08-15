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
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import { resolveDesktopLanguage } from '../../shared/locale'
import type { ArticleRecord, FeedRecord, GroupRecord, LibrarySnapshot } from '../../shared/library'
import type { AiSummaryPlacement, DesktopSettings } from '../../shared/settings'
import type { SourceDiscoveryResult } from '../../shared/source-discovery'
import type { ReaderArticleContent } from '../../shared/reader'
import type { SyncRuntimeState } from '../../shared/sync-runtime'
import type { OriginalArticleViewState, OriginalViewBounds } from '../../shared/original-view'
import { SettingsPanel } from './SettingsPanel'
import type { AiSummaryDocument } from '../../shared/ai'
import type { TranslationDocument, TranslationTarget } from '../../shared/translation'
import type { FeedCatalogEntry } from '../../shared/source-catalog'
import { SourceDiscoveryPanel } from './SourceDiscoveryPanel'
import { SourceSettingsDialog } from './SourceSettingsDialog'
import { AiSummaryOptionsDialog, TranslationTargetDialog } from './ReaderToolDialogs'
import type { AiSummaryRequestOptions } from '../../shared/ai'
import { ReaderSearchBar, SearchableHtml, nextSearchIndex } from './ReaderSearch'
import { BUILTIN_READER_FONTS, type ReaderFontEntry } from '../../shared/reader-font'
import { selectMainSpeechSource, speechTextFromHtml, speechTextFromMarkdown, useReaderSpeech } from './useReaderSpeech'

type Destination = 'all' | 'unread' | 'starred' | 'sources'
type ReaderMode = 'article' | 'ai' | 'translation'

const destinations: Array<{ id: Destination; icon: typeof Inbox; labelKey: string }> = [
  { id: 'all', icon: Inbox, labelKey: 'allArticles' },
  { id: 'unread', icon: BookOpenText, labelKey: 'unread' },
  { id: 'starred', icon: Star, labelKey: 'starred' },
  { id: 'sources', icon: Rss, labelKey: 'sources' }
]

export default function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [destination, setDestination] = useState<Destination>('all')
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [librarySnapshot, setLibrarySnapshot] = useState<LibrarySnapshot | null>(null)
  const [feeds, setFeeds] = useState<FeedRecord[]>([])
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [articles, setArticles] = useState<ArticleRecord[]>([])
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [query, setQuery] = useState('')
  const [activeFeedFilterId, setActiveFeedFilterId] = useState<string | null>(null)
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [addSourceOpen, setAddSourceOpen] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [isAddingSource, setIsAddingSource] = useState(false)
  const [sourceDiscovery, setSourceDiscovery] = useState<SourceDiscoveryResult | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null)
  const [isRefreshingAll, setIsRefreshingAll] = useState(false)
  const [readerContent, setReaderContent] = useState<ReaderArticleContent | null>(null)
  const [readerContentLoading, setReaderContentLoading] = useState(false)
  const [readerContentError, setReaderContentError] = useState<string | null>(null)
  const [readerMode, setReaderMode] = useState<ReaderMode>('article')
  const [aiSummary, setAiSummary] = useState<AiSummaryDocument | null>(null)
  const [aiSummaryVisible, setAiSummaryVisible] = useState(false)
  const [translationDocument, setTranslationDocument] = useState<TranslationDocument | null>(null)
  const [readerToolLoading, setReaderToolLoading] = useState<ReaderMode | null>(null)
  const [readerToolError, setReaderToolError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sourceCatalogOpen, setSourceCatalogOpen] = useState(false)
  const [subscriptionMenuOpen, setSubscriptionMenuOpen] = useState(false)
  const [opmlExportOpen, setOpmlExportOpen] = useState(false)
  const [opmlAttachInfo, setOpmlAttachInfo] = useState(true)
  const [opmlBusy, setOpmlBusy] = useState(false)
  const [opmlStatus, setOpmlStatus] = useState<string | null>(null)
  const [sourceSettingsFeed, setSourceSettingsFeed] = useState<FeedRecord | null>(null)
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
  const readerSearchInputRef = useRef<HTMLInputElement>(null)
  const lastObservedSyncFinish = useRef<number | null>(null)
  const speech = useReaderSpeech(settings?.ttsVoiceURI ?? '')

  const reloadLibrary = useCallback(async (): Promise<void> => {
    const [snapshot, loadedFeeds, loadedGroups, loadedArticles] = await Promise.all([
      window.origread.getLibrarySnapshot(),
      window.origread.listFeeds(),
      window.origread.listGroups(),
      window.origread.listArticles()
    ])
    setLibrarySnapshot(snapshot)
    setFeeds(loadedFeeds)
    setGroups(loadedGroups)
    setArticles(loadedArticles)
  }, [])

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
    const unsubscribeSync = window.origread.onSyncRuntimeStateChanged((state) => {
      setSyncRuntimeState(state)
      if (state.lastFinishedAt && state.lastFinishedAt !== lastObservedSyncFinish.current) {
        lastObservedSyncFinish.current = state.lastFinishedAt
        void reloadLibrary()
      }
    })
    const unsubscribeOriginal = window.origread.onOriginalArticleStateChanged(setOriginalViewState)
    return () => {
      unsubscribeSync()
      unsubscribeOriginal()
    }
  }, [reloadLibrary])

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
    setTranslationDocument(null)
    setReaderToolError(null)
    setReaderContentLoading(true)
    void window.origread.getReaderContent(selectedArticleId)
      .then(async (content) => {
        if (cancelled) return
        const article = articles.find((item) => item.id === selectedArticleId)
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
  }, [articles, feeds, selectedArticleId, t])

  useEffect(() => {
    setReaderSearchOpen(false)
    setReaderSearchQuery('')
    setReaderSearchCount(0)
    setReaderSearchIndex(0)
  }, [selectedArticleId])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && selectedArticleId && !settingsOpen && !sourceCatalogOpen && !originalViewState.open) {
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
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [originalViewState.open, readerMode, readerSearchOpen, selectedArticleId, settingsOpen, sourceCatalogOpen])

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
  const visibleArticles = useMemo(() => {
    return articles.filter((article) => {
      if (destination === 'unread' && !article.isUnread) return false
      if (destination === 'starred' && !article.isStarred) return false
      if (destination === 'sources') return false
      if (activeFeedFilterId && article.feedId !== activeFeedFilterId) return false
      if (!normalizedQuery) return true
      return `${article.title} ${article.author ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [activeFeedFilterId, articles, destination, normalizedQuery])
  const visibleFeeds = useMemo(() => {
    if (destination !== 'sources') return []
    if (!normalizedQuery) return feeds
    return feeds.filter((feed) => `${feed.name} ${feed.url}`.toLocaleLowerCase().includes(normalizedQuery))
  }, [destination, feeds, normalizedQuery])
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
  const selectedArticle = articles.find((article) => article.id === selectedArticleId) ?? null
  const selectedFeed = selectedArticle ? feeds.find((feed) => feed.id === selectedArticle.feedId) ?? null : null
  const activeFeedFilter = activeFeedFilterId ? feeds.find((feed) => feed.id === activeFeedFilterId) ?? null : null
  const originalUrl = normalizeHttpUrl(selectedArticle?.url)

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

  const summarySpeechText = useMemo(() => aiSummary ? speechTextFromMarkdown(stripRedundantSummaryHeading(aiSummary.summary)) : '', [aiSummary])

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
  const aiSummaryDocked = Boolean(aiSummary && aiSummaryVisible && aiSummaryPlacement !== 'replace')

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

  const toggleWorkspace = (): void => {
    const next = !workspaceCollapsed
    setWorkspaceCollapsed(next)
    setSettings((current) => current ? { ...current, workspaceCollapsed: next } : current)
  }

  const generateAiSummary = async (forceRefresh = false, options?: AiSummaryRequestOptions): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    if (originalViewState.open) await closeOriginalArticle()
    setSettingsOpen(false)
    setReaderToolLoading('ai')
    setReaderToolError(null)
    try {
      const result = await window.origread.summarizeArticle(selectedArticleId, forceRefresh, options)
      setAiSummary(result)
      setAiSummaryVisible(true)
      setReaderMode((settings?.aiSummaryPlacement ?? 'replace') === 'replace' ? 'ai' : 'article')
    } catch (error) {
      setReaderToolError(error instanceof Error ? error.message : String(error))
    } finally {
      setReaderToolLoading(null)
    }
  }

  const translateSelectedArticle = async (forceRefresh = false, target?: TranslationTarget): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    if (originalViewState.open) await closeOriginalArticle()
    setSettingsOpen(false)
    setReaderToolLoading('translation')
    setReaderToolError(null)
    try {
      const result = await window.origread.translateArticle(selectedArticleId, target, forceRefresh)
      setTranslationDocument(result)
      setReaderMode('translation')
    } catch (error) {
      setReaderToolError(error instanceof Error ? error.message : String(error))
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

  const showSettings = async (): Promise<void> => {
    if (originalViewState.open) await closeOriginalArticle()
    setSourceCatalogOpen(false)
    setSettingsOpen(true)
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
    setLibrarySnapshot((current) => current ? {
      ...current,
      starred: Math.max(0, current.starred + (next ? 1 : -1))
    } : current)
    void window.origread.setArticleStarred(article.id, next)
  }

  const toggleUnread = (article: ArticleRecord): void => {
    const next = !article.isUnread
    setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isUnread: next } : item))
    setLibrarySnapshot((current) => current ? {
      ...current,
      unread: Math.max(0, current.unread + (next ? 1 : -1))
    } : current)
    void window.origread.setArticleUnread(article.id, next)
  }

  const nextArticle = selectedArticle
    ? visibleArticles[visibleArticles.findIndex((item) => item.id === selectedArticle.id) + 1] ?? null
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

  const openAddSource = (): void => {
    setSubscriptionMenuOpen(false)
    setSourceCatalogOpen(false)
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
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

  const subscribeCatalogFeed = async (feed: FeedCatalogEntry): Promise<void> => {
    setSourceCatalogOpen(false)
    setSettingsOpen(false)
    setSourceUrl(feed.feedUrl)
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
    setAddSourceOpen(true)
    setIsAddingSource(true)
    try {
      const discovered = await window.origread.discoverSource(feed.feedUrl)
      setSourceDiscovery(discovered)
      setSelectedCandidateId(discovered.selectedCandidateId)
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
  }

  const submitSource = async (): Promise<void> => {
    if (!sourceUrl.trim() || isAddingSource) return
    setIsAddingSource(true)
    setSourceError(null)
    try {
      if (!sourceDiscovery) {
        const discovered = await window.origread.discoverSource(sourceUrl)
        setSourceDiscovery(discovered)
        setSelectedCandidateId(discovered.selectedCandidateId)
        if (discovered.candidates.length === 0) {
          setSourceError(discovered.error ?? t('noSourceCandidate'))
        }
        return
      }
      const candidateId = selectedCandidateId ?? sourceDiscovery.selectedCandidateId
      if (!candidateId) {
        setSourceError(t('selectSourceCandidate'))
        return
      }
      await window.origread.subscribeSource(sourceDiscovery.discoveryId, candidateId)
      await reloadLibrary()
      setSourceUrl('')
      setSourceDiscovery(null)
      setSelectedCandidateId(null)
      setAddSourceOpen(false)
      setDestination('all')
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsAddingSource(false)
    }
  }

  const refreshFeed = async (feed: FeedRecord): Promise<void> => {
    if (refreshingFeedId || isRefreshingAll) return
    setRefreshingFeedId(feed.id)
    setSourceError(null)
    try {
      await window.origread.refreshSource(feed.id)
      await reloadLibrary()
    } catch (error) {
      setSourceError(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRefreshingFeedId(null)
    }
  }

  const refreshAllSources = async (): Promise<void> => {
    if (isRefreshingAll || refreshingFeedId || feeds.length === 0) return
    setIsRefreshingAll(true)
    setSourceError(null)
    try {
      const result = await window.origread.refreshAllSources()
      await reloadLibrary()
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

  const readerStyle = {
    '--reader-font-size': `${settings?.readerFontSize ?? 17}px`,
    '--reader-line-height': String(settings?.readerLineHeight ?? 1.85),
    '--reader-content-width': `${settings?.readerContentWidth ?? 760}px`,
    '--reader-font-family': resolveReaderFontFamily(settings?.readerFontId ?? 'system', readerFonts),
    '--ai-summary-panel-size': `${settings?.aiSummaryPanelSize ?? 360}px`
  } as CSSProperties

  const renderAiSummaryPanel = (replaceMode = false): React.JSX.Element | null => aiSummary ? (
    <AiSummaryPanel
      summary={aiSummary}
      placement={aiSummaryPlacement}
      panelSize={settings?.aiSummaryPanelSize ?? 360}
      speechActive={speech.state.domain==='summary'}
      speechStatus={speech.state.status}
      onToggleSpeech={toggleSummarySpeech}
      onStopSpeech={speech.stop}
      onPlacementChange={(placement)=>void changeAiSummaryPlacement(placement)}
      onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
      onRegenerate={()=>setAiOptionsOpen(true)}
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
                <button className="primary-action" type="button" onClick={()=>setSubscriptionMenuOpen((open)=>!open)} disabled={opmlBusy} aria-expanded={subscriptionMenuOpen}>
                  <Plus size={16} strokeWidth={2.2} />
                  {t('addSubscription')}
                  <ChevronDown size={14}/>
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
                  setActiveFeedFilterId(null)
                  setSelectedArticleId(null)
                  setQuery('')
                  setDestination(id)
                }}
              >
                <Icon size={16} />
                <span>{t(labelKey)}</span>
                {id === 'unread' && <span className="count-badge">{librarySnapshot?.unread ?? 0}</span>}
                {id === 'sources' && <span className="count-badge">{librarySnapshot?.feeds ?? 0}</span>}
              </button>
            ))}
          </nav>

          <div className="list-toolbar">
            <div className="search-field">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={destination === 'sources' ? t('searchSources') : t('searchArticles')}
                placeholder={destination === 'sources' ? t('searchSources') : t('searchArticles')}
              />
              <kbd>Ctrl K</kbd>
            </div>
            <div className="list-meta">
              <span>
                {destination === 'sources'
                  ? t('sourceCount', { count: visibleFeeds.length })
                  : t('articleCount', { count: visibleArticles.length })}
              </span>
              <button
                type="button"
                className="icon-button refresh-all-button"
                aria-label={t('refreshAll')}
                title={t('refreshAll')}
                disabled={feeds.length === 0 || isRefreshingAll || refreshingFeedId !== null}
                onClick={() => void refreshAllSources()}
              >
                <RefreshCw size={16} className={isRefreshingAll ? 'spinning' : ''} />
              </button>
              <button type="button" className="icon-button" aria-label={t('more')}>
                <MoreHorizontal size={17} />
              </button>
            </div>
          </div>

          <div className="workspace-list-stage">
            {destination !== 'sources' && activeFeedFilter && (
              <div className="active-source-filter">
                <div className="active-source-filter-copy">
                  <FeedIcon feed={activeFeedFilter} />
                  <div><span>{t('viewingSourceArticles')}</span><strong>{activeFeedFilter.name}</strong></div>
                </div>
                <button type="button" className="icon-button" title={t('clearSourceFilter')} aria-label={t('clearSourceFilter')} onClick={()=>{setActiveFeedFilterId(null);setSelectedArticleId(null)}}><X size={15}/></button>
              </div>
            )}
            {opmlStatus && !addSourceOpen && (
              <div className="workspace-notice">{opmlStatus}</div>
            )}
            {sourceError && !addSourceOpen && (
              <div className="workspace-error">{sourceError}</div>
            )}

            {destination === 'sources' && visibleFeeds.length > 0 ? (
              <div className="list-content source-list">
                {groupedVisibleFeeds.map(({group,feeds:groupFeeds})=><section className="source-group-section" key={group.id}>
                  <header className="source-group-header"><strong>{group.name}</strong><span>{t('sourceCount',{count:groupFeeds.length})}</span></header>
                  <div className="source-group-items">{groupFeeds.map((feed) => (
                    <article className="source-item" key={feed.id} tabIndex={0} role="button" onClick={()=>{setActiveFeedFilterId(feed.id);setDestination('all');setSelectedArticleId(null);setQuery('')}} onKeyDown={(event)=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();setActiveFeedFilterId(feed.id);setDestination('all');setSelectedArticleId(null);setQuery('')}}}>
                      <FeedIcon feed={feed} />
                      <div className="source-copy">
                        <strong>{feed.name}</strong>
                        <span>{feed.url}</span>
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
            ) : destination !== 'sources' && visibleArticles.length > 0 ? (
              <div className="list-content article-list">
                {visibleArticles.map((article) => (
                  <article
                    className={`article-item ${selectedArticleId === article.id ? 'selected' : ''}`}
                    key={article.id}
                    data-article-id={article.id}
                    data-feed-id={article.feedId}
                    onClick={() => selectArticle(article)}
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
                    <p>{article.description || t('noSummary')}</p>
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
              onChange={(patch) => void updateDesktopSettings(patch)}
              onConfigurationRestored={() => void handleConfigurationRestored()}
            />
          </>
        ) : sourceCatalogOpen ? (
          <SourceDiscoveryPanel onSubscribe={(feed)=>void subscribeCatalogFeed(feed)}/>
        ) : selectedArticle ? (
          <div className={`reader-composite ${aiSummaryDocked ? `summary-docked summary-${aiSummaryPlacement}` : ''}`}>
          {aiSummaryDocked && (aiSummaryPlacement==='left'||aiSummaryPlacement==='top') && renderAiSummaryPanel()}
          <div className={`reader-content reader-mode-${readerMode}`}>
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
              <div>{selectedArticle.author ?? ''}</div>
            </div>
            {readerToolError && <div className="reader-tool-error">{readerToolError}</div>}
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
              <div className="article-body-status">{selectedArticle.description || t('noSummary')}</div>
            )}
          </div>
          {aiSummaryDocked && (aiSummaryPlacement==='right'||aiSummaryPlacement==='bottom') && renderAiSummaryPanel()}
          </div>
        ) : (
          <div className="reader-empty-state">
            <div className="reader-card">
              <div className="reader-card-icon"><BookOpenText size={26} /></div>
              <h2>{t('readerEmpty')}</h2>
              <p>{t('readerEmptyDesc')}</p>
              <div className="capability-row">
                <span>{t('original')}</span>
                <span>{t('aiSummary')}</span>
                <span>{t('translation')}</span>
              </div>
            </div>

            <div className="phase-card">
              <span className="phase-badge">{t('developmentBadge')}</span>
              <p>{t('developmentHint')}</p>
              {appInfo && (
                <small>
                  v{appInfo.version} · {appInfo.platform} · DB {librarySnapshot ? 'ready' : 'loading'} · settings {settings ? 'ready' : 'loading'}
                </small>
              )}
            </div>
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
                  setSourceError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitSource()
                  if (event.key === 'Escape') closeAddSource()
                }}
              />
            </label>
            {sourceDiscovery && sourceDiscovery.candidates.length > 0 && (
              <div className="source-candidate-section">
                <div className="source-candidate-heading">
                  <span>{t('sourceCandidates')}</span>
                  <span>{t('sourceCandidateCount', { count: sourceDiscovery.candidates.length })}</span>
                </div>
                <div className="source-candidate-list" role="radiogroup" aria-label={t('sourceCandidates')}>
                  {sourceDiscovery.candidates.map((candidate) => {
                    const selected = (selectedCandidateId ?? sourceDiscovery.selectedCandidateId) === candidate.id
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`source-candidate ${selected ? 'selected' : ''}`}
                        onClick={() => setSelectedCandidateId(candidate.id)}
                      >
                        <span className="candidate-radio" aria-hidden="true"><span /></span>
                        <span className="candidate-main">
                          <strong>{candidate.title}</strong>
                          <span className="candidate-url">{candidate.feedLink}</span>
                          {candidate.sourceNotice && <span className="candidate-notice">{candidate.sourceNotice}</span>}
                        </span>
                        <span className="candidate-stats">
                          <span className={`candidate-kind kind-${candidate.kind.toLowerCase()}`}>{t(`sourceKind.${candidate.kind}`)}</span>
                          <span>{t('candidateScore', { score: candidate.diagnostics.score })}</span>
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
                disabled={isAddingSource || !sourceUrl.trim() || (sourceDiscovery !== null && !selectedCandidateId && !sourceDiscovery.selectedCandidateId)}
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
      {sourceSettingsFeed && (
        <SourceSettingsDialog
          feed={sourceSettingsFeed}
          onClose={()=>setSourceSettingsFeed(null)}
          onChanged={(updated)=>{
            if (!updated && selectedFeed?.id === sourceSettingsFeed.id) setSelectedArticleId(null)
            setSourceSettingsFeed(null)
            void reloadLibrary()
          }}
        />
      )}
      {aiOptionsOpen && selectedArticle && (
        <AiSummaryOptionsDialog
          onClose={()=>setAiOptionsOpen(false)}
          onGenerate={async(options)=>{await generateAiSummary(true,options)}}
        />
      )}
      {translationTargetOpen && selectedArticle && (
        <TranslationTargetDialog
          onClose={()=>setTranslationTargetOpen(false)}
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
  placement,
  panelSize,
  speechActive,
  speechStatus,
  onToggleSpeech,
  onStopSpeech,
  onPlacementChange,
  onPanelSizeChange,
  onRegenerate,
  onClose,
  replaceMode = false
}: {
  summary: AiSummaryDocument
  placement: AiSummaryPlacement
  panelSize: number
  speechActive: boolean
  speechStatus: 'idle'|'speaking'|'paused'
  onToggleSpeech(): void
  onStopSpeech(): void
  onPlacementChange(placement:AiSummaryPlacement):void
  onPanelSizeChange(size:number):void
  onRegenerate():void
  onClose():void
  replaceMode?:boolean
}):React.JSX.Element{
  const {t}=useTranslation()
  const [sizeEditorOpen,setSizeEditorOpen]=useState(false)
  const summaryMarkdown=stripRedundantSummaryHeading(summary.summary)
  const sizeLabel=placement==='top'||placement==='bottom'?t('summaryPanelHeight'):t('summaryPanelWidth')
  return <aside className={`ai-summary-panel ${replaceMode?'replace':'docked'} placement-${placement}`}>
    <header className="ai-summary-panel-header">
      <div className="ai-summary-panel-identity"><AiSummaryAccentIcon variant="panel"/><div><strong>{t('aiSummary')}</strong><span>{summary.providerName} · {summary.model}</span></div><span className="ai-summary-mode-badge">{t(summaryLengthLabelKey(summary.length))}</span></div>
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
        <button type="button" className={`icon-button ${speechActive?'active':''}`} title={speechActive&&speechStatus==='speaking'?t('pauseReading'):speechActive&&speechStatus==='paused'?t('resumeReading'):t('readSummary')} aria-label={t('readSummary')} onClick={onToggleSpeech}>{speechActive&&speechStatus==='speaking'?<Pause size={15}/>:speechActive&&speechStatus==='paused'?<Play size={15}/>:<Headphones size={15}/>}</button>
        {speechActive&&speechStatus!=='idle'&&<button type="button" className="icon-button" title={t('stopReading')} aria-label={t('stopReading')} onClick={onStopSpeech}><Square size={13}/></button>}
        <button type="button" className="icon-button" title={t('close')} aria-label={t('close')} onClick={onClose}><X size={15}/></button>
      </div>
    </header>
    <div className="ai-summary-panel-body">
      <SimpleMarkdown text={summaryMarkdown}/>
      {summary.reasoning&&<details className="ai-reasoning"><summary>{t('aiReasoning')}</summary><pre>{summary.reasoning}</pre></details>}
      <button className="mini-action regenerate-button" type="button" onClick={onRegenerate}><RefreshCw size={13}/>{t('regenerateWithOptions')}</button>
    </div>
  </aside>
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

