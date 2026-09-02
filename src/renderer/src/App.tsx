import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  Plus,
  Sparkles,
  Star,
  Languages,
  StepForward,
  ExternalLink,
  Headphones,
  History,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Share2,
  Settings,
  SquareArrowOutUpRight,
  SlidersHorizontal,
  Square,
  Trash2,
  Volume2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import { resolveDesktopLanguage } from '../../shared/locale'
import type { ArticleRecord, ArticleSearchResult, FeedArticleStats, FeedRecord, GroupRecord, LibrarySnapshot } from '../../shared/library'
import {
  ARTICLE_PANE_WIDTH_MAX,
  ARTICLE_PANE_WIDTH_MIN,
  SOURCE_PANE_WIDTH_MAX,
  SOURCE_PANE_WIDTH_MIN,
  WORKSPACE_PANE_WIDTH_MAX,
  WORKSPACE_PANE_WIDTH_MIN,
  type AiSummaryPlacement,
  type DesktopSettings
} from '../../shared/settings'
import type { SourceDiscoveryProgress, SourceDiscoveryResult, SourceDiscoveryStage } from '../../shared/source-discovery'
import type { ReaderArticleContent } from '../../shared/reader'
import type { SyncRuntimeState } from '../../shared/sync-runtime'
import type { OriginalArticleViewState, OriginalViewBounds } from '../../shared/original-view'
import { SettingsPanel, type SettingsPage } from './SettingsPanel'
import { UpdateAvailableDialog } from './UpdateAvailableDialog'
import type { AiProviderProfile, AiSettings, AiSummaryDocument, AiSummaryLength, AiSummaryProgress, AiSummaryProgressStage, AiSummaryStreamUpdate } from '../../shared/ai'
import type {
  LlmCitationRefRecord,
  LlmContextRefRecord,
  LlmConversationArticleRecord,
  LlmConversationRecord,
  LlmEvidenceBlockRecord,
  LlmMessageRecord
} from '../../shared/llm-chat'
import type {
  LlmAssistantEvidenceSnapshot,
  LlmArticleContextCandidate,
  LlmExecutionEvent,
  LlmExecutionIdentity,
  LlmManualToolContextView,
  LlmManualToolView,
  LlmReaderContextSnapshot,
  LlmToolActivityView,
  LlmToolApprovalDecision
} from '../../shared/llm-ipc'
import { resolveQuickMessageTemplate, type LlmQuickMessage } from '../../shared/llm-quick-message'
import type { TranslationDocument, TranslationTarget } from '../../shared/translation'
import type { FeedCatalogEntry } from '../../shared/source-catalog'
import { SourceDiscoveryPanel } from './SourceDiscoveryPanel'
import { SourceSettingsDialog } from './SourceSettingsDialog'
import { AiSummaryOptionsDialog, TranslationTargetDialog } from './ReaderToolDialogs'
import type { AiSummaryRequestOptions } from '../../shared/ai'
import { ReaderSearchBar, SearchableHtml, nextSearchIndex } from './ReaderSearch'
import { GlobalSearchDialog } from './GlobalSearchDialog'
import { BUILTIN_READER_FONTS, type ReaderFontEntry } from '../../shared/reader-font'
import type { UpdateCheckResult } from '../../shared/update'
import { selectMainSpeechSource, speechTextFromHtml, speechTextFromMarkdown, useReaderSpeech } from './useReaderSpeech'
import { readerToolFeedback, type ReaderToolFeedback } from './reader-tool-feedback'
import { isOrigReadDesktopReleaseFeed, toOrigReadDesktopReleaseLinks } from '../../shared/origread-release'
import { ReadingShareDialog, type ReadingShareDialogMode } from './ReadingShareDialog'
import {
  buildReadingShareMarkdown,
  DEFAULT_READING_SHARE_PREFERENCE,
  type ReadingSharePreference
} from './reading-share'
import { SourceBrandHeader, SourceSidebar, type ArticleScope, type Destination } from './SourceSidebar'
import { ArticleListPane } from './ArticleListPane'
import { PaneDivider } from './PaneDivider'
import { TwoPaneReadingLayout } from './TwoPaneReadingLayout'
import { SourceSwitcherPopover } from './SourceSwitcherPopover'
import { SourceManagerOverlay } from './SourceManagerOverlay'
import { THREE_PANE_BREAKPOINT, resolveResponsivePaneLayout } from './responsive-layout'
import { ReaderAiPanelShell } from './ReaderAiPanel'
import {
  INITIAL_READER_AI_PANEL_STATE,
  closeReaderAiPanel,
  closeReaderAiPanelDetail,
  openReaderAiPanel,
  openReaderAiPanelDetail,
  resetReaderAiPanel,
  type ReaderAiPanelState
} from './reader-ai-panel-state'
import {
  initialReaderAiChatScrollOwnership,
  pauseReaderAiChatScroll,
  resumeReaderAiChatScroll,
  updateReaderAiChatScrollOwnership
} from './reader-ai-chat-scroll'
import { displayChatAssistantContent, searchReaderAiChatMessages } from './reader-ai-chat-search'

type ReaderMode = 'article' | 'translation'
type ReaderToolLoading = 'ai' | 'translation'

type ContextMenuState =
  | { kind: 'feed'; x: number; y: number; feedId: string }
  | { kind: 'article'; x: number; y: number; articleId: string }

interface ReaderAiSelection {
  articleId: string
  text: string
  truncated: boolean
}

interface ReaderAiSelectionCandidate extends ReaderAiSelection {
  x: number
  y: number
  placement: 'above' | 'below'
}

const sourceDiscoveryStageOrder: SourceDiscoveryStage[] = ['rss', 'rsshub', 'json', 'website', 'dynamic_website', 'ranking']
const aiSummaryPlacementOrder: AiSummaryPlacement[] = ['left', 'right']
const AI_SUMMARY_PANEL_MIN = 220
const AI_SUMMARY_PANEL_MAX = 640
const AI_SUMMARY_PANEL_KEYBOARD_STEP = 20
const RECENT_SOURCE_SCOPE_LIMIT = 5
const READER_AI_SELECTION_MAX_CHARS = 20_000

export default function App(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [destination, setDestination] = useState<Destination>('all')
  const [focusReading, setFocusReading] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [adaptiveSourceOverlayOpen, setAdaptiveSourceOverlayOpen] = useState(false)
  // Source Switcher 只属于当前会话，不持久化打开状态。
  const [sourceSwitcherOpen, setSourceSwitcherOpen] = useState(false)
  // Source Manager 只承载双栏低频来源管理；与高频 Source Switcher 完全分离。
  const [sourceManagerOpen, setSourceManagerOpen] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [librarySnapshot, setLibrarySnapshot] = useState<LibrarySnapshot | null>(null)
  const [feeds, setFeeds] = useState<FeedRecord[]>([])
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [articles, setArticles] = useState<ArticleRecord[]>([])
  const [scopeArticles, setScopeArticles] = useState<ArticleRecord[] | null>(null)
  const [feedArticleStats, setFeedArticleStats] = useState<FeedArticleStats[]>([])
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  // 三栏 Source Pane / 后续 Source Manager 使用独立搜索状态，不再被双栏快速切源复用。
  const [sourceQuery, setSourceQuery] = useState('')
  // 双栏 Source Switcher 搜索完全独立，关闭 Switcher 时只清理自身查询。
  const [sourceSwitcherQuery, setSourceSwitcherQuery] = useState('')
  // Recent 只保留会话级 Group / Feed Scope，账户切换时主动清空，避免跨账户引用失效 ID。
  const [recentSourceScopeKeys, setRecentSourceScopeKeys] = useState<string[]>([])
  // 分组折叠属于会话级 UI 状态，提升到 App 后即使整个 Source Pane 临时折叠/卸载也不会丢失。
  const [collapsedSourceGroupIds, setCollapsedSourceGroupIds] = useState<Set<string>>(() => new Set())
  // 双栏 Source Switcher 使用独立折叠状态，避免快速切源操作反向改变三栏 Source Pane 的展开结构。
  const [collapsedSourceSwitcherGroupIds, setCollapsedSourceSwitcherGroupIds] = useState<Set<string>>(() => new Set())
  const [articleQuery, setArticleQuery] = useState('')
  const [articleScope, setArticleScope] = useState<ArticleScope>({ kind: 'all' })
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null)
  const [selectedArticleRecord, setSelectedArticleRecord] = useState<ArticleRecord | null>(null)
  const [addSourceOpen, setAddSourceOpen] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [articleListError, setArticleListError] = useState<string | null>(null)
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
  const [readerAiSelection, setReaderAiSelection] = useState<ReaderAiSelection | null>(null)
  const [readerAiSelectionCandidate, setReaderAiSelectionCandidate] = useState<ReaderAiSelectionCandidate | null>(null)
  const [aiSummary, setAiSummary] = useState<AiSummaryDocument | null>(null)
  const [readerAiPanel, setReaderAiPanel] = useState<ReaderAiPanelState>(INITIAL_READER_AI_PANEL_STATE)
  const [chatConversation, setChatConversation] = useState<LlmConversationRecord | null>(null)
  const [chatAttachedArticles, setChatAttachedArticles] = useState<LlmConversationArticleRecord[]>([])
  const [chatMessages, setChatMessages] = useState<LlmMessageRecord[]>([])
  const [chatToolActivity, setChatToolActivity] = useState<LlmToolActivityView[]>([])
  const [chatToolDecisionBusy, setChatToolDecisionBusy] = useState<Record<string, boolean>>({})
  const [chatManualTools, setChatManualTools] = useState<LlmManualToolView[]>([])
  const [chatManualToolContexts, setChatManualToolContexts] = useState<LlmManualToolContextView[]>([])
  const [chatManualToolBusy, setChatManualToolBusy] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false)
  const [chatConversations, setChatConversations] = useState<LlmConversationRecord[]>([])
  const [chatConversationHistoryLoading, setChatConversationHistoryLoading] = useState(false)
  const [chatConversationHistoryError, setChatConversationHistoryError] = useState<string | null>(null)
  const [chatConversationHistoryQuery, setChatConversationHistoryQuery] = useState('')
  const [chatLocateMessageId, setChatLocateMessageId] = useState<string | null>(null)
  const [readerAiSourceFocus, setReaderAiSourceFocus] = useState<{ messageId: string; citationId: string | null; locationUnavailable: boolean } | null>(null)
  const [readerAiSourceSnapshot, setReaderAiSourceSnapshot] = useState<{ messageId: string; snapshot: LlmAssistantEvidenceSnapshot } | null>(null)
  const [readerAiAnswerCitationSnapshot, setReaderAiAnswerCitationSnapshot] = useState<{ messageId: string; snapshot: LlmAssistantEvidenceSnapshot } | null>(null)
  const [readerCitationTarget, setReaderCitationTarget] = useState<{ messageId: string; citation: LlmCitationRefRecord; contextRef: LlmContextRefRecord | null } | null>(null)
  const [chatActiveExecution, setChatActiveExecution] = useState<LlmExecutionIdentity | null>(null)
  const [chatAiSettings, setChatAiSettings] = useState<AiSettings | null>(null)
  const [chatQuickMessages, setChatQuickMessages] = useState<LlmQuickMessage[]>([])
  const [chatDraftProviderId, setChatDraftProviderId] = useState('')
  const [chatDraftModel, setChatDraftModel] = useState('')
  const [chatForceWebSearchNext, setChatForceWebSearchNext] = useState(false)
  const [aiSummaryProgress, setAiSummaryProgress] = useState<AiSummaryProgress | null>(null)
  const [aiSummaryStream, setAiSummaryStream] = useState<AiSummaryStreamUpdate | null>(null)
  const [aiSummaryStartedAt, setAiSummaryStartedAt] = useState<number | null>(null)
  const [aiSummaryElapsedSeconds, setAiSummaryElapsedSeconds] = useState(0)
  const [translationDocument, setTranslationDocument] = useState<TranslationDocument | null>(null)
  const [readerToolLoading, setReaderToolLoading] = useState<ReaderToolLoading | null>(null)
  const [readerToolNotice, setReaderToolNotice] = useState<ReaderToolFeedback | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsUnsaved, setSettingsUnsaved] = useState(false)
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
  const [readingShareDialog, setReadingShareDialog] = useState<ReadingShareDialogMode | null>(null)
  const [readingShareStatus, setReadingShareStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [readerMoreOpen, setReaderMoreOpen] = useState(false)
  const [readerSearchOpen, setReaderSearchOpen] = useState(false)
  const [readerSearchQuery, setReaderSearchQuery] = useState('')
  const [readerSearchCount, setReaderSearchCount] = useState(0)
  const [readerSearchIndex, setReaderSearchIndex] = useState(0)
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [globalSearchResults, setGlobalSearchResults] = useState<ArticleSearchResult[]>([])
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false)
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null)
  const [readerFonts, setReaderFonts] = useState<ReaderFontEntry[]>([])
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [syncRuntimeState, setSyncRuntimeState] = useState<SyncRuntimeState | null>(null)

  const closeSettingsIfAllowed = (): boolean => {
    if (!settingsOpen) return true
    if (settingsUnsaved && !window.confirm(t('customInstructionsDiscardConfirm'))) return false
    setSettingsUnsaved(false)
    setSettingsOpen(false)
    return true
  }
  const [originalViewState, setOriginalViewState] = useState<OriginalArticleViewState>(closedOriginalState())
  const readerPaneRef = useRef<HTMLElement>(null)
  const readerStageRef = useRef<HTMLDivElement>(null)
  const readerContentRef = useRef<HTMLDivElement>(null)
  const readerSearchInputRef = useRef<HTMLInputElement>(null)
  const chatSearchInputRef = useRef<HTMLInputElement>(null)
  const chatComposerInputRef = useRef<HTMLTextAreaElement>(null)
  const chatActiveRequestIdRef = useRef<string | null>(null)
  const chatActiveRequestTaskRef = useRef<'CHAT' | 'ARTICLE_ANALYSIS'>('CHAT')
  const chatConversationIdRef = useRef<string | null>(null)
  const chatManualToolContextsRef = useRef<LlmManualToolContextView[]>([])
  const citationArticleNavigationRef = useRef<string | null>(null)
  const readerCitationHighlightRef = useRef<HTMLElement | null>(null)
  const readerCitationHighlightTimerRef = useRef<number | null>(null)
  const articleSearchInputRef = useRef<HTMLInputElement>(null)
  const adaptiveSourceOverlayCloseRef = useRef<HTMLButtonElement>(null)
  const sourceSwitcherTriggerRef = useRef<HTMLButtonElement>(null)
  const sourceSwitcherSearchInputRef = useRef<HTMLInputElement>(null)
  const sourceManagerCloseRef = useRef<HTMLButtonElement>(null)
  const readerMoreButtonRef = useRef<HTMLButtonElement>(null)
  const readerSecondaryActionsRef = useRef<HTMLDivElement>(null)
  const selectedArticleIdRef = useRef<string | null>(null)
  const sourceDiscoveryRequestIdRef = useRef<string | null>(null)
  const aiSummaryRunRef = useRef(0)
  const aiSummaryPerfRunRef = useRef<{ runId: number; articleId: string; startedAt: number } | null>(null)
  const aiSummaryUiTtfvRecordedRef = useRef(false)
  const translationRunRef = useRef(0)
  const translationRequestArticleRef = useRef<string | null>(null)
  const lastObservedSyncFinish = useRef<number | null>(null)
  const autoUpdateCheckedRef = useRef(false)
  const speech = useReaderSpeech(settings?.ttsVoiceURI ?? '')

  useEffect(() => {
    setReaderAiSelectionCandidate(null)
  }, [readerMode, originalViewState.open, settingsOpen])

  useEffect(() => {
    if (!readerAiSelectionCandidate) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('.reader-ai-selection-action')) return
      setReaderAiSelectionCandidate(null)
    }
    window.addEventListener('pointerdown', dismiss, true)
    return () => window.removeEventListener('pointerdown', dismiss, true)
  }, [readerAiSelectionCandidate])

  /** 关闭双栏快速来源切换器；普通关闭后把键盘焦点还给触发按钮。 */
  const closeSourceSwitcher = useCallback((restoreFocus = true): void => {
    setSourceSwitcherOpen(false)
    setSourceSwitcherQuery('')
    if (restoreFocus) {
      window.requestAnimationFrame(() => sourceSwitcherTriggerRef.current?.focus())
    }
  }, [])

  /** 双栏当前来源 Trigger 直接切换轻量 Source Switcher，不再进入整栏来源页。 */
  const toggleSourceSwitcher = useCallback((): void => {
    setSourceManagerOpen(false)
    setSourceSwitcherQuery('')
    setSourceSwitcherOpen((open) => !open)
  }, [])

  /** 关闭双栏低频 Source Manager；需要时把焦点恢复到当前来源 Trigger。 */
  const closeSourceManager = useCallback((restoreFocus = true): void => {
    setSourceManagerOpen(false)
    setSubscriptionMenuOpen(false)
    if (restoreFocus) {
      window.requestAnimationFrame(() => sourceSwitcherTriggerRef.current?.focus())
    }
  }, [])

  /** 从 Quick Switcher 进入完整来源管理视图，禁止两个浮层同时存在。 */
  const openSourceManager = useCallback((): void => {
    closeSourceSwitcher(false)
    setSubscriptionMenuOpen(false)
    setSourceManagerOpen(true)
  }, [closeSourceSwitcher])

  /**
   * 记录最近访问的 Group / Feed Scope。
   *
   * All 始终固定在切换器顶部，不进入 Recent；相同 Scope 去重并前置，最多保留 5 个。
   */
  const rememberSourceScope = useCallback((scope: ArticleScope): void => {
    if (scope.kind === 'all') return
    const key = `${scope.kind}:${scope.id}`
    setRecentSourceScopeKeys((current) => [
      key,
      ...current.filter((item) => item !== key)
    ].slice(0, RECENT_SOURCE_SCOPE_LIMIT))
  }, [])

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
      setArticleListError(null)
      return
    }
    setScopeArticles([])
    setArticleListError(null)
    void loadArticlesForScope(articleScope)
      .then((loaded) => {
        if (!cancelled) setScopeArticles(loaded)
      })
      .catch((error) => {
        if (!cancelled) setArticleListError(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [articleScope, loadArticlesForScope])

  useEffect(() => {
    void Promise.all([
      window.origread.getAppInfo(),
      window.origread.getSettings(),
      window.origread.getSyncRuntimeState(),
      window.origread.getOriginalArticleState()
    ]).then(([info, loadedSettings, loadedSyncState, loadedOriginalState]) => {
      setAppInfo(info)
      setSettings(loadedSettings)
      setSyncRuntimeState(loadedSyncState)
      setOriginalViewState(loadedOriginalState)
      lastObservedSyncFinish.current = loadedSyncState.lastFinishedAt
      const language = loadedSettings.language === 'system'
        ? resolveDesktopLanguage(info.locale)
        : loadedSettings.language
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
    const update = (): void => setViewportWidth(window.innerWidth)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    // Adaptive overlay 只属于窄窗口当前会话；重新进入宽屏或 Focus 时必须自动退场。
    if (settings?.layoutMode === 'two-pane' || viewportWidth >= THREE_PANE_BREAKPOINT || focusReading) {
      setAdaptiveSourceOverlayOpen(false)
      setSubscriptionMenuOpen(false)
    }
  }, [focusReading, settings?.layoutMode, viewportWidth])

  useEffect(() => {
    if (settings?.layoutMode === 'two-pane' || !adaptiveSourceOverlayOpen || settings?.sourcePaneCollapsed) return
    window.requestAnimationFrame(() => adaptiveSourceOverlayCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAdaptiveSourceOverlayOpen(false)
        setSubscriptionMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [adaptiveSourceOverlayOpen, settings?.layoutMode, settings?.sourcePaneCollapsed])

  useEffect(() => {
    if (!sourceSwitcherOpen) return
    // Workspace 不可见或主布局已经切走时直接退场，不把焦点强行拉回已隐藏的 Trigger。
    if (settings?.layoutMode !== 'two-pane' || settings?.workspaceCollapsed || focusReading) {
      closeSourceSwitcher(false)
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeSourceSwitcher(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeSourceSwitcher, focusReading, settings?.layoutMode, settings?.workspaceCollapsed, sourceSwitcherOpen])

  useEffect(() => {
    if (!sourceManagerOpen) return
    // Source Manager 仅存在于可见的双栏 Workspace；离开布局时直接关闭，避免残留覆盖层。
    if (settings?.layoutMode !== 'two-pane' || settings?.workspaceCollapsed || focusReading) {
      closeSourceManager(false)
      return
    }
    const focusFrame = window.requestAnimationFrame(() => sourceManagerCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeSourceManager(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [closeSourceManager, focusReading, settings?.layoutMode, settings?.workspaceCollapsed, sourceManagerOpen])

  useEffect(() => {
    if (!readerMoreOpen) return
    const focusFrame = window.requestAnimationFrame(() => {
      readerSecondaryActionsRef.current
        ?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled)')
        ?.focus()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setReaderMoreOpen(false)
      window.requestAnimationFrame(() => readerMoreButtonRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [readerMoreOpen])

  useEffect(() => {
    const readerPane = readerPaneRef.current
    if (!readerPane || typeof ResizeObserver === 'undefined') return
    // More 只属于 <650px 的 Reader 容器；Pane resize / 布局切换变宽后立即清掉临时菜单状态。
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width >= 650) setReaderMoreOpen(false)
    })
    observer.observe(readerPane)
    return () => observer.disconnect()
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
  // Reader 选择必须独立于左侧 Article Scope。当前列表暂时找不到文章时也保留 Reader 自己的文章快照。
  const selectedArticle = selectedArticleRecord?.id === selectedArticleId ? selectedArticleRecord : null
  const selectedFeed = selectedArticle ? feeds.find((feed) => feed.id === selectedArticle.feedId) ?? null : null
  const selectedArticleFeedId = selectedArticle?.feedId ?? null
  const selectedFeedRequiresFullContent = selectedFeed?.sourceType === 'website' || selectedFeed?.isFullContent === true
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  useEffect(() => {
    selectedArticleIdRef.current = selectedArticleId
  }, [selectedArticleId])

  useEffect(() => {
    if (!selectedArticleId) {
      setSelectedArticleRecord(null)
      return
    }
    // 同步/刷新能找到当前文章时更新 Reader 快照；当前 scope 找不到时绝不清空 Reader。
    const refreshed = scopeArticles?.find((article) => article.id === selectedArticleId)
      ?? articles.find((article) => article.id === selectedArticleId)
    if (refreshed) setSelectedArticleRecord(refreshed)
  }, [articles, scopeArticles, selectedArticleId])

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
    const unsubscribeAiStream = window.origread.onAiSummaryStreamUpdate((update) => {
      if (update.articleId === selectedArticleIdRef.current) setAiSummaryStream(update)
    })
    const unsubscribeLlmExecution = window.origread.onLlmExecutionEvent((event) => {
      if (event.requestId !== chatActiveRequestIdRef.current) return
      chatConversationIdRef.current = event.conversationId
      setChatActiveExecution({
        requestId: event.requestId,
        conversationId: event.conversationId,
        assistantMessageId: event.assistantMessageId
      })
      setChatMessages((current) => applyLlmExecutionEvent(current, event, chatActiveRequestTaskRef.current))
      if (event.type === 'TOOL_STATE') {
        void window.origread.getLlmToolActivity(event.conversationId)
          .then((activity) => {
            if (chatConversationIdRef.current === event.conversationId) setChatToolActivity(activity)
          })
          .catch(() => undefined)
      }
      if (event.type === 'TERMINAL' || event.type === 'ERROR') {
        chatActiveRequestIdRef.current = null
        chatActiveRequestTaskRef.current = 'CHAT'
        setChatActiveExecution(null)
        void Promise.all([window.origread.getLlmMessages(event.conversationId), window.origread.getLlmToolActivity(event.conversationId)])
          .then(([messages, activity]) => {
            if (chatConversationIdRef.current === event.conversationId) {
              setChatMessages(messages)
              setChatToolActivity(activity)
            }
          })
          .catch(() => undefined)
      }
    })
    const unsubscribeSourceDiscoveryProgress = window.origread.onSourceDiscoveryProgress((progress) => {
      if (progress.requestId !== sourceDiscoveryRequestIdRef.current) return
      setSourceDiscoveryStages((current) => ({ ...current, [progress.stage]: progress.state }))
    })
    return () => {
      unsubscribeSync()
      unsubscribeOriginal()
      unsubscribeAiProgress()
      unsubscribeAiStream()
      unsubscribeLlmExecution()
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
    const conversationId = readerAiPanel.conversationId
    if (!readerAiPanel.open || readerAiPanel.view !== 'chat' || !conversationId || !selectedArticleId) return
    if (chatConversation?.id === conversationId && chatMessages.length > 0) return
    let cancelled = false
    setChatHistoryLoading(true)
    void Promise.all([
      window.origread.listLlmConversations(selectedArticleId),
      window.origread.getLlmMessages(conversationId),
      window.origread.getLlmToolActivity(conversationId),
      window.origread.getLlmConversationArticles(conversationId)
    ]).then(([conversations, messages, activity, attachedArticles]) => {
      if (cancelled) return
      const conversation = conversations.find((item) => item.id === conversationId) ?? null
      if (!conversation) {
        setChatError(t('conversationUnavailable'))
        return
      }
      chatConversationIdRef.current = conversationId
      setChatConversation(conversation)
      setChatAttachedArticles(attachedArticles)
      setChatMessages(messages)
      setChatToolActivity(activity)
    }).catch(() => {
      if (!cancelled) setChatError(t('conversationLoadFailed'))
    }).finally(() => {
      if (!cancelled) setChatHistoryLoading(false)
    })
    return () => { cancelled = true }
  }, [chatConversation?.id, chatMessages.length, readerAiPanel.conversationId, readerAiPanel.open, readerAiPanel.view, selectedArticleId, t])

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
      // Settings 仍然属于 Reader Pane 内部页面。原文 child WebContentsView 保持打开，
      // 但 Settings 可见期间必须把 child 暂时移出可视区域，否则它会盖住 React 设置页。
      // 关闭 Settings 后 ResizeObserver / effect 会立即按新布局恢复真实 Reader stage bounds。
      const bounds: OriginalViewBounds = settingsOpen
        ? { x: 0, y: 0, width: 0, height: 0 }
        : boundsForElement(host)
      void window.origread.updateOriginalArticleBounds(bounds)
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(host)
    window.addEventListener('resize', updateBounds)
    updateBounds()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [originalViewState.open, settingsOpen])

  useEffect(() => {
    let cancelled = false
    const translatingArticleId = translationRequestArticleRef.current
    if (translatingArticleId && translatingArticleId !== selectedArticleId) {
      translationRunRef.current += 1
      translationRequestArticleRef.current = null
      void window.origread.stopTranslation(translatingArticleId).catch(() => undefined)
      setReaderToolLoading((current) => current === 'translation' ? null : current)
    }
    if (aiSummaryPerfRunRef.current && aiSummaryPerfRunRef.current.articleId !== selectedArticleId) {
      aiSummaryPerfRunRef.current = null
      aiSummaryUiTtfvRecordedRef.current = false
    }
    if (!selectedArticleId) {
      setReaderContent(null)
      setReaderContentError(null)
      setReaderContentLoading(false)
      return () => { cancelled = true }
    }

    const preserveAiForCitation = citationArticleNavigationRef.current === selectedArticleId
    if (preserveAiForCitation) citationArticleNavigationRef.current = null

    setReaderContent(null)
    setReaderContentError(null)
    setReaderMode('article')
    setReaderAiSelection(null)
    setReaderAiSelectionCandidate(null)
    if (!preserveAiForCitation) {
      setAiSummary(null)
      if (chatActiveRequestIdRef.current) {
        void window.origread.cancelLlmExecution(chatActiveRequestIdRef.current).catch(() => undefined)
      }
      const pendingManualContexts = chatManualToolContextsRef.current
      chatManualToolContextsRef.current = []
      for (const context of pendingManualContexts) {
        void window.origread.discardLlmManualToolContext(context.contextId).catch(() => undefined)
      }
      chatActiveRequestIdRef.current = null
      chatConversationIdRef.current = null
      setChatConversation(null)
      setChatAttachedArticles([])
      setChatMessages([])
      setChatManualToolContexts([])
      setChatManualToolBusy(false)
      setChatDraft('')
      setChatError(null)
      setChatHistoryLoading(false)
      setChatConversations([])
      setChatConversationHistoryLoading(false)
      setChatConversationHistoryError(null)
      setChatConversationHistoryQuery('')
      setChatLocateMessageId(null)
      setChatActiveExecution(null)
      setChatAiSettings(null)
      setChatDraftProviderId('')
      setChatDraftModel('')
      setReaderAiPanel(resetReaderAiPanel())
      setReaderAiSourceFocus(null)
    }
    setAiSummaryProgress(null)
    setAiSummaryStream(null)
    setAiSummaryStartedAt(null)
    setTranslationDocument(null)
    setReaderToolNotice(null)
    setReaderContentLoading(true)
    void window.origread.getReaderContent(selectedArticleId)
      .then(async (content) => {
        if (cancelled) return
        if (selectedFeedRequiresFullContent && content.mode !== 'full') {
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
  }, [selectedArticleFeedId, selectedArticleId, selectedFeedRequiresFullContent, t])

  useEffect(() => {
    const target = readerCitationTarget
    if (!target || readerContentLoading || readerMode !== 'article') return
    const targetArticleId = target.citation.locatorSnapshot?.articleId ?? target.contextRef?.articleId ?? null
    if (!targetArticleId || targetArticleId !== selectedArticleId || !readerContent?.html) return
    let cancelled = false
    let attempt = 0
    let timer: number | null = null
    const locate = (): void => {
      if (cancelled) return
      const articleBody = readerContentRef.current?.querySelector<HTMLElement>('.article-body:not(.translated-article-body)') ?? null
      const element = articleBody ? findReaderCitationElement(articleBody, target.citation) : null
      if (element) {
        if (readerCitationHighlightTimerRef.current !== null) window.clearTimeout(readerCitationHighlightTimerRef.current)
        readerCitationHighlightRef.current?.classList.remove('origread-citation-highlight')
        readerCitationHighlightRef.current = element
        element.classList.add('origread-citation-highlight')
        element.scrollIntoView({ block: 'center', behavior: 'smooth' })
        readerCitationHighlightTimerRef.current = window.setTimeout(() => {
          element.classList.remove('origread-citation-highlight')
          if (readerCitationHighlightRef.current === element) readerCitationHighlightRef.current = null
          readerCitationHighlightTimerRef.current = null
        }, 2_800)
        setReaderCitationTarget(null)
        return
      }
      attempt += 1
      if (attempt < 8) {
        timer = window.setTimeout(locate, 60)
        return
      }
      setReaderAiSourceFocus({ messageId: target.messageId, citationId: target.citation.id, locationUnavailable: true })
      setReaderAiPanel((current) => openReaderAiPanelDetail(current, 'sources', target.messageId))
      setReaderCitationTarget(null)
    }
    timer = window.setTimeout(locate, 0)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [readerCitationTarget, readerContent?.html, readerContentLoading, readerMode, selectedArticleId])

  useEffect(() => {
    const messageId = readerAiPanel.open && readerAiPanel.detailView === 'sources'
      ? readerAiPanel.detailTargetId
      : null
    if (!messageId) {
      setReaderAiSourceSnapshot(null)
      return
    }
    let cancelled = false
    void window.origread.getLlmAssistantEvidence(messageId)
      .then((snapshot) => {
        if (!cancelled) setReaderAiSourceSnapshot({ messageId, snapshot })
      })
      .catch(() => {
        if (!cancelled) setReaderAiSourceSnapshot(null)
      })
    return () => { cancelled = true }
  }, [readerAiPanel.open, readerAiPanel.detailTargetId, readerAiPanel.detailView])

  const latestCompletedAssistantForCitation = [...chatMessages].reverse().find((message) =>
    message.role === 'ASSISTANT'
    && message.historyActive
    && message.status === 'COMPLETE'
    && message.content.trim().length > 0
  ) ?? null

  useEffect(() => {
    const message = latestCompletedAssistantForCitation
    if (!message || !selectedArticleId) {
      setReaderAiAnswerCitationSnapshot(null)
      return
    }
    let cancelled = false
    void window.origread.getLlmAssistantEvidence(message.id)
      .then((snapshot) => {
        if (cancelled) return
        setReaderAiAnswerCitationSnapshot(snapshot.citations.length > 0 ? { messageId: message.id, snapshot } : null)
      })
      .catch(() => {
        if (!cancelled) setReaderAiAnswerCitationSnapshot(null)
      })
    return () => { cancelled = true }
  }, [latestCompletedAssistantForCitation?.id, latestCompletedAssistantForCitation?.updatedAt, selectedArticleId])

  const readerAiVisibleCitationSnapshot = readerAiSourceSnapshot ?? readerAiAnswerCitationSnapshot

  useEffect(() => {
    const root = readerContentRef.current?.querySelector<HTMLElement>('.article-body:not(.translated-article-body)') ?? null
    const clearMarkers = (): void => {
      root?.querySelectorAll<HTMLElement>('[data-origread-citation-marker="true"]').forEach((marker) => marker.remove())
    }
    clearMarkers()
    if (!root || readerMode !== 'article' || !selectedArticleId || !readerAiVisibleCitationSnapshot) return

    const frame = window.requestAnimationFrame(() => {
      clearMarkers()
      const { snapshot } = readerAiVisibleCitationSnapshot
      const articleCitations = snapshot.citations
        .filter((citation) => {
          const sourceKind = citation.locatorSnapshot?.sourceKind
          const contextRef = snapshot.contextRefs.find((ref) => ref.id === citation.contextRefId) ?? null
          const articleId = citation.locatorSnapshot?.articleId ?? contextRef?.articleId ?? null
          return (sourceKind === 'ARTICLE' || sourceKind === 'SELECTION') && articleId === selectedArticleId
        })
        .sort((left, right) => (left.displayOrder ?? Number.MAX_SAFE_INTEGER) - (right.displayOrder ?? Number.MAX_SAFE_INTEGER))

      for (const citation of articleCitations) {
        const element = findReaderCitationElement(root, citation)
        if (!element) continue
        const marker = document.createElement('button')
        const number = citation.displayOrder ?? snapshot.citations.findIndex((item) => item.id === citation.id) + 1
        marker.type = 'button'
        marker.className = 'origread-reader-citation-marker'
        marker.dataset.origreadCitationMarker = 'true'
        marker.dataset.origreadCitationId = citation.id
        marker.textContent = `[${number}]`
        marker.title = t('citationNumberLabel', { number, source: selectedArticle?.title ?? t('citationSourceArticle') })
        marker.setAttribute('aria-label', marker.title)
        element.appendChild(marker)
      }
    })

    return () => {
      window.cancelAnimationFrame(frame)
      clearMarkers()
    }
  }, [readerAiVisibleCitationSnapshot, readerContent?.html, readerMode, readerSearchIndex, readerSearchQuery, selectedArticle?.title, selectedArticleId, t])

  useEffect(() => {
    if (!readerAiPanel.open || settingsOpen) return
    let cancelled = false
    void window.origread.getAiSettings().then((loaded) => {
      if (cancelled) return
      setChatAiSettings(loaded)
      if (chatConversation) return
      const enabledProviders = loaded.providers.filter((provider) => provider.enabled)
      const selectedProvider = enabledProviders.find((provider) => provider.id === chatDraftProviderId)
        ?? enabledProviders.find((provider) => provider.id === loaded.defaultProviderId)
        ?? enabledProviders[0]
        ?? null
      if (!selectedProvider) {
        setChatDraftProviderId('')
        setChatDraftModel('')
        return
      }
      const availableModels = new Set([selectedProvider.defaultModel, ...selectedProvider.models].filter(Boolean))
      setChatDraftProviderId(selectedProvider.id)
      setChatDraftModel((current) => availableModels.has(current)
        ? current
        : selectedProvider.defaultModel || selectedProvider.models[0] || '')
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [readerAiPanel.open, chatConversation?.id, settingsOpen])

  useEffect(() => {
    if (!readerAiPanel.open) return
    let cancelled = false
    const language = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en'
    void window.origread.getLlmQuickMessages(language)
      .then((messages) => {
        if (!cancelled) setChatQuickMessages(messages.filter((message) => message.enabled))
      })
      .catch(() => {
        if (!cancelled) setChatQuickMessages([])
      })
    return () => { cancelled = true }
  }, [readerAiPanel.open, i18n.resolvedLanguage])

  useEffect(() => {
    if (!readerAiPanel.open || settingsOpen) return
    let cancelled = false
    void window.origread.listLlmManualTools()
      .then((tools) => {
        if (!cancelled) setChatManualTools(tools)
      })
      .catch(() => {
        if (!cancelled) setChatManualTools([])
      })
    return () => { cancelled = true }
  }, [readerAiPanel.open, chatConversation?.id, settingsOpen])

  useEffect(() => {
    chatManualToolContextsRef.current = chatManualToolContexts
  }, [chatManualToolContexts])

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

  const openGlobalSearch = useCallback((): void => {
    setGlobalSearchOpen(true)
    setGlobalSearchResults([])
    setGlobalSearchError(null)
  }, [])

  const closeGlobalSearch = useCallback((): void => {
    setGlobalSearchOpen(false)
    setGlobalSearchResults([])
    setGlobalSearchLoading(false)
    setGlobalSearchError(null)
  }, [])

  const normalizedArticleQuery = articleQuery.trim().toLocaleLowerCase()
  const normalizedSourceQuery = sourceQuery.trim().toLocaleLowerCase()
  const scopedArticles = articleScope.kind === 'all' ? articles : (scopeArticles ?? [])
  const visibleArticles = useMemo(() => {
    return scopedArticles.filter((article) => {
      if (destination === 'unread' && !article.isUnread) return false
      if (destination === 'starred' && !article.isStarred) return false
      if (!normalizedArticleQuery) return true
      return `${article.title} ${article.author ?? ''}`.toLocaleLowerCase().includes(normalizedArticleQuery)
    })
  }, [destination, normalizedArticleQuery, scopedArticles])
  const visibleFeeds = useMemo(() => {
    if (!normalizedSourceQuery) return feeds
    return feeds.filter((feed) => `${feed.name} ${feed.url}`.toLocaleLowerCase().includes(normalizedSourceQuery))
  }, [feeds, normalizedSourceQuery])
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
  const readingSharePreference: ReadingSharePreference = {
    configured: settings?.readingShareConfigured ?? DEFAULT_READING_SHARE_PREFERENCE.configured,
    includeTitle: settings?.readingShareIncludeTitle ?? DEFAULT_READING_SHARE_PREFERENCE.includeTitle,
    includeBody: settings?.readingShareIncludeBody ?? DEFAULT_READING_SHARE_PREFERENCE.includeBody,
    includeTranslation: settings?.readingShareIncludeTranslation ?? DEFAULT_READING_SHARE_PREFERENCE.includeTranslation,
    includeSummary: settings?.readingShareIncludeSummary ?? DEFAULT_READING_SHARE_PREFERENCE.includeSummary
  }
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

  const aiSummaryPlacement = settings?.aiSummaryPlacement ?? 'right'
  const aiLoading = readerToolLoading === 'ai'
  const aiSummaryPanelOpen = readerAiPanel.open && readerAiPanel.view === 'summary'
  const readerAiPanelDocked = Boolean(readerAiPanel.open)
  const readerAiPanelActive = readerAiPanelDocked

  const toggleReaderAiAssistant = useCallback((): void => {
    setReaderAiPanel((current) =>
      current.open
        ? closeReaderAiPanel(current)
        : openReaderAiPanel(current, current.view)
    )
  }, [])

  const showReaderAiHome = (): void => {
    setReaderAiPanel((current) => openReaderAiPanel(current, 'home'))
  }

  const showReaderAiChat = (): void => {
    setReaderAiPanel((current) => openReaderAiPanel(current, 'chat'))
    window.requestAnimationFrame(() => chatComposerInputRef.current?.focus())
  }

  const captureReaderOriginalSelection = useCallback((): void => {
    if (readerMode !== 'article' || !selectedArticleId) {
      setReaderAiSelectionCandidate(null)
      return
    }
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setReaderAiSelectionCandidate(null)
      return
    }
    const range = selection.getRangeAt(0)
    const startElement = selectionNodeElement(range.startContainer)
    const endElement = selectionNodeElement(range.endContainer)
    const articleBody = startElement?.closest('.article-body') ?? null
    if (
      !articleBody
      || articleBody.classList.contains('translated-article-body')
      || !endElement
      || !articleBody.contains(endElement)
    ) {
      setReaderAiSelectionCandidate(null)
      return
    }
    const normalized = normalizeReaderAiSelectionText(selection.toString())
    if (!normalized) {
      setReaderAiSelectionCandidate(null)
      return
    }
    const truncated = normalized.length > READER_AI_SELECTION_MAX_CHARS
    const text = normalized.slice(0, READER_AI_SELECTION_MAX_CHARS)
    const clientRects = Array.from(range.getClientRects())
    const rect = clientRects.at(-1) ?? range.getBoundingClientRect()
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      setReaderAiSelectionCandidate(null)
      return
    }
    const placement: ReaderAiSelectionCandidate['placement'] = rect.top >= 64 ? 'above' : 'below'
    setReaderAiSelectionCandidate({
      articleId: selectedArticleId,
      text,
      truncated,
      x: Math.min(Math.max(rect.left + rect.width / 2, 58), Math.max(58, window.innerWidth - 58)),
      y: placement === 'above' ? rect.top - 8 : rect.bottom + 8,
      placement
    })
  }, [readerMode, selectedArticleId])

  const attachReaderSelectionToAi = (): void => {
    const candidate = readerAiSelectionCandidate
    if (!candidate || candidate.articleId !== selectedArticleId) return
    setReaderAiSelection({
      articleId: candidate.articleId,
      text: candidate.text,
      truncated: candidate.truncated
    })
    setReaderAiSelectionCandidate(null)
    window.getSelection()?.removeAllRanges()
    setReaderAiPanel((current) => openReaderAiPanel(current, chatConversationIdRef.current ? 'chat' : 'home'))
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => chatComposerInputRef.current?.focus()))
  }

  const openQuickSummary = (length: AiSummaryLength): void => {
    if (aiSummary?.length === length) {
      setReaderAiPanel((current) => openReaderAiPanel(current, 'summary'))
      if (readerMode === 'translation') setReaderMode('article')
      return
    }
    void generateAiSummary(false, { length })
  }

  const discardPendingManualToolContexts = (): void => {
    const pending = chatManualToolContextsRef.current
    if (pending.length === 0) return
    chatManualToolContextsRef.current = []
    setChatManualToolContexts([])
    for (const context of pending) {
      void window.origread.discardLlmManualToolContext(context.contextId).catch(() => undefined)
    }
  }

  const discardReaderAiManualToolContext = (contextId: string): void => {
    const id = contextId.trim()
    if (!id) return
    chatManualToolContextsRef.current = chatManualToolContextsRef.current.filter((item) => item.contextId !== id)
    setChatManualToolContexts((current) => current.filter((item) => item.contextId !== id))
    void window.origread.discardLlmManualToolContext(id).catch(() => undefined)
  }

  const executeReaderAiManualTool = async (toolId: string, argumentsJson: string): Promise<boolean> => {
    const conversationId = chatConversationIdRef.current
    if (!conversationId) {
      setChatError(t('manualToolNeedsConversation'))
      return false
    }
    if (chatManualToolBusy) return false
    const tool = chatManualTools.find((item) => item.id === toolId)
    if (!tool) {
      setChatError(t('manualToolUnavailable'))
      return false
    }
    setChatManualToolBusy(true)
    setChatError(null)
    try {
      const context = await window.origread.executeLlmManualTool({
        conversationId,
        toolId: tool.id,
        argumentsJson,
        confirmed: tool.risk !== 'READ_ONLY'
      })
      chatManualToolContextsRef.current = [...chatManualToolContextsRef.current, context]
      setChatManualToolContexts((current) => [...current, context])
      return true
    } catch (error) {
      setChatError(error instanceof Error ? error.message : t('manualToolExecutionFailed'))
      return false
    } finally {
      setChatManualToolBusy(false)
    }
  }

  const startNewReaderAiChat = (): void => {
    const requestId = chatActiveRequestIdRef.current
    if (requestId) void window.origread.cancelLlmExecution(requestId).catch(() => undefined)
    discardPendingManualToolContexts()
    if (chatConversation?.providerId) setChatDraftProviderId(chatConversation.providerId)
    if (chatConversation?.model) setChatDraftModel(chatConversation.model)
    chatActiveRequestIdRef.current = null
    chatConversationIdRef.current = null
    setChatConversation(null)
    setChatAttachedArticles([])
    setChatMessages([])
    setChatToolActivity([])
    setChatToolDecisionBusy({})
    setChatManualToolBusy(false)
    setChatDraft('')
    setChatError(null)
    setReaderAiSelection(null)
    setReaderAiSelectionCandidate(null)
    setChatHistoryLoading(false)
    setChatActiveExecution(null)
    setReaderAiPanel((current) => ({ ...openReaderAiPanel(current, 'home'), conversationId: null }))
  }

  const loadReaderAiConversationHistory = async (): Promise<void> => {
    if (!selectedArticleId) return
    setChatConversationHistoryLoading(true)
    setChatConversationHistoryError(null)
    try {
      setChatConversations(await window.origread.listLlmConversations(selectedArticleId))
    } catch {
      setChatConversationHistoryError(t('conversationHistoryLoadFailed'))
    } finally {
      setChatConversationHistoryLoading(false)
    }
  }

  const showReaderAiConversationHistory = (): void => {
    if (chatActiveRequestIdRef.current) return
    setChatConversationHistoryQuery('')
    setReaderAiPanel((current) => openReaderAiPanelDetail(current, 'conversation-history'))
    void loadReaderAiConversationHistory()
  }

  const closeReaderAiConversationHistory = (): void => {
    setReaderAiPanel((current) => closeReaderAiPanelDetail(current))
  }

  const showReaderAiChatSearch = (): void => {
    if (!chatConversation || readerAiPanel.view !== 'chat') return
    setReaderAiPanel((current) => openReaderAiPanelDetail(current, 'chat-search'))
    window.setTimeout(() => {
      chatSearchInputRef.current?.focus()
      chatSearchInputRef.current?.select()
    }, 0)
  }

  const closeReaderAiChatSearch = (): void => {
    setReaderAiPanel((current) => closeReaderAiPanelDetail(current))
  }

  const locateReaderAiChatMessage = (messageId: string): void => {
    setChatLocateMessageId(messageId)
    setReaderAiPanel((current) => closeReaderAiPanelDetail(current))
  }

  const openReaderAiConversation = async (conversation: LlmConversationRecord): Promise<void> => {
    if (chatActiveRequestIdRef.current) return
    discardPendingManualToolContexts()
    setReaderAiSelection(null)
    setReaderAiSelectionCandidate(null)
    setChatHistoryLoading(true)
    setChatError(null)
    try {
      const [messages, activity, attachedArticles] = await Promise.all([
        window.origread.getLlmMessages(conversation.id),
        window.origread.getLlmToolActivity(conversation.id),
        window.origread.getLlmConversationArticles(conversation.id)
      ])
      chatConversationIdRef.current = conversation.id
      setChatConversation(conversation)
      setChatAttachedArticles(attachedArticles)
      setChatMessages(messages)
      setChatToolActivity(activity)
      setChatToolDecisionBusy({})
      setChatDraft('')
      setReaderAiPanel((current) => ({
        ...openReaderAiPanel(current, 'chat'),
        conversationId: conversation.id
      }))
    } catch {
      setChatConversationHistoryError(t('conversationLoadFailed'))
    } finally {
      setChatHistoryLoading(false)
    }
  }

  const renameReaderAiConversation = async (conversationId: string, title: string): Promise<void> => {
    const updated = await window.origread.updateLlmConversation({ conversationId, title })
    setChatConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
    setChatConversation((current) => current?.id === updated.id ? updated : current)
  }

  const deleteReaderAiConversation = async (conversationId: string): Promise<void> => {
    const result = await window.origread.deleteLlmConversation(conversationId)
    if (!result.deleted) return
    setChatConversations((current) => current.filter((item) => item.id !== conversationId))
    if (chatConversationIdRef.current === conversationId) {
      discardPendingManualToolContexts()
      chatConversationIdRef.current = null
      setChatConversation(null)
      setChatAttachedArticles([])
      setChatMessages([])
      setChatToolActivity([])
      setChatToolDecisionBusy({})
      setChatDraft('')
      setChatError(null)
      setReaderAiPanel((current) => ({ ...current, view: 'home', conversationId: null }))
    }
  }

  const replaceReaderAiAttachedArticles = async (candidates: readonly LlmArticleContextCandidate[]): Promise<void> => {
    const currentArticleId = chatConversation?.articleId ?? selectedArticle?.id ?? null
    const unique = [...new Map(
      candidates
        .filter((item) => item.articleId !== currentArticleId)
        .map((item) => [item.articleId, item] as const)
    ).values()].slice(0, 5)
    if (chatConversation) {
      const persisted = await window.origread.replaceLlmConversationArticles({
        conversationId: chatConversation.id,
        articleIds: unique.map((item) => item.articleId)
      })
      setChatAttachedArticles(persisted)
      return
    }
    const now = Date.now()
    setChatAttachedArticles(unique.map((item, position) => ({
      conversationId: '',
      articleId: item.articleId,
      title: item.title,
      link: item.link,
      originalContent: '',
      summary: null,
      position,
      createdAt: now + position
    })))
  }

  const currentReaderLlmContextSnapshot = (): LlmReaderContextSnapshot | undefined => {
    if (!selectedArticle) return undefined
    const contextArticleId = chatConversation?.articleId ?? selectedArticle.id
    return {
      articleId: contextArticleId,
      ...(readerAiSelection?.articleId === contextArticleId && readerAiSelection.text.trim()
        ? { selectedText: readerAiSelection.text }
        : {})
    }
  }

  const sendReaderAiChatMessage = async (
    contentOverride?: string,
    requestTask: 'CHAT' | 'ARTICLE_ANALYSIS' = 'CHAT'
  ): Promise<void> => {
    const content = (contentOverride ?? chatDraft).trim()
    if (!content || !selectedArticle || !selectedArticleId || chatActiveRequestIdRef.current) return
    setChatError(null)
    try {
      let conversation = chatConversation?.id === readerAiPanel.conversationId ? chatConversation : null
      if (!conversation && readerAiPanel.conversationId) {
        const existing = await window.origread.listLlmConversations(selectedArticleId)
        conversation = existing.find((item) => item.id === readerAiPanel.conversationId) ?? null
      }
      if (!conversation) {
        const aiSettings = chatAiSettings ?? await window.origread.getAiSettings()
        setChatAiSettings(aiSettings)
        const enabledProviders = aiSettings.providers.filter((item) => item.enabled)
        const provider = enabledProviders.find((item) => item.id === chatDraftProviderId)
          ?? enabledProviders.find((item) => item.id === aiSettings.defaultProviderId)
          ?? enabledProviders[0]
          ?? null
        const model = provider
          ? chatDraftModel || provider.defaultModel || provider.models[0] || null
          : null
        conversation = await window.origread.createLlmConversation({
          title: chatConversationTitle(content),
          providerId: provider?.id ?? null,
          model,
          articleId: selectedArticle.id,
          articleTitle: selectedArticle.title,
          articleLink: selectedArticle.url
        })
        if (chatAttachedArticles.length > 0) {
          const persistedAttachments = await window.origread.replaceLlmConversationArticles({
            conversationId: conversation.id,
            articleIds: chatAttachedArticles.map((item) => item.articleId)
          })
          setChatAttachedArticles(persistedAttachments)
        }
      }
      setChatConversation(conversation)
      setChatConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      chatConversationIdRef.current = conversation.id
      const userMessage = await window.origread.appendLlmUserMessage({
        conversationId: conversation.id,
        content,
        requestTask
      })
      setChatMessages((current) => [...current, userMessage])
      if (contentOverride === undefined) setChatDraft('')
      if (requestTask === 'ARTICLE_ANALYSIS') setReaderAiSelection(null)
      setReaderAiPanel((current) => ({
        ...openReaderAiPanel(current, 'chat'),
        conversationId: conversation.id
      }))

      const requestId = crypto.randomUUID()
      chatActiveRequestIdRef.current = requestId
      chatActiveRequestTaskRef.current = requestTask
      const manualToolContextIds = requestTask === 'CHAT'
        ? chatManualToolContextsRef.current.map((item) => item.contextId)
        : []
      const readerContext: LlmReaderContextSnapshot = requestTask === 'ARTICLE_ANALYSIS'
        ? { articleId: selectedArticle.id }
        : currentReaderLlmContextSnapshot() ?? { articleId: selectedArticle.id }
      const identity = await window.origread.startLlmExecution({
        requestId,
        conversationId: conversation.id,
        readerContext,
        ...(manualToolContextIds.length > 0 ? { manualToolContextIds } : {}),
        profile: {
          task: requestTask,
          providerId: conversation.providerId,
          model: conversation.model,
          ...(chatForceWebSearchNext ? { webSearchMode: 'FORCE' as const } : {})
        }
      })
      if (manualToolContextIds.length > 0) {
        const consumed = new Set(manualToolContextIds)
        chatManualToolContextsRef.current = chatManualToolContextsRef.current.filter((item) => !consumed.has(item.contextId))
        setChatManualToolContexts((current) => current.filter((item) => !consumed.has(item.contextId)))
      }
      if (readerContext?.selectedText) {
        setReaderAiSelection((current) =>
          current?.articleId === readerContext.articleId && current.text === readerContext.selectedText ? null : current
        )
      }
      if (chatForceWebSearchNext) setChatForceWebSearchNext(false)
      setChatActiveExecution(identity)
      setChatMessages((current) => ensureChatAssistantMessage(current, identity, requestTask))
    } catch {
      chatActiveRequestIdRef.current = null
      chatActiveRequestTaskRef.current = 'CHAT'
      setChatActiveExecution(null)
      setChatError(t('aiChatRequestFailed'))
    }
  }

  const sendReaderAiQuickMessage = async (message: LlmQuickMessage): Promise<void> => {
    if (!selectedArticle || chatActiveRequestIdRef.current) return
    const resolution = resolveQuickMessageTemplate(message.content, {
      articleTitle: selectedArticle.title,
      articleUrl: selectedArticle.url,
      selection: readerAiSelection?.articleId === selectedArticle.id ? readerAiSelection.text : null,
      summary: aiSummary?.status === 'GENERATED' ? aiSummary.summary : null
    })
    if (resolution.unsupportedVariables.length > 0) {
      setChatError(t('quickMessageUnsupportedVariables', {
        items: resolution.unsupportedVariables.map((item) => `{{${item}}}`).join(', ')
      }))
      return
    }
    if (resolution.unavailableVariables.length > 0) {
      const labels: Record<string, string> = {
        article_title: t('quickVariableArticleTitle'),
        article_url: t('quickVariableArticleUrl'),
        selection: t('quickVariableSelection'),
        summary: t('quickVariableSummary')
      }
      setChatError(t('quickMessageUnavailable', {
        items: resolution.unavailableVariables.map((item) => labels[item] ?? item).join(i18n.resolvedLanguage?.startsWith('zh') ? '、' : ', ')
      }))
      return
    }
    if (!resolution.content) return
    await sendReaderAiChatMessage(resolution.content)
  }

  const stopReaderAiChat = (): void => {
    const requestId = chatActiveRequestIdRef.current
    if (!requestId) return
    void window.origread.cancelLlmExecution(requestId).catch(() => undefined)
  }

  const resolveReaderAiToolApproval = async (toolCallId: string, decision: LlmToolApprovalDecision): Promise<void> => {
    const conversationId = chatConversationIdRef.current
    if (!conversationId || chatToolDecisionBusy[toolCallId]) return
    setChatToolDecisionBusy((current) => ({ ...current, [toolCallId]: true }))
    setChatError(null)
    try {
      const result = await window.origread.resolveLlmToolApproval(toolCallId, decision)
      if (!result.accepted) {
        setChatError(t('toolApprovalExpired'))
        setChatToolActivity(await window.origread.getLlmToolActivity(conversationId))
      }
    } catch {
      setChatError(t('toolApprovalFailed'))
    } finally {
      setChatToolDecisionBusy((current) => ({ ...current, [toolCallId]: false }))
    }
  }

  const regenerateReaderAiAssistant = async (assistantMessageId: string): Promise<void> => {
    const conversation = chatConversation
    if (!conversation || chatActiveRequestIdRef.current) return
    const requestTask = chatMessages.find((message) => message.id === assistantMessageId)?.requestTask ?? 'CHAT'
    setChatError(null)
    const requestId = crypto.randomUUID()
    chatActiveRequestIdRef.current = requestId
    chatActiveRequestTaskRef.current = requestTask
    setChatMessages((current) => current.map((message) =>
      message.id === assistantMessageId ? { ...message, historyActive: false } : message
    ))
    try {
      const identity = await window.origread.startLlmExecution({
        requestId,
        conversationId: conversation.id,
        regenerateAssistantMessageId: assistantMessageId,
        profile: {
          task: requestTask,
          providerId: conversation.providerId,
          model: conversation.model
        }
      })
      setChatActiveExecution(identity)
      setChatMessages((current) => ensureChatAssistantMessage(current, identity, requestTask))
    } catch {
      chatActiveRequestIdRef.current = null
      chatActiveRequestTaskRef.current = 'CHAT'
      setChatActiveExecution(null)
      setChatError(t('aiChatRegenerateFailed'))
      void window.origread.getLlmMessages(conversation.id).then(setChatMessages).catch(() => undefined)
    }
  }

  const changeReaderAiPanelPlacement = async (placement: AiSummaryPlacement): Promise<void> => {
    await updateDesktopSettings({ aiSummaryPlacement: placement })
  }

  const cycleReaderAiPanelPlacement = (direction: -1 | 1): void => {
    const currentIndex = aiSummaryPlacementOrder.indexOf(aiSummaryPlacement)
    const nextIndex = (currentIndex + direction + aiSummaryPlacementOrder.length) % aiSummaryPlacementOrder.length
    void changeReaderAiPanelPlacement(aiSummaryPlacementOrder[nextIndex]!)
  }

  const resizeAiSummaryPanel = (direction: -1 | 1): void => {
    const current = settings?.aiSummaryPanelSize ?? 360
    const next = Math.max(
      AI_SUMMARY_PANEL_MIN,
      Math.min(AI_SUMMARY_PANEL_MAX, current + direction * AI_SUMMARY_PANEL_KEYBOARD_STEP)
    )
    if (next !== current) void updateDesktopSettings({ aiSummaryPanelSize: next })
  }

  /**
   * Focus Reading 只临时覆盖 Pane 可见性，不写入持久化折叠偏好。
   * 退出后自然恢复进入 Focus 前的 Source / Article 手动组合。
   */
  const toggleFocusReading = useCallback((): void => {
    setAdaptiveSourceOverlayOpen(false)
    closeSourceSwitcher(false)
    closeSourceManager(false)
    setSubscriptionMenuOpen(false)
    setReaderMoreOpen(false)
    setFocusReading((current) => !current)
  }, [closeSourceManager, closeSourceSwitcher])

  const generateAiSummary = async (forceRefresh = false, options?: AiSummaryRequestOptions): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    if (!closeSettingsIfAllowed()) return
    const requestArticleId = selectedArticleId
    const runId = ++aiSummaryRunRef.current
    aiSummaryPerfRunRef.current = { runId, articleId: requestArticleId, startedAt: performance.now() }
    aiSummaryUiTtfvRecordedRef.current = false
    if (originalViewState.open) await closeOriginalArticle()
    setReaderToolLoading('ai')
    setReaderToolNotice(null)
    setAiSummaryProgress({ articleId: requestArticleId, stage: 'PREPARING' })
    setAiSummaryStream(null)
    setAiSummaryStartedAt(Date.now())
    setReaderAiPanel((current) => openReaderAiPanel(current, 'summary'))
    setReaderMode('article')
    try {
      const result = await window.origread.summarizeArticle(requestArticleId, forceRefresh, options)
      if (runId !== aiSummaryRunRef.current || selectedArticleIdRef.current !== requestArticleId) return
      setAiSummary(result)
      setReaderAiPanel((current) => openReaderAiPanel(current, 'summary'))
      setReaderMode('article')
    } catch (error) {
      if (runId === aiSummaryRunRef.current && selectedArticleIdRef.current === requestArticleId) {
        aiSummaryPerfRunRef.current = null
        setReaderToolNotice(readerToolFeedback(error, 'ai'))
        if (!aiSummary) {
          setReaderAiPanel((current) => openReaderAiPanel(current, 'home'))
        }
      }
    } finally {
      if (runId === aiSummaryRunRef.current) {
        setReaderToolLoading(null)
        setAiSummaryProgress(null)
        setAiSummaryStream(null)
        setAiSummaryStartedAt(null)
      }
    }
  }

  const stopAiSummary = (): void => {
    const articleId = selectedArticleIdRef.current
    if (!articleId || readerToolLoading !== 'ai') return
    aiSummaryRunRef.current += 1
    aiSummaryPerfRunRef.current = null
    aiSummaryUiTtfvRecordedRef.current = false
    void window.origread.stopAiSummary(articleId).catch(() => undefined)
    setReaderToolLoading(null)
    setAiSummaryProgress(null)
    setAiSummaryStream(null)
    setAiSummaryStartedAt(null)
    setReaderToolNotice(null)
    if (!aiSummary) {
      setReaderAiPanel((current) => openReaderAiPanel(current, 'home'))
    }
  }

  const recordAiSummaryUiTtfv = useCallback((firstVisible: 'reasoning' | 'content'): void => {
    const perfRun = aiSummaryPerfRunRef.current
    if (!perfRun || perfRun.runId !== aiSummaryRunRef.current || aiSummaryUiTtfvRecordedRef.current) return
    aiSummaryUiTtfvRecordedRef.current = true
    const elapsedMs = Math.max(0, Math.round((performance.now() - perfRun.startedAt) * 10) / 10)
    console.info('[OrigRead][AI Perf]', JSON.stringify({
      task: 'summary',
      metric: 'UI_TTFV',
      UI_TTFV_ms: elapsedMs,
      first_visible: firstVisible
    }))
    aiSummaryPerfRunRef.current = null
  }, [])

  const translateSelectedArticle = async (forceRefresh = false, target?: TranslationTarget): Promise<void> => {
    if (!selectedArticleId || readerToolLoading) return
    if (!closeSettingsIfAllowed()) return
    const requestArticleId = selectedArticleId
    const runId = ++translationRunRef.current
    translationRequestArticleRef.current = requestArticleId
    if (originalViewState.open) await closeOriginalArticle()
    setReaderToolLoading('translation')
    setReaderToolNotice(null)
    try {
      const result = await window.origread.translateArticle(requestArticleId, target, forceRefresh)
      if (runId !== translationRunRef.current || selectedArticleIdRef.current !== requestArticleId) return
      setTranslationDocument(result)
      setReaderMode('translation')
    } catch (error) {
      if (runId === translationRunRef.current && selectedArticleIdRef.current === requestArticleId) {
        setReaderToolNotice(readerToolFeedback(error, 'translation'))
      }
    } finally {
      if (runId === translationRunRef.current) {
        translationRequestArticleRef.current = null
        setReaderToolLoading(null)
      }
    }
  }

  const handleConfigurationRestored = async (): Promise<void> => {
    const [nextSettings, nextSync] = await Promise.all([window.origread.getSettings(), window.origread.getSyncRuntimeState()])
    setSettings(nextSettings)
    setSyncRuntimeState(nextSync)
    // 配置恢复后的持久化 Pane 状态应立即可见；临时 Focus 不应遮住恢复结果。
    setFocusReading(false)
    setAdaptiveSourceOverlayOpen(false)
    closeSourceSwitcher(false)
    closeSourceManager(false)
    setSubscriptionMenuOpen(false)
    const language = nextSettings.language === 'system' ? resolveDesktopLanguage(appInfo?.locale ?? navigator.language) : nextSettings.language
    await i18n.changeLanguage(language)
    await reloadLibrary()
  }

  const handleAccountChanged = async (): Promise<void> => {
    closeSourceSwitcher(false)
    closeSourceManager(false)
    setRecentSourceScopeKeys([])
    // Feed / Group ID 只在当前账户内有效；切换账户必须回到 All，避免旧 Scope 继续引用上一账户数据。
    setArticleScope({ kind: 'all' })
    setScopeArticles(null)
    setArticleQuery('')
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
      if (patch.layoutMode !== undefined) {
        // 主布局切换必须退出临时 Focus / overlay，但不能改写任一布局自己的持久化宽度与折叠偏好。
        setFocusReading(false)
        setAdaptiveSourceOverlayOpen(false)
        closeSourceSwitcher(false)
        closeSourceManager(false)
        setSubscriptionMenuOpen(false)
        setReaderMoreOpen(false)
      }
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

  /** 双栏 Workspace 拖动时只更新 Renderer 快照，pointerup 再持久化。 */
  const previewWorkspaceWidth = (width: number): void => {
    setSettings((current) => current ? { ...current, workspaceWidth: width } : current)
  }

  /** Source Divider 拖动时只更新 Renderer 快照，pointerup 再持久化。 */
  const previewSourcePaneWidth = (width: number): void => {
    setSettings((current) => current ? { ...current, sourcePaneWidth: width } : current)
  }

  /** Article Divider 拖动时只更新 Renderer 快照，避免 pointermove 高频 Settings IPC。 */
  const previewArticlePaneWidth = (width: number): void => {
    setSettings((current) => current ? { ...current, articlePaneWidth: width } : current)
  }

  /** 双栏 Workspace 的持久化折叠开关；Focus Reading 只临时覆盖可见性。 */
  const toggleWorkspacePane = (): void => {
    if (focusReading) {
      setFocusReading(false)
      return
    }
    void updateDesktopSettings({ workspaceCollapsed: !(settings?.workspaceCollapsed ?? false) })
  }

  /** Source Pane 的手动折叠状态持久化；从 Focus restore 时先退出 Focus。 */
  const toggleSourcePane = (): void => {
    const manuallyCollapsed = settings?.sourcePaneCollapsed ?? false
    const adaptiveHidden = viewportWidth < THREE_PANE_BREAKPOINT
    if (focusReading) {
      setFocusReading(false)
      if (manuallyCollapsed) {
        void updateDesktopSettings({ sourcePaneCollapsed: false })
      } else if (adaptiveHidden) {
        setAdaptiveSourceOverlayOpen(true)
      }
      return
    }
    if (adaptiveHidden) {
      // 窄窗口 rail 负责临时打开 Source overlay；若此前是手动折叠，先恢复持久化状态。
      if (manuallyCollapsed) void updateDesktopSettings({ sourcePaneCollapsed: false })
      setAdaptiveSourceOverlayOpen(true)
      return
    }
    if (manuallyCollapsed) {
      void updateDesktopSettings({ sourcePaneCollapsed: false })
      return
    }
    void updateDesktopSettings({ sourcePaneCollapsed: true })
  }

  /** Article Pane 的手动折叠状态持久化；与 Source Pane 完全独立。 */
  const toggleArticlePane = (): void => {
    const manuallyCollapsed = settings?.articlePaneCollapsed ?? false
    const effectivelyCollapsed = focusReading || manuallyCollapsed
    if (effectivelyCollapsed) {
      setFocusReading(false)
      if (manuallyCollapsed) void updateDesktopSettings({ articlePaneCollapsed: false })
      return
    }
    void updateDesktopSettings({ articlePaneCollapsed: true })
  }

  /**
   * 统一恢复按钮每次只恢复一层：Focus -> Article -> Source。
   *
   * 这样两栏都收起时只保留一个“<<”入口；点击一次恢复 Article 后变成“<”，
   * 再点击恢复 Source。窄窗口下 Source 仍沿用原来的 overlay 语义，不改写响应式状态模型。
   */
  const restoreCollapsedPaneLayer = (): void => {
    if (focusReading) {
      setFocusReading(false)
      return
    }
    if (articlePaneCollapsed) {
      toggleArticlePane()
      return
    }
    if (sourcePaneCollapsed || adaptiveSourceHidden) {
      toggleSourcePane()
    }
  }

  const showReadingShareStatus = (kind: 'success' | 'error', message: string): void => {
    setReadingShareStatus({ kind, message })
    window.setTimeout(() => setReadingShareStatus(null), 3_000)
  }

  const copyReadingMarkdown = async (preference: ReadingSharePreference): Promise<boolean> => {
    if (!selectedArticle) return false

    const markdown = buildReadingShareMarkdown({
      title: selectedArticle.title,
      sourceUrl: originalUrl,
      bodyHtml: readerContent?.html || selectedArticle.description,
      // 与 Android 一致：只有当前阅读模式正在显示的翻译才参与分享。
      translatedHtml: readerMode === 'translation' ? translationDocument?.translatedContent ?? null : null,
      translatedDisplayMode: readerMode === 'translation' ? translationDocument?.displayMode : undefined,
      // 与 Android 一致：摘要面板关闭后，即使有历史生成结果也不参与分享。
      summaryMarkdown: aiSummaryPanelOpen && aiSummary?.status === 'GENERATED' ? aiSummary.summary : null,
      sourceUrlLabel: t('readingShareSourceUrl'),
      summaryLabel: t('readingShareSummaryLabel'),
      preference
    })

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = markdown
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('clipboard unavailable')
      }
      showReadingShareStatus('success', t('readingShareCopied'))
      return true
    } catch {
      showReadingShareStatus('error', t('readingShareCopyFailed'))
      return false
    }
  }

  const saveReadingSharePreference = async (preference: ReadingSharePreference, shareAfterSave = false): Promise<void> => {
    try {
      const next = await window.origread.updateSettings({
        readingShareConfigured: true,
        readingShareIncludeTitle: preference.includeTitle,
        readingShareIncludeBody: preference.includeBody,
        readingShareIncludeTranslation: preference.includeTranslation,
        readingShareIncludeSummary: preference.includeSummary
      })
      setSettings(next)
      setReadingShareDialog(null)
      if (shareAfterSave) await copyReadingMarkdown(preference)
    } catch (error) {
      showReadingShareStatus('error', error instanceof Error ? error.message : String(error))
    }
  }

  const handleReadingShareClick = (): void => {
    if (!selectedArticle) return
    if (!readingSharePreference.configured) {
      setReadingShareDialog('first-use')
      return
    }
    void copyReadingMarkdown(readingSharePreference)
  }

  const handleReadingShareContextMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    if (selectedArticle) setReadingShareDialog('config')
  }

  const showSettings = async (page: SettingsPage = 'general'): Promise<void> => {
    // Original Article 作为当前 Reader 上下文保留；Settings 打开时仅临时隐藏 child WebContentsView，
    // 这样用户可以切换两栏/三栏后无损返回同一原网页。
    closeSourceSwitcher(false)
    closeSourceManager(false)
    setReaderMoreOpen(false)
    setSourceCatalogOpen(false)
    if (!settingsOpen) setSettingsUnsaved(false)
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
    if (!closeSettingsIfAllowed()) return
    setReaderMoreOpen(false)
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

  const openReaderAiSources = (messageId: string, citationId: string | null = null, locationUnavailable = false): void => {
    setReaderAiSourceFocus({ messageId, citationId, locationUnavailable })
    setReaderAiPanel((current) => openReaderAiPanelDetail(current, 'sources', messageId))
  }

  const clearReaderCitationHighlight = (): void => {
    if (readerCitationHighlightTimerRef.current !== null) {
      window.clearTimeout(readerCitationHighlightTimerRef.current)
      readerCitationHighlightTimerRef.current = null
    }
    readerCitationHighlightRef.current?.classList.remove('origread-citation-highlight')
    readerCitationHighlightRef.current = null
  }

  const revealReaderCitationNow = (citation: LlmCitationRefRecord): boolean => {
    const articleBody = readerContentRef.current?.querySelector<HTMLElement>('.article-body:not(.translated-article-body)') ?? null
    const element = articleBody ? findReaderCitationElement(articleBody, citation) : null
    if (!element) return false
    clearReaderCitationHighlight()
    readerCitationHighlightRef.current = element
    element.classList.add('origread-citation-highlight')
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    readerCitationHighlightTimerRef.current = window.setTimeout(() => {
      element.classList.remove('origread-citation-highlight')
      if (readerCitationHighlightRef.current === element) readerCitationHighlightRef.current = null
      readerCitationHighlightTimerRef.current = null
    }, 2_800)
    return true
  }

  const openReaderAiCitation = async (
    messageId: string,
    citation: LlmCitationRefRecord,
    snapshot: LlmAssistantEvidenceSnapshot
  ): Promise<void> => {
    const contextRef = snapshot.contextRefs.find((ref) => ref.id === citation.contextRefId) ?? null
    const sourceKind = citation.locatorSnapshot?.sourceKind
    if (sourceKind === 'WEB_SEARCH' && citation.sourceUrl) {
      await openExternal(citation.sourceUrl)
      return
    }
    if (sourceKind === 'TOOL_RESULT') {
      if (citation.sourceUrl) await openExternal(citation.sourceUrl)
      else openReaderAiSources(messageId, citation.id)
      return
    }
    if (sourceKind !== 'ARTICLE' && sourceKind !== 'SELECTION') {
      openReaderAiSources(messageId, citation.id)
      return
    }
    const articleId = citation.locatorSnapshot?.articleId ?? contextRef?.articleId ?? null
    if (!articleId) {
      openReaderAiSources(messageId, citation.id, true)
      return
    }
    setReaderAiSourceFocus({ messageId, citationId: citation.id, locationUnavailable: false })
    setReaderMode('article')
    if (selectedArticleId === articleId && readerMode === 'article' && revealReaderCitationNow(citation)) {
      setReaderCitationTarget(null)
      return
    }
    setReaderCitationTarget({ messageId, citation, contextRef })
    if (selectedArticleId === articleId) return
    try {
      const article = await window.origread.getArticleById(articleId)
      if (!article) {
        openReaderAiSources(messageId, citation.id, true)
        setReaderCitationTarget(null)
        return
      }
      citationArticleNavigationRef.current = articleId
      setSelectedArticleRecord(article)
      setSelectedArticleId(articleId)
    } catch {
      openReaderAiSources(messageId, citation.id, true)
      setReaderCitationTarget(null)
    }
  }

  const handleReaderHtmlClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const citationMarker = target.closest<HTMLButtonElement>('button[data-origread-citation-id]')
    if (citationMarker && readerAiVisibleCitationSnapshot) {
      const citation = readerAiVisibleCitationSnapshot.snapshot.citations.find((item) => item.id === citationMarker.dataset.origreadCitationId)
      if (citation) {
        event.preventDefault()
        void openReaderAiCitation(readerAiVisibleCitationSnapshot.messageId, citation, readerAiVisibleCitationSnapshot.snapshot)
        return
      }
    }
    const anchor = target.closest('a[href]')
    if (!anchor) return
    const url = normalizeHttpUrl(anchor.getAttribute('href'))
    if (!url) return
    event.preventDefault()
    void openExternal(url)
  }

  const selectArticle = (article: ArticleRecord): void => {
    if (!closeSettingsIfAllowed()) return
    const readerArticle = article.isUnread ? { ...article, isUnread: false } : article
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
    if (originalViewState.open) void closeOriginalArticle()
    setSelectedArticleRecord(readerArticle)
    setSelectedArticleId(article.id)
  }

  const searchCachedArticles = useCallback(async (value: string): Promise<void> => {
    const normalized = value.trim()
    if (!normalized) {
      setGlobalSearchResults([])
      setGlobalSearchLoading(false)
      setGlobalSearchError(null)
      return
    }

    setGlobalSearchLoading(true)
    setGlobalSearchError(null)
    try {
      setGlobalSearchResults(await window.origread.searchArticles(normalized, 100))
    } catch (error) {
      setGlobalSearchResults([])
      setGlobalSearchError(error instanceof Error ? error.message : String(error))
    } finally {
      setGlobalSearchLoading(false)
    }
  }, [])

  const selectGlobalSearchResult = async (result: ArticleSearchResult): Promise<void> => {
    try {
      const existing = articles.find((article) => article.id === result.id)
        ?? scopeArticles?.find((article) => article.id === result.id)
      const article = existing ?? await window.origread.getArticleById(result.id)
      if (!article) {
        setGlobalSearchError(t('globalSearchOpenFailed'))
        return
      }
      if (!existing) setArticles((current) => current.some((item) => item.id === article.id) ? current : [...current, article])
      closeGlobalSearch()
      selectArticle(article)
    } catch (error) {
      setGlobalSearchError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleStarred = (article: ArticleRecord): void => {
    const next = !article.isStarred
    setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isStarred: next } : item))
    setScopeArticles((current) => current?.map((item) => item.id === article.id ? { ...item, isStarred: next } : item) ?? current)
    setSelectedArticleRecord((current) => current?.id === article.id ? { ...current, isStarred: next } : current)
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
    setSelectedArticleRecord((current) => current?.id === article.id ? { ...current, isUnread: next } : current)
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
      const typingTarget = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'f' && !globalSearchOpen && !settingsOpen && !sourceCatalogOpen && !originalViewState.open && !document.querySelector('[role="dialog"]')) {
        if (interactiveTarget) return
        event.preventDefault()
        openGlobalSearch()
        return
      }
      if (
        (event.ctrlKey || event.metaKey)
        && key === 'f'
        && readerAiPanel.open
        && readerAiPanel.view === 'chat'
        && (readerAiPanel.detailView === null || readerAiPanel.detailView === 'chat-search')
        && chatConversation?.id
        && !settingsOpen
        && !sourceCatalogOpen
        && !originalViewState.open
      ) {
        event.preventDefault()
        setReaderAiPanel((current) => openReaderAiPanelDetail(current, 'chat-search'))
        window.setTimeout(() => {
          chatSearchInputRef.current?.focus()
          chatSearchInputRef.current?.select()
        }, 0)
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'f' && selectedArticleId && !settingsOpen && !sourceCatalogOpen && !originalViewState.open) {
        if (interactiveTarget && !readerSearchOpen) return
        event.preventDefault()
        setReaderSearchOpen(true)
        window.setTimeout(() => readerSearchInputRef.current?.focus(), 0)
        return
      }
      if (
        (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && key === 'k'
        && settings?.layoutMode === 'two-pane'
        && !settings.workspaceCollapsed
        && !focusReading
        && !settingsOpen
        && !sourceCatalogOpen
        && !sourceManagerOpen
        && !subscriptionMenuOpen
        && !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault()
        if (sourceSwitcherOpen) {
          sourceSwitcherSearchInputRef.current?.focus()
          sourceSwitcherSearchInputRef.current?.select()
        } else {
          setSourceSwitcherQuery('')
          setSourceSwitcherOpen(true)
        }
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'k' && !settingsOpen && !sourceCatalogOpen && !subscriptionMenuOpen && !document.querySelector('[role="dialog"]')) {
        const targetSearchInput = sourceSwitcherOpen
          ? sourceSwitcherSearchInputRef.current
          : articleSearchInputRef.current
        if (!targetSearchInput) return
        event.preventDefault()
        targetSearchInput.focus()
        targetSearchInput.select()
        return
      }
      if (event.key === 'Escape' && readerSearchOpen) {
        setReaderSearchOpen(false)
        setReaderSearchQuery('')
        setReaderSearchCount(0)
        setReaderSearchIndex(0)
        return
      }
      if (event.key === 'Escape' && readerAiPanel.detailView === 'chat-search') {
        event.preventDefault()
        setReaderAiPanel((current) => closeReaderAiPanelDetail(current))
        return
      }
      // Focus Reading 是全局布局快捷键；按钮/链接持焦点时仍可触发，只在真实输入控件中避让。
      if (key === '[' && !typingTarget && !event.ctrlKey && !event.metaKey && !event.altKey && !settingsOpen && !sourceCatalogOpen && !subscriptionMenuOpen && !document.querySelector('[role="dialog"]')) {
        event.preventDefault()
        toggleFocusReading()
        return
      }
      if (interactiveTarget || event.ctrlKey || event.metaKey || event.altKey || settingsOpen || sourceCatalogOpen || sourceSwitcherOpen || sourceManagerOpen || subscriptionMenuOpen || document.querySelector('[role="dialog"]')) return
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
      if (key === 'a') {
        event.preventDefault()
        toggleReaderAiAssistant()
      } else if (key === 'm') {
        event.preventDefault()
        toggleUnread(selectedArticle)
      } else if (key === 's') {
        event.preventDefault()
        toggleStarred(selectedArticle)
      } else if (key === 'u' && originalUrl) {
        event.preventDefault()
        void showOriginalArticle()
      } else if ((event.code === 'Comma' || event.code === 'Period') && readerAiPanel.open) {
        event.preventDefault()
        cycleReaderAiPanelPlacement(event.code === 'Comma' ? -1 : 1)
      } else if ((key === '-' || key === '=' || key === '+') && readerAiPanel.open) {
        event.preventDefault()
        resizeAiSummaryPanel(key === '-' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [aiSummaryPlacement, chatConversation?.id, focusReading, globalSearchOpen, nextArticle, openGlobalSearch, originalUrl, originalViewState.open, previousArticle, readerAiPanel.detailView, readerAiPanel.open, readerAiPanel.view, readerSearchOpen, selectedArticle, selectedArticleId, settings?.aiSummaryPanelSize, settings?.layoutMode, settings?.workspaceCollapsed, settingsOpen, sourceCatalogOpen, sourceManagerOpen, sourceSwitcherOpen, subscriptionMenuOpen, toggleFocusReading, toggleReaderAiAssistant, visibleArticles])

  const openAddSource = (): void => {
    closeSourceSwitcher(false)
    closeSourceManager(false)
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
    if (!closeSettingsIfAllowed()) return
    if (originalViewState.open) await closeOriginalArticle()
    closeSourceSwitcher(false)
    closeSourceManager(false)
    setReaderMoreOpen(false)
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

  const refreshFeed = async (
    feed: FeedRecord,
    scopeAfterRefresh?: ArticleScope,
    noticeTarget: 'source' | 'article' = 'source'
  ): Promise<void> => {
    if (refreshingFeedId || isRefreshingAll) return
    setRefreshingFeedId(feed.id)
    const setRefreshError = noticeTarget === 'article' ? setArticleListError : setSourceError
    setRefreshError(null)
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
      setRefreshError(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRefreshingFeedId(null)
    }
  }

  /** Group Scope 与 Feed Scope 共用 Recent 记录规则，确保三栏和双栏进入同一 Recent 列表。 */
  const selectGroupScope = (group: GroupRecord): void => {
    const scope: ArticleScope = { kind: 'group', id: group.id }
    setArticleScope(scope)
    setArticleQuery('')
    rememberSourceScope(scope)
  }

  const selectFeedScope = (feed: FeedRecord): void => {
    const scope: ArticleScope = { kind: 'feed', id: feed.id }
    setArticleScope(scope)
    setArticleQuery('')
    rememberSourceScope(scope)
    if (isOrigReadDesktopReleaseFeed(feed.url) && feedStats(feed.id).total === 0) {
      void refreshFeed(feed, scope, 'article')
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
    setArticleListError(null)
    try {
      const result = await window.origread.refreshAllSources()
      await Promise.all([reloadLibrary(), reloadCurrentScope()])
      if (result.failedCount > 0) {
        const firstFailure = result.results.find((item) => item.status === 'failed')
        setArticleListError(t('syncPartialFailure', {
          failed: result.failedCount,
          total: result.sourceCount,
          error: firstFailure?.error ?? t('unknownError')
        }))
      }
    } catch (error) {
      setArticleListError(`${t('refreshFailed')}: ${error instanceof Error ? error.message : String(error)}`)
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
  const sourcePaneCollapsed = settings?.sourcePaneCollapsed ?? false
  const articlePaneCollapsed = settings?.articlePaneCollapsed ?? false
  const layoutMode = settings?.layoutMode ?? 'three-pane'
  const twoPaneLayout = layoutMode === 'two-pane'
  const workspaceCollapsed = settings?.workspaceCollapsed ?? false
  const effectiveWorkspaceCollapsed = twoPaneLayout && (focusReading || workspaceCollapsed)
  const persistedArticlePaneWidth = settings?.articlePaneWidth ?? 380
  const responsiveLayout = resolveResponsivePaneLayout(viewportWidth, persistedArticlePaneWidth)
  const { adaptiveSourceHidden, compactLayout, articlePaneWidth: effectiveArticlePaneWidth } = responsiveLayout
  const effectiveSourcePaneCollapsed = !twoPaneLayout && (focusReading || sourcePaneCollapsed || adaptiveSourceHidden)
  const effectiveArticlePaneCollapsed = !twoPaneLayout && (focusReading || articlePaneCollapsed)
  const collapsedPaneCount = Number(effectiveSourcePaneCollapsed) + Number(effectiveArticlePaneCollapsed)
  const showArticleBoundarySplit = !effectiveSourcePaneCollapsed && effectiveArticlePaneCollapsed
  const collapsedPaneRestoreLabel = focusReading
    ? t('exitFocusReading')
    : collapsedPaneCount > 1
      ? t('restoreCollapsedPanes')
      : t('expandSourcePane')
  const readerStyle = {
    '--workspace-pane-track': effectiveWorkspaceCollapsed ? '0px' : `${settings?.workspaceWidth ?? 420}px`,
    '--workspace-divider-track': effectiveWorkspaceCollapsed ? '0px' : '5px',
    '--source-pane-track': effectiveSourcePaneCollapsed ? '0px' : `${settings?.sourcePaneWidth ?? 260}px`,
    '--source-divider-track': effectiveSourcePaneCollapsed ? '0px' : '5px',
    '--source-pane-overlay-width': `${settings?.sourcePaneWidth ?? 260}px`,
    '--article-pane-track': effectiveArticlePaneCollapsed ? '0px' : `${effectiveArticlePaneWidth}px`,
    '--article-divider-track': effectiveArticlePaneCollapsed ? '0px' : '5px',
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

  const renderSourceBrandHeader = (): React.JSX.Element => (
    <SourceBrandHeader
      subscriptionMenuOpen={subscriptionMenuOpen}
      opmlBusy={opmlBusy}
      onShowSourceCatalog={() => void showSourceCatalog()}
      onToggleSubscriptionMenu={() => setSubscriptionMenuOpen((open) => !open)}
      onCloseSubscriptionMenu={() => setSubscriptionMenuOpen(false)}
      onAddSource={openAddSource}
      onImportOpml={() => void importOpml()}
      onOpenOpmlExport={() => { setSubscriptionMenuOpen(false); setOpmlExportOpen(true) }}
    />
  )

  const renderSourceSidebar = ({ overlay = false, sourceManager = false }: {
    overlay?: boolean
    sourceManager?: boolean
  } = {}): React.JSX.Element => {
    const closeSourceView = (restoreFocus = true): void => {
      if (overlay) {
        setAdaptiveSourceOverlayOpen(false)
        setSubscriptionMenuOpen(false)
      }
      if (sourceManager) closeSourceManager(restoreFocus)
    }
    return (
      <SourceSidebar
        articleScope={articleScope}
        sourceQuery={sourceQuery}
        visibleFeedCount={visibleFeeds.length}
        groupedFeeds={groupedVisibleFeeds}
        feedStatsById={feedStatsById}
        allArticleCount={librarySnapshot?.articles ?? articles.length}
        allUnreadCount={librarySnapshot?.unread ?? articles.filter((article) => article.isUnread).length}
        collapsedGroupIds={collapsedSourceGroupIds}
        refreshingFeedId={refreshingFeedId}
        isRefreshingAll={isRefreshingAll}
        subscriptionMenuOpen={subscriptionMenuOpen}
        opmlBusy={opmlBusy}
        opmlStatus={opmlStatus}
        sourceError={sourceError}
        showNotices={!addSourceOpen}
        showHeader={!sourceManager}
        onSourceQueryChange={setSourceQuery}
        onSelectAll={() => { setArticleScope({ kind: 'all' }); setArticleQuery(''); closeSourceView() }}
        onSelectGroup={(group) => { selectGroupScope(group); closeSourceView() }}
        onToggleGroupCollapsed={(groupId) => setCollapsedSourceGroupIds((current) => {
          const next = new Set(current)
          if (next.has(groupId)) next.delete(groupId)
          else next.add(groupId)
          return next
        })}
        onSelectFeed={(feed) => { selectFeedScope(feed); closeSourceView() }}
        onRefreshFeed={(feed) => void refreshFeed(feed)}
        onOpenFeedSettings={(feed) => { closeSourceView(false); setSourceSettingsFeed(feed) }}
        onFeedContextMenu={(feed, x, y) => setContextMenu({ kind: 'feed', x, y, feedId: feed.id })}
        onShowSourceCatalog={() => { closeSourceView(false); void showSourceCatalog() }}
        onToggleSubscriptionMenu={() => setSubscriptionMenuOpen((open) => !open)}
        onCloseSubscriptionMenu={() => setSubscriptionMenuOpen(false)}
        onAddSource={() => { closeSourceView(false); openAddSource() }}
        onImportOpml={() => void importOpml()}
        onOpenOpmlExport={() => { closeSourceView(false); setSubscriptionMenuOpen(false); setOpmlExportOpen(true) }}
      />
    )
  }

  const renderArticleListPane = (onChooseSourceScope?: () => void): React.JSX.Element => (
    <ArticleListPane
      destination={destination}
      articleScope={articleScope}
      activeScopeFeed={activeScopeFeed}
      scopeLabel={scopeLabel}
      scopeArticleCount={articleScope.kind === 'all' ? (librarySnapshot?.articles ?? scopedArticles.length) : scopedArticles.length}
      scopeUnreadCount={scopedUnreadCount}
      scopeStarredCount={scopedStarredCount}
      articleQuery={articleQuery}
      visibleArticles={visibleArticles}
      feeds={feeds}
      selectedArticleId={selectedArticleId}
      articleListError={articleListError}
      searchInputRef={articleSearchInputRef}
      refreshing={isRefreshingAll || refreshingFeedId === activeScopeFeed?.id}
      refreshDisabled={feeds.length === 0 || isRefreshingAll || refreshingFeedId !== null}
      onDestinationChange={(id) => { setArticleQuery(''); setDestination(id) }}
      onClearScope={() => { setArticleScope({ kind: 'all' }); setArticleQuery('') }}
      onArticleQueryChange={setArticleQuery}
      onRefresh={() => activeScopeFeed ? void refreshFeed(activeScopeFeed, undefined, 'article') : void refreshAllSources()}
      onSelectArticle={selectArticle}
      onToggleStarred={toggleStarred}
      onArticleContextMenu={(article, x, y) => setContextMenu({ kind: 'article', x, y, articleId: article.id })}
      onAddSource={openAddSource}
      onChooseSourceScope={onChooseSourceScope}
      sourceSwitcherTriggerRef={onChooseSourceScope ? sourceSwitcherTriggerRef : undefined}
      sourceSwitcherOpen={Boolean(onChooseSourceScope && sourceSwitcherOpen)}
    />
  )

  const closeReaderAiAssistant = (): void => {
    if (speech.state.domain === 'summary') speech.stop()
    setReaderAiPanel((current) => closeReaderAiPanel(current))
  }

  const renderReaderAiPanel = (): React.JSX.Element | null => {
    if (!readerAiPanel.open || !selectedArticle) return null

    const enabledChatProviders = chatAiSettings?.providers.filter((provider) => provider.enabled) ?? []
    const activeChatProviderId = chatConversation?.providerId ?? chatDraftProviderId
    const activeChatProvider = chatAiSettings?.providers.find((provider) => provider.id === activeChatProviderId) ?? null
    const activeChatModel = chatConversation?.model ?? chatDraftModel
    const chatModelLabel = [activeChatProvider?.name, activeChatModel].filter(Boolean).join(' · ') || t('defaultModel')
    const changeChatProvider = async (providerId: string): Promise<void> => {
      const provider = enabledChatProviders.find((item) => item.id === providerId)
      const nextModel = provider?.defaultModel || provider?.models[0] || ''
      setChatDraftProviderId(providerId)
      setChatDraftModel(nextModel)
      if (!chatConversation) return
      try {
        const updated = await window.origread.updateLlmConversation({
          conversationId: chatConversation.id,
          providerId,
          model: nextModel || null
        })
        setChatConversation(updated)
        setChatConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      } catch {
        setChatError(t('conversationModelUpdateFailed'))
      }
    }
    const changeChatModel = async (model: string): Promise<void> => {
      setChatDraftModel(model)
      if (!chatConversation) return
      try {
        const updated = await window.origread.updateLlmConversation({ conversationId: chatConversation.id, model: model || null })
        setChatConversation(updated)
        setChatConversations((current) => current.map((item) => item.id === updated.id ? updated : item))
      } catch {
        setChatError(t('conversationModelUpdateFailed'))
      }
    }

    if (readerAiPanel.detailView === 'sources') {
      const targetMessage = chatMessages.find((message) => message.id === readerAiPanel.detailTargetId && message.role === 'ASSISTANT') ?? null
      const focusedSource = readerAiSourceFocus?.messageId === targetMessage?.id ? readerAiSourceFocus : null
      return (
        <ReaderAiPanelShell
          view={readerAiPanel.view}
          detailView="sources"
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          leading={<Share2 size={17}/>}
          title={t('contextSources')}
          subtitle={targetMessage ? t('contextSourcesDescription') : chatConversation?.title || selectedArticle.title}
          actions={<button type="button" className="icon-button" title={t('back')} aria-label={t('back')} onClick={()=>{setReaderAiSourceFocus(null);setReaderAiPanel((current)=>closeReaderAiPanelDetail(current))}}><ArrowLeft size={15}/></button>}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onClose={closeReaderAiAssistant}
        >
          <ReaderAiSourcesDetailBody
            message={targetMessage}
            focusCitationId={focusedSource?.citationId ?? null}
            locationUnavailable={focusedSource?.locationUnavailable ?? false}
            onOpenCitation={(citation,snapshot)=>targetMessage ? void openReaderAiCitation(targetMessage.id,citation,snapshot) : undefined}
            onOpenExternal={(url)=>void openExternal(url)}
          />
        </ReaderAiPanelShell>
      )
    }

    if (readerAiPanel.detailView === 'web-search') {
      const targetMessage = chatMessages.find((message)=>message.id===readerAiPanel.detailTargetId&&message.role==='ASSISTANT')??null
      return (
        <ReaderAiPanelShell
          view={readerAiPanel.view}
          detailView="web-search"
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          leading={<Search size={17}/>}
          title={t('webSearchResults')}
          subtitle={targetMessage?.webSearchProviderName||chatConversation?.title||selectedArticle.title}
          actions={<button type="button" className="icon-button" title={t('back')} aria-label={t('back')} onClick={()=>setReaderAiPanel((current)=>closeReaderAiPanelDetail(current))}><ArrowLeft size={15}/></button>}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onClose={closeReaderAiAssistant}
        >
          <ReaderAiWebSearchDetailBody message={targetMessage}/>
        </ReaderAiPanelShell>
      )
    }

    if (readerAiPanel.detailView === 'chat-search') {
      return (
        <ReaderAiPanelShell
          view={readerAiPanel.view}
          detailView="chat-search"
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          leading={<Search size={17}/>}
          title={t('findInCurrentChat')}
          subtitle={chatConversation?.title || selectedArticle.title}
          actions={<button type="button" className="icon-button" title={t('back')} aria-label={t('back')} onClick={closeReaderAiChatSearch}><ArrowLeft size={15}/></button>}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onClose={closeReaderAiAssistant}
        >
          <ReaderAiChatSearchBody
            messages={chatMessages}
            inputRef={chatSearchInputRef}
            onOpenMessage={locateReaderAiChatMessage}
          />
        </ReaderAiPanelShell>
      )
    }

    if (readerAiPanel.detailView === 'conversation-history') {
      return (
        <ReaderAiPanelShell
          view={readerAiPanel.view}
          detailView="conversation-history"
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          leading={<History size={17}/>}
          title={t('conversationHistory')}
          subtitle={selectedArticle.title}
          actions={<>
            <button type="button" className="icon-button" title={t('back')} aria-label={t('back')} onClick={closeReaderAiConversationHistory}>
              <ArrowLeft size={15}/>
            </button>
            <button type="button" className="icon-button" title={t('newChat')} aria-label={t('newChat')} onClick={startNewReaderAiChat}>
              <Plus size={15}/>
            </button>
          </>}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onClose={closeReaderAiAssistant}
        >
          <ReaderAiConversationHistoryBody
            conversations={chatConversations}
            activeConversationId={readerAiPanel.conversationId}
            query={chatConversationHistoryQuery}
            loading={chatConversationHistoryLoading}
            error={chatConversationHistoryError}
            onQueryChange={setChatConversationHistoryQuery}
            onOpen={(conversation)=>void openReaderAiConversation(conversation)}
            onRename={(conversationId,title)=>renameReaderAiConversation(conversationId,title)}
            onDelete={(conversationId)=>deleteReaderAiConversation(conversationId)}
          />
        </ReaderAiPanelShell>
      )
    }

    if (readerAiPanel.view === 'summary' && (aiSummary || aiLoading)) {
      return (
        <AiSummaryView
          panelState={readerAiPanel}
          summary={aiSummary}
          loading={aiLoading}
          progressStage={aiSummaryProgress?.stage ?? null}
          streamUpdate={aiSummaryStream}
          elapsedSeconds={aiSummaryElapsedSeconds}
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          speechActive={speech.state.domain==='summary'}
          speechStatus={speech.state.status}
          onToggleSpeech={toggleSummarySpeech}
          onStopSpeech={speech.stop}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onRegenerate={()=>{if(!aiLoading)setAiOptionsOpen(true)}}
          onStop={stopAiSummary}
          onFirstVisibleValue={recordAiSummaryUiTtfv}
          onBackToHome={showReaderAiHome}
          onContinueChat={showReaderAiChat}
          onClose={closeReaderAiAssistant}
        />
      )
    }

    if (readerAiPanel.view === 'chat') {
      return (
        <ReaderAiPanelShell
          view="chat"
          detailView={readerAiPanel.detailView}
          placement={aiSummaryPlacement}
          panelSize={settings?.aiSummaryPanelSize ?? 360}
          leading={<AiSummaryAccentIcon variant="panel"/>}
          title={t('aiChat')}
          subtitle={chatConversation?.title || selectedArticle.title}
          actions={<>
            <button type="button" className="icon-button" title={t('backToAiHome')} aria-label={t('backToAiHome')} onClick={showReaderAiHome}>
              <ArrowLeft size={15}/>
            </button>
            <button type="button" className="icon-button" title={t('findInCurrentChat')} aria-label={t('findInCurrentChat')} disabled={!chatConversation} onClick={showReaderAiChatSearch}>
              <Search size={15}/>
            </button>
            <button type="button" className="icon-button" title={t('conversationHistory')} aria-label={t('conversationHistory')} disabled={Boolean(chatActiveRequestIdRef.current)} onClick={showReaderAiConversationHistory}>
              <History size={15}/>
            </button>
            <button type="button" className="icon-button" title={t('newChat')} aria-label={t('newChat')} onClick={startNewReaderAiChat}>
              <Plus size={15}/>
            </button>
          </>}
          onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
          onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
          onClose={closeReaderAiAssistant}
        >
          <ReaderAiChatBody
            messages={chatMessages}
            toolActivity={chatToolActivity}
            toolDecisionBusy={chatToolDecisionBusy}
            manualTools={chatManualTools}
            manualToolContexts={chatManualToolContexts}
            manualToolBusy={chatManualToolBusy}
            manualToolConversationReady={Boolean(chatConversation)}
            attachedArticles={chatAttachedArticles}
            currentArticleId={selectedArticle.id}
            summaryArtifact={aiSummary?.articleId === selectedArticle.id ? aiSummary : null}
            draft={chatDraft}
            selectionText={readerAiSelection?.articleId === selectedArticle.id ? readerAiSelection.text : null}
            selectionTruncated={readerAiSelection?.articleId === selectedArticle.id ? readerAiSelection.truncated : false}
            composerRef={chatComposerInputRef}
            quickMessages={chatQuickMessages}
            active={Boolean(chatActiveExecution || chatActiveRequestIdRef.current || chatManualToolBusy)}
            loading={chatHistoryLoading}
            error={chatError}
            modelLabel={chatModelLabel}
            providers={enabledChatProviders}
            providerId={activeChatProviderId ?? ''}
            model={activeChatModel ?? ''}
            forceWebSearchNext={chatForceWebSearchNext}
            locateMessageId={chatLocateMessageId}
            placeholder={t('askAboutArticle')}
            onDraftChange={setChatDraft}
            onClearSelection={()=>setReaderAiSelection(null)}
            onProviderChange={(providerId)=>void changeChatProvider(providerId)}
            onModelChange={(model)=>void changeChatModel(model)}
            onForceWebSearchNextChange={setChatForceWebSearchNext}
            onOpenWebSearch={(messageId)=>setReaderAiPanel((current)=>openReaderAiPanelDetail(current,'web-search',messageId))}
            onOpenSources={(messageId)=>openReaderAiSources(messageId)}
            onOpenCitation={(messageId,citation,snapshot)=>void openReaderAiCitation(messageId,citation,snapshot)}
            onSend={()=>void sendReaderAiChatMessage()}
            onQuickMessage={(message)=>void sendReaderAiQuickMessage(message)}
            onStop={stopReaderAiChat}
            onToolApproval={(toolCallId,decision)=>void resolveReaderAiToolApproval(toolCallId,decision)}
            onManualToolExecute={(toolId,argumentsJson)=>executeReaderAiManualTool(toolId,argumentsJson)}
            onDiscardManualToolContext={discardReaderAiManualToolContext}
            onAttachedArticlesChange={replaceReaderAiAttachedArticles}
            onRegenerate={(assistantMessageId)=>void regenerateReaderAiAssistant(assistantMessageId)}
            onLocateMessageHandled={()=>setChatLocateMessageId(null)}
          />
        </ReaderAiPanelShell>
      )
    }

    if (readerAiPanel.view !== 'home') return null

    return (
      <ReaderAiPanelShell
        view="home"
        detailView={null}
        placement={aiSummaryPlacement}
        panelSize={settings?.aiSummaryPanelSize ?? 360}
        leading={<AiSummaryAccentIcon variant="panel"/>}
        title={t('aiAssistant')}
        subtitle={selectedArticle.title}
        actions={<button type="button" className="icon-button" title={t('conversationHistory')} aria-label={t('conversationHistory')} disabled={Boolean(chatActiveRequestIdRef.current)} onClick={showReaderAiConversationHistory}><History size={15}/></button>}
        onPlacementChange={(placement)=>void changeReaderAiPanelPlacement(placement)}
        onPanelSizeChange={(size)=>void updateDesktopSettings({aiSummaryPanelSize:size})}
        onClose={closeReaderAiAssistant}
      >
        <ReaderAiChatBody
          messages={[]}
          toolActivity={[]}
          toolDecisionBusy={{}}
          manualTools={chatManualTools}
          manualToolContexts={[]}
          manualToolBusy={chatManualToolBusy}
          manualToolConversationReady={false}
          attachedArticles={chatAttachedArticles}
          currentArticleId={selectedArticle.id}
          summaryArtifact={null}
          draft={chatDraft}
          selectionText={readerAiSelection?.articleId === selectedArticle.id ? readerAiSelection.text : null}
          selectionTruncated={readerAiSelection?.articleId === selectedArticle.id ? readerAiSelection.truncated : false}
          composerRef={chatComposerInputRef}
          quickMessages={chatQuickMessages}
          active={Boolean(chatActiveExecution || chatActiveRequestIdRef.current || chatManualToolBusy)}
          loading={chatHistoryLoading}
          error={chatError}
          modelLabel={chatModelLabel}
          providers={enabledChatProviders}
          providerId={activeChatProviderId ?? ''}
          model={activeChatModel ?? ''}
          forceWebSearchNext={chatForceWebSearchNext}
          placeholder={t('askAboutArticle')}
          emptyContent={<div className="reader-ai-home">
            <div className="reader-ai-home-intro">
              <strong>{t('aiAssistantHomeTitle')}</strong>
              <span>{t('aiAssistantHomeDescription')}</span>
            </div>
            <div className="reader-ai-home-actions">
              <section className="reader-ai-home-action reader-ai-summary-action" aria-labelledby="reader-ai-summary-action-title">
                <div className="reader-ai-summary-action-head">
                  <AiSummaryAccentIcon variant="panel" loading={aiLoading}/>
                  <span>
                    <strong id="reader-ai-summary-action-title">{t('quickSummary')}</strong>
                    <small>{t('quickSummaryDescription')}</small>
                  </span>
                </div>
                {aiSummary ? <div className="reader-ai-summary-existing">{t('summaryAvailable', { length: t(summaryLengthLabelKey(aiSummary.length)) })}</div> : null}
                <div className="reader-ai-summary-length-actions" role="group" aria-label={t('summaryLengthActions')}>
                  {([
                    ['BRIEF', 'summaryModeQuick'],
                    ['STANDARD', 'summaryModeBalanced'],
                    ['DETAILED', 'summaryModeDeep']
                  ] as const).map(([length, labelKey]) => (
                    <button
                      type="button"
                      key={length}
                      className="reader-ai-summary-length-action"
                      disabled={aiLoading}
                      title={t('generateSummaryLength', { length: t(labelKey) })}
                      aria-label={t('generateSummaryLength', { length: t(labelKey) })}
                      onClick={() => openQuickSummary(length)}
                    >
                      {t(labelKey)}
                    </button>
                  ))}
                </div>
              </section>
              <button
                type="button"
                className="reader-ai-home-action reader-ai-analysis-action"
                disabled={Boolean(chatActiveExecution || chatActiveRequestIdRef.current || chatManualToolBusy)}
                onClick={()=>void sendReaderAiChatMessage(t('articleAnalysisRequest'), 'ARTICLE_ANALYSIS')}
              >
                <span className="reader-ai-home-action-icon"><Sparkles size={17}/></span>
                <span>
                  <strong>{t('articleAnalysis')}</strong>
                  <small>{t('articleAnalysisDescription')}</small>
                </span>
              </button>
            </div>
          </div>}
          onDraftChange={setChatDraft}
          onClearSelection={()=>setReaderAiSelection(null)}
          onProviderChange={(providerId)=>void changeChatProvider(providerId)}
          onModelChange={(model)=>void changeChatModel(model)}
          onForceWebSearchNextChange={setChatForceWebSearchNext}
          onOpenWebSearch={(messageId)=>setReaderAiPanel((current)=>openReaderAiPanelDetail(current,'web-search',messageId))}
          onOpenSources={(messageId)=>openReaderAiSources(messageId)}
          onOpenCitation={(messageId,citation,snapshot)=>void openReaderAiCitation(messageId,citation,snapshot)}
          onSend={()=>void sendReaderAiChatMessage()}
          onQuickMessage={(message)=>void sendReaderAiQuickMessage(message)}
          onStop={stopReaderAiChat}
          onRegenerate={(assistantMessageId)=>void regenerateReaderAiAssistant(assistantMessageId)}
          onToolApproval={()=>undefined}
          onManualToolExecute={(toolId,argumentsJson)=>executeReaderAiManualTool(toolId,argumentsJson)}
          onDiscardManualToolContext={discardReaderAiManualToolContext}
          onAttachedArticlesChange={replaceReaderAiAttachedArticles}
        />
      </ReaderAiPanelShell>
    )
  }

  return (
    <main
      className={`app-shell ${twoPaneLayout ? 'two-pane-layout' : 'three-pane-layout'} ${focusReading ? 'focus-reading' : ''} ${!twoPaneLayout && adaptiveSourceHidden ? 'adaptive-source-hidden' : ''} ${!twoPaneLayout && compactLayout ? 'compact-layout' : ''} ${effectiveWorkspaceCollapsed ? 'workspace-pane-collapsed' : ''} ${effectiveSourcePaneCollapsed ? 'source-pane-collapsed' : ''} ${effectiveArticlePaneCollapsed ? 'article-pane-collapsed' : ''}`}
      style={readerStyle}
      data-viewport-width={viewportWidth}
      data-layout-mode={layoutMode}
      data-source-switcher-open={sourceSwitcherOpen ? 'true' : 'false'}
      data-source-switcher-recent-count={recentSourceScopeKeys.length}
      data-source-manager-open={sourceManagerOpen ? 'true' : 'false'}
    >
      {twoPaneLayout ? (
        <TwoPaneReadingLayout
          workspaceHeader={renderSourceBrandHeader()}
          workspaceContent={renderArticleListPane(toggleSourceSwitcher)}
          workspaceOverlay={sourceManagerOpen ? (
            <SourceManagerOverlay
              title={t('sourceManagerTitle')}
              closeLabel={t('close')}
              closeButtonRef={sourceManagerCloseRef}
              onClose={() => closeSourceManager(true)}
            >
              {renderSourceSidebar({ sourceManager: true })}
            </SourceManagerOverlay>
          ) : sourceSwitcherOpen ? (
            <SourceSwitcherPopover
              triggerRef={sourceSwitcherTriggerRef}
              searchInputRef={sourceSwitcherSearchInputRef}
              query={sourceSwitcherQuery}
              groups={groups}
              feeds={feeds}
              feedStatsById={feedStatsById}
              articleScope={articleScope}
              recentScopeKeys={recentSourceScopeKeys}
              collapsedGroupIds={collapsedSourceSwitcherGroupIds}
              allArticleCount={librarySnapshot?.articles ?? articles.length}
              allUnreadCount={librarySnapshot?.unread ?? articles.filter((article) => article.isUnread).length}
              onQueryChange={setSourceSwitcherQuery}
              onSelectAll={() => {
                setArticleScope({ kind: 'all' })
                setArticleQuery('')
                closeSourceSwitcher(true)
              }}
              onSelectGroup={(group) => {
                selectGroupScope(group)
                closeSourceSwitcher(true)
              }}
              onToggleGroupCollapsed={(groupId) => setCollapsedSourceSwitcherGroupIds((current) => {
                const next = new Set(current)
                if (next.has(groupId)) next.delete(groupId)
                else next.add(groupId)
                return next
              })}
              onSelectFeed={(feed) => {
                selectFeedScope(feed)
                closeSourceSwitcher(true)
              }}
              onManageSources={openSourceManager}
              onRequestClose={closeSourceSwitcher}
            />
          ) : undefined}
          workspaceAriaLabel={t('layoutModeTwoPane')}
          width={settings?.workspaceWidth ?? 420}
          minWidth={WORKSPACE_PANE_WIDTH_MIN}
          maxWidth={WORKSPACE_PANE_WIDTH_MAX}
          collapsed={effectiveWorkspaceCollapsed}
          focusReading={focusReading}
          resizeLabel={t('resizeWorkspace')}
          collapseLabel={t('collapseWorkspace')}
          expandLabel={t('expandWorkspace')}
          exitFocusLabel={t('exitFocusReading')}
          onResize={previewWorkspaceWidth}
          onResizeEnd={(width) => void updateDesktopSettings({ workspaceWidth: width })}
          onToggleCollapsed={toggleWorkspacePane}
        />
      ) : (
        <>
          {!effectiveSourcePaneCollapsed && renderSourceSidebar()}

          <PaneDivider
            kind="source"
            width={settings?.sourcePaneWidth ?? 260}
            minWidth={SOURCE_PANE_WIDTH_MIN}
            maxWidth={SOURCE_PANE_WIDTH_MAX}
            ariaLabel={t('resizeSourcePane')}
            resizable={!effectiveSourcePaneCollapsed}
            collapsed={effectiveSourcePaneCollapsed}
            onResize={previewSourcePaneWidth}
            onResizeEnd={(width) => void updateDesktopSettings({ sourcePaneWidth: width })}
          >
            {!effectiveSourcePaneCollapsed && !showArticleBoundarySplit && (
              <button
                className="collapse-handle"
                type="button"
                aria-label={t('collapseSourcePane')}
                title={t('collapseSourcePane')}
                onClick={toggleSourcePane}
              >
                <ChevronLeft size={15} />
              </button>
            )}
          </PaneDivider>

          {!effectiveArticlePaneCollapsed && renderArticleListPane()}

          <PaneDivider
            kind="article"
            width={settings?.articlePaneWidth ?? 380}
            minWidth={ARTICLE_PANE_WIDTH_MIN}
            maxWidth={ARTICLE_PANE_WIDTH_MAX}
            ariaLabel={t('resizeArticlePane')}
            resizable={!effectiveArticlePaneCollapsed && !compactLayout}
            collapsed={effectiveArticlePaneCollapsed}
            onResize={previewArticlePaneWidth}
            onResizeEnd={(width) => void updateDesktopSettings({ articlePaneWidth: width })}
          >
            {!effectiveArticlePaneCollapsed && (
              <button
                className="collapse-handle"
                type="button"
                aria-label={t('collapseArticlePane')}
                title={t('collapseArticlePane')}
                onClick={toggleArticlePane}
              >
                <ChevronLeft size={15} />
              </button>
            )}
          </PaneDivider>

          {showArticleBoundarySplit && (
            <div className="pane-split-handle" data-pane-boundary="source-article">
              <button
                className="pane-split-action pane-split-collapse-source"
                type="button"
                aria-label={t('collapseSourcePane')}
                title={t('collapseSourcePane')}
                onClick={toggleSourcePane}
              >
                <ChevronLeft size={13} />
              </button>
              <button
                className="pane-split-action pane-split-expand-article"
                type="button"
                aria-label={t('expandArticlePane')}
                title={t('expandArticlePane')}
                onClick={toggleArticlePane}
              >
                <ChevronRight size={13} />
              </button>
            </div>
          )}

          {effectiveSourcePaneCollapsed && (
            <button
              className={`collapsed-pane-restore restore-at-start ${collapsedPaneCount > 1 ? 'double' : ''}`}
              type="button"
              data-hidden-count={collapsedPaneCount}
              aria-label={collapsedPaneRestoreLabel}
              title={collapsedPaneRestoreLabel}
              onClick={restoreCollapsedPaneLayer}
            >
              <ChevronRight size={14} />
              {collapsedPaneCount > 1 && <ChevronRight size={14} />}
            </button>
          )}
        </>
      )}

      <section className="reader-pane" ref={readerPaneRef}>
        <header className="reader-toolbar">
          {(settingsOpen || sourceCatalogOpen || originalViewState.open) && (
            <div className="reader-title">
              {settingsOpen ? t('settings') : sourceCatalogOpen ? t('sourceDiscoveryTitle') : (originalViewState.title || t('original'))}
            </div>
          )}
          <div className="reader-actions">
            {!settingsOpen && !sourceCatalogOpen && (
              <button
                type="button"
                className={`icon-button focus-reading-button ${focusReading ? 'active' : ''}`}
                aria-label={focusReading ? t('exitFocusReading') : t('focusReading')}
                title={`${focusReading ? t('exitFocusReading') : t('focusReading')} ([)`}
                onClick={toggleFocusReading}
              >
                {focusReading ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
            )}
            {settingsOpen ? (
              <button type="button" className="settings-close-button" aria-label={t('closeSettings')} title={t('closeSettings')} onClick={() => { closeSettingsIfAllowed() }}>
                <X size={17} /><span>{t('closeSettings')}</span>
              </button>
            ) : sourceCatalogOpen ? (
              <button type="button" className="settings-close-button" aria-label={t('back')} title={t('back')} onClick={() => setSourceCatalogOpen(false)}>
                <X size={17} /><span>{t('back')}</span>
              </button>
            ) : originalViewState.open ? (
              <>
                <button type="button" className="icon-button" disabled={!originalViewState.canGoBack} aria-label={t('back')} title={t('back')} onClick={() => void navigateOriginalArticle('back')}>
                  <ArrowLeft size={17} />
                </button>
                <button type="button" className="icon-button" disabled={!originalViewState.canGoForward} aria-label={t('forward')} title={t('forward')} onClick={() => void navigateOriginalArticle('forward')}>
                  <ArrowRight size={17} />
                </button>
                <button type="button" className="icon-button" aria-label={t('refresh')} title={t('refresh')} onClick={() => void navigateOriginalArticle('reload')}>
                  <RefreshCw size={16} className={originalViewState.loading ? 'spinning' : ''} />
                </button>
                <button type="button" disabled={!originalViewState.url} aria-label={t('externalBrowser')} title={t('externalBrowser')} onClick={() => originalViewState.url && void openExternal(originalViewState.url)}>
                  <ExternalLink size={17} /><span>{t('externalBrowser')}</span>
                </button>
                <button type="button" className="reader-mode-button" aria-label={t('backToReader')} title={t('backToReader')} onClick={() => void closeOriginalArticle()}>
                  <BookOpenText size={17} /><span>{t('backToReader')}</span>
                </button>
              </>
            ) : (
              <>
                <div className={`reader-tool-split reader-tool-split-ai ${aiOptionsOpen ? 'options-open' : ''}`}>
                  <button
                    type="button"
                    className={`ai-summary-button reader-tool-split-main ${readerAiPanelActive ? 'active' : ''}`}
                    disabled={!selectedArticle || readerToolLoading !== null}
                    title={`${t('aiAssistant')} (A)`}
                    aria-label={t('aiAssistant')}
                    onClick={toggleReaderAiAssistant}
                  >
                    <AiSummaryAccentIcon variant="toolbar" loading={readerToolLoading === 'ai'} />
                    <span>{t('aiAssistantShort')}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button reader-tool-options reader-tool-split-options"
                    disabled={!selectedArticle || readerToolLoading !== null}
                    title={t('aiSummaryOptions')}
                    aria-label={t('aiSummaryOptions')}
                    aria-haspopup="dialog"
                    aria-expanded={aiOptionsOpen}
                    onClick={()=>setAiOptionsOpen(true)}
                  >
                    <ChevronDown size={13}/>
                  </button>
                </div>
                <div className={`reader-tool-split reader-tool-split-translation ${translationTargetOpen ? 'options-open' : ''}`}>
                  <button
                    type="button"
                    className={`translation-button reader-tool-split-main ${readerMode === 'translation' ? 'active' : ''}`}
                    disabled={!selectedArticle || readerToolLoading !== null}
                    title={t('translation')}
                    aria-label={t('translation')}
                    onClick={() => readerMode === 'translation' ? setReaderMode('article') : translationDocument ? setReaderMode('translation') : void translateSelectedArticle()}
                  >
                    {readerToolLoading === 'translation' ? <RefreshCw size={17} className="spinning" /> : <Languages size={18} />}
                    <span>{t('translation')}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button reader-tool-options reader-tool-split-options"
                    disabled={!selectedArticle || readerToolLoading !== null}
                    title={t('translationTarget')}
                    aria-label={t('translationTarget')}
                    aria-haspopup="dialog"
                    aria-expanded={translationTargetOpen}
                    onClick={()=>setTranslationTargetOpen(true)}
                  >
                    <ChevronDown size={13}/>
                  </button>
                </div>
                <button type="button" className={`icon-button ${selectedArticle?.isStarred ? 'active' : ''}`} disabled={!selectedArticle} title={selectedArticle?.isStarred?t('unstar'):t('starArticle')} aria-label={selectedArticle?.isStarred?t('unstar'):t('starArticle')} onClick={()=>selectedArticle&&toggleStarred(selectedArticle)}><Star size={16} fill={selectedArticle?.isStarred?'currentColor':'none'}/></button>
                {readerMoreOpen && (
                  <button
                    type="button"
                    className="reader-more-backdrop"
                    aria-label={t('close')}
                    onClick={() => {
                      setReaderMoreOpen(false)
                      window.requestAnimationFrame(() => readerMoreButtonRef.current?.focus())
                    }}
                  />
                )}
                <div ref={readerSecondaryActionsRef} id="reader-secondary-actions" className={`reader-secondary-actions ${readerMoreOpen ? 'open' : ''}`} aria-label={t('more')}>
                  <button type="button" className={`icon-button reader-secondary-action ${selectedArticle?.isUnread ? 'active' : ''}`} disabled={!selectedArticle} title={selectedArticle?.isUnread?t('markRead'):t('markUnread')} aria-label={selectedArticle?.isUnread?t('markRead'):t('markUnread')} onClick={()=>{setReaderMoreOpen(false);selectedArticle&&toggleUnread(selectedArticle)}}><BookOpenText size={16}/><span>{selectedArticle?.isUnread?t('markRead'):t('markUnread')}</span></button>
                  <button type="button" className="icon-button reader-secondary-action reader-next-article-button" disabled={!nextArticle} title={t('nextArticle')} aria-label={t('nextArticle')} onClick={()=>{setReaderMoreOpen(false);nextArticle&&selectArticle(nextArticle)}}><StepForward size={17}/><span>{t('nextArticle')}</span></button>
                  <button type="button" className={`icon-button reader-secondary-action reader-tts-button ${speech.state.domain==='main'?'active':''}`} disabled={!selectedArticle||!mainSpeechText} title={speech.state.domain==='main'&&speech.state.status==='speaking'?t('pauseReading'):speech.state.domain==='main'&&speech.state.status==='paused'?t('resumeReading'):t('readArticle')} aria-label={t('readArticle')} onClick={()=>{setReaderMoreOpen(false);toggleMainSpeech()}}>
                    {speech.state.domain==='main'&&speech.state.status==='speaking'
                      ? <Pause size={16}/>
                      : speech.state.domain==='main'&&speech.state.status==='paused'
                        ? <Play size={16}/>
                        : <Headphones size={16}/>
                    }
                    <span>{speech.state.domain==='main'&&speech.state.status==='speaking'?t('pauseReading'):speech.state.domain==='main'&&speech.state.status==='paused'?t('resumeReading'):t('readArticle')}</span>
                  </button>
                  {speech.state.status!=='idle'&&<button type="button" className="icon-button reader-secondary-action reader-tts-stop" title={t('stopReading')} aria-label={t('stopReading')} onClick={()=>{setReaderMoreOpen(false);speech.stop()}}><Square size={14}/><span>{t('stopReading')}</span></button>}
                  <label className="reader-voice-control" title={t('readingVoice')}>
                    <span className="reader-voice-compact"><Volume2 size={16}/><span>{t('readingVoice')}</span></span>
                    <select className="reader-voice-select" value={settings?.ttsVoiceURI??''} aria-label={t('readingVoice')} onChange={(event)=>{setReaderMoreOpen(false);void updateDesktopSettings({ttsVoiceURI:event.target.value})}}>
                      <option value="">{t('systemDefaultVoice')}</option>
                      {speech.voices.map((voice)=><option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`full-content-button reader-secondary-action ${readerContent?.mode === 'full' ? 'active' : ''}`}
                    disabled={!selectedArticle || !originalUrl || readerContentLoading}
                    title={readerContent?.mode === 'full' ? t('feedContent') : t('fullContent')}
                    aria-label={readerContent?.mode === 'full' ? t('feedContent') : t('fullContent')}
                    onClick={() => {setReaderMoreOpen(false);void toggleFullContent()}}
                  >
                    <BookOpenText size={17} /><span>{readerContent?.mode === 'full' ? t('feedContent') : t('fullContent')}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button reading-share-button reader-secondary-action"
                    disabled={!selectedArticle}
                    title={t('share')}
                    aria-label={t('share')}
                    onClick={()=>{setReaderMoreOpen(false);handleReadingShareClick()}}
                    onContextMenu={handleReadingShareContextMenu}
                  >
                    <Share2 size={17} /><span>{t('share')}</span>
                  </button>
                </div>
                <button
                  type="button"
                  className="icon-button original-button"
                  disabled={!originalUrl}
                  onClick={() => void showOriginalArticle()}
                  title={t('original')}
                  aria-label={t('original')}
                >
                  <SquareArrowOutUpRight size={17} />
                </button>
                <button
                  type="button"
                  ref={readerMoreButtonRef}
                  className={`icon-button reader-more-button ${readerMoreOpen ? 'active' : ''}`}
                  aria-label={t('more')}
                  title={t('more')}
                  aria-controls="reader-secondary-actions"
                  aria-expanded={readerMoreOpen}
                  onClick={() => setReaderMoreOpen((open)=>!open)}
                >
                  <MoreHorizontal size={17}/>
                </button>
              </>
            )}
          </div>
          {!settingsOpen && !sourceCatalogOpen && (
            <div className="reader-fixed-actions">
              <button type="button" className="icon-button settings-button" aria-label={t('settings')} title={t('settings')} onClick={() => void showSettings()}>
                <Settings size={17} />
              </button>
            </div>
          )}
          {readingShareStatus && (
            <div className={`reading-share-status ${readingShareStatus.kind}`} role="status" aria-live="polite">
              {readingShareStatus.message}
            </div>
          )}
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
              onUnsavedChange={setSettingsUnsaved}
              onConfigurationRestored={() => void handleConfigurationRestored()}
              onAccountChanged={() => void handleAccountChanged()}
            />
          </>
        ) : sourceCatalogOpen ? (
          <SourceDiscoveryPanel onSubscribe={(feed)=>void subscribeCatalogFeed(feed)}/>
        ) : selectedArticle ? (
          <div className={`reader-composite ${readerAiPanelDocked ? `summary-docked summary-${aiSummaryPlacement}` : ''}`}>
          <div
            ref={readerContentRef}
            className={`reader-content reader-mode-${readerMode}`}
            onMouseUp={captureReaderOriginalSelection}
            onKeyUp={captureReaderOriginalSelection}
            onScroll={()=>{setReaderAiSelectionCandidate(null);clearReaderCitationHighlight()}}
          >
            {readerSearchOpen && (
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
            {readerMode === 'translation' && translationDocument ? (
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
          {readerAiSelectionCandidate?.articleId === selectedArticle.id ? (
            <button
              type="button"
              className={`reader-ai-selection-action placement-${readerAiSelectionCandidate.placement}`}
              style={{ left: readerAiSelectionCandidate.x, top: readerAiSelectionCandidate.y }}
              aria-label={t('askSelectedText')}
              title={t('askSelectedText')}
              onPointerDown={(event)=>event.preventDefault()}
              onClick={attachReaderSelectionToAi}
            >
              <Sparkles size={13}/><span>{t('askSelectedText')}</span>
            </button>
          ) : null}
          {readerAiPanelDocked && renderReaderAiPanel()}
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
                  <span><kbd>A</kbd>{t('shortcutAiAssistant')}</span>
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

      {globalSearchOpen && (
        <GlobalSearchDialog
          results={globalSearchResults}
          loading={globalSearchLoading}
          error={globalSearchError}
          onSearch={searchCachedArticles}
          onClose={closeGlobalSearch}
          onSelect={(result) => void selectGlobalSearchResult(result)}
        />
      )}

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
      {readingShareDialog && (
        <ReadingShareDialog
          mode={readingShareDialog}
          preference={readingSharePreference}
          onClose={() => setReadingShareDialog(null)}
          onUseDefault={() => {
            void saveReadingSharePreference({ ...DEFAULT_READING_SHARE_PREFERENCE, configured: true }, true)
          }}
          onCustomize={() => setReadingShareDialog('config')}
          onSave={(preference) => {
            void saveReadingSharePreference(preference)
          }}
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
      {!twoPaneLayout && adaptiveSourceHidden && adaptiveSourceOverlayOpen && !focusReading && !sourcePaneCollapsed && (
        <div
          className="adaptive-source-overlay-backdrop"
          role="presentation"
          onPointerDown={() => { setAdaptiveSourceOverlayOpen(false); setSubscriptionMenuOpen(false) }}
        >
          <aside
            className="adaptive-source-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t('allSources')}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              ref={adaptiveSourceOverlayCloseRef}
              type="button"
              className="icon-button adaptive-source-overlay-close"
              aria-label={t('close')}
              title={t('close')}
              onClick={() => { setAdaptiveSourceOverlayOpen(false); setSubscriptionMenuOpen(false) }}
            >
              <X size={17} />
            </button>
            {renderSourceSidebar({ overlay: true })}
          </aside>
        </div>
      )}
    </main>
  )
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

function ReaderAiConversationHistoryBody({
  conversations,
  activeConversationId,
  query,
  loading,
  error,
  onQueryChange,
  onOpen,
  onRename,
  onDelete
}: {
  conversations: LlmConversationRecord[]
  activeConversationId: string | null
  query: string
  loading: boolean
  error: string | null
  onQueryChange(value: string): void
  onOpen(conversation: LlmConversationRecord): void
  onRename(conversationId: string, title: string): Promise<void>
  onDelete(conversationId: string): Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = normalizedQuery
    ? conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(normalizedQuery))
    : conversations
  const locale = i18n.resolvedLanguage?.startsWith('zh') ? 'zh-CN' : 'en-US'

  const beginRename = (conversation: LlmConversationRecord): void => {
    setPendingDeleteId(null)
    setActionError(null)
    setEditingId(conversation.id)
    setEditingTitle(conversation.title)
  }

  const submitRename = async (conversationId: string): Promise<void> => {
    const title = editingTitle.trim()
    if (!title || busyId) return
    setBusyId(conversationId)
    setActionError(null)
    try {
      await onRename(conversationId, title)
      setEditingId(null)
      setEditingTitle('')
    } catch {
      setActionError(t('conversationRenameFailed'))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async (conversationId: string): Promise<void> => {
    if (pendingDeleteId !== conversationId) {
      setEditingId(null)
      setPendingDeleteId(conversationId)
      setActionError(null)
      return
    }
    if (busyId) return
    setBusyId(conversationId)
    try {
      await onDelete(conversationId)
      setPendingDeleteId(null)
    } catch {
      setActionError(t('conversationDeleteFailed'))
    } finally {
      setBusyId(null)
    }
  }

  return <div className="reader-ai-conversation-history">
    <label className="reader-ai-history-search">
      <Search size={14}/>
      <input value={query} onChange={(event)=>onQueryChange(event.target.value)} placeholder={t('searchConversations')} aria-label={t('searchConversations')}/>
    </label>
    {loading ? <div className="reader-ai-chat-state"><RefreshCw size={15} className="spinning"/><span>{t('loadingConversationHistory')}</span></div> : null}
    {error ? <div className="reader-ai-chat-error" role="alert">{error}</div> : null}
    {actionError ? <div className="reader-ai-chat-error" role="alert">{actionError}</div> : null}
    {!loading && visible.length === 0 ? <div className="reader-ai-history-empty">{t(normalizedQuery ? 'noMatchingConversations' : 'noConversationsYet')}</div> : null}
    <div className="reader-ai-history-list">
      {visible.map((conversation) => {
        const editing = editingId === conversation.id
        const deleting = pendingDeleteId === conversation.id
        const busy = busyId === conversation.id
        return <div className={`reader-ai-history-item ${conversation.id === activeConversationId ? 'active' : ''}`} key={conversation.id}>
          {editing ? <form className="reader-ai-history-edit" onSubmit={(event)=>{event.preventDefault();void submitRename(conversation.id)}}>
            <input autoFocus value={editingTitle} maxLength={120} onChange={(event)=>setEditingTitle(event.target.value)} aria-label={t('conversationTitle')}/>
            <button type="submit" disabled={!editingTitle.trim() || busy}>{t('save')}</button>
            <button type="button" onClick={()=>setEditingId(null)}>{t('cancel')}</button>
          </form> : <button type="button" className="reader-ai-history-main" onClick={()=>onOpen(conversation)}>
            <span className="reader-ai-history-title">{conversation.title}</span>
            <span className="reader-ai-history-meta">
              {conversation.id === activeConversationId ? <strong>{t('currentConversation')}</strong> : null}
              <span>{new Date(conversation.updatedAt).toLocaleString(locale)}</span>
            </span>
          </button>}
          {!editing ? <div className="reader-ai-history-actions">
            <button type="button" className="icon-button" title={t('rename')} aria-label={t('rename')} disabled={busy} onClick={()=>beginRename(conversation)}><Pencil size={13}/></button>
            <button type="button" className={`reader-ai-history-delete ${deleting ? 'confirm' : ''}`} disabled={busy} onClick={()=>void confirmDelete(conversation.id)}>{deleting ? t('confirmDelete') : <Trash2 size={13}/>}</button>
          </div> : null}
        </div>
      })}
    </div>
  </div>
}

function ReaderAiChatSearchBody({
  messages,
  inputRef,
  onOpenMessage
}: {
  messages: LlmMessageRecord[]
  inputRef: RefObject<HTMLInputElement | null>
  onOpenMessage(messageId: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchReaderAiChatMessages(messages, query), [messages, query])
  const hasQuery = Boolean(query.trim())

  return <div className="reader-ai-chat-search">
    <label className="reader-ai-chat-search-input-wrap">
      <Search size={14}/>
      <input
        ref={inputRef}
        className="reader-ai-chat-search-input"
        autoFocus
        value={query}
        placeholder={t('searchCurrentChat')}
        aria-label={t('searchCurrentChat')}
        onChange={(event)=>setQuery(event.target.value)}
        onKeyDown={(event)=>{
          if (event.key === 'Enter' && results[0]) {
            event.preventDefault()
            onOpenMessage(results[0].messageId)
          }
        }}
      />
    </label>
    {hasQuery ? <div className="reader-ai-chat-search-count">{t('chatSearchResults', { count: results.length })}</div> : null}
    {hasQuery && results.length === 0 ? <div className="reader-ai-chat-search-empty">{t('noMatchingMessages')}</div> : null}
    <div className="reader-ai-chat-search-results">
      {results.map((result)=><button
        type="button"
        className="reader-ai-chat-search-result"
        key={result.messageId}
        onClick={()=>onOpenMessage(result.messageId)}
      >
        <span className="reader-ai-chat-search-role">{t(result.role === 'USER' ? 'chatRoleYou' : 'chatRoleAssistant')}</span>
        <span className="reader-ai-chat-search-snippet">{result.snippet}</span>
      </button>)}
    </div>
  </div>
}

function ReaderAiWebSearchActivity({message,onOpen}:{message:LlmMessageRecord;onOpen():void}):React.JSX.Element|null{
  const {t}=useTranslation()
  const status=message.webSearchStatus
  if(!status||status==='NOT_NEEDED')return null
  const label=status==='TRIGGERED'?t('webSearchSearching')
    :status==='SUCCESS'?t('webSearchSucceeded')
    :status==='EMPTY_RESULT'?t('webSearchEmpty')
    :status==='FAILED_FALLBACK'?t('webSearchFailedFallback')
    :status==='FAILED_REQUIRED'?t('webSearchFailedRequired')
    :t('webSearchCancelled')
  const count=status==='SUCCESS'&&message.webSearchResultCount!=null?t('webSearchResultCount',{count:message.webSearchResultCount}):null
  return <div className={`reader-ai-web-search-activity status-${status.toLowerCase()}`}>
    <div className="reader-ai-web-search-activity-head">
      <span className="reader-ai-web-search-activity-label">{status==='TRIGGERED'?<RefreshCw size={12} className="spinning"/>:<Search size={12}/>}<strong>{label}</strong></span>
      {status==='SUCCESS'&&(message.webSearchResultCount??0)>0?<button type="button" className="reader-ai-message-action" onClick={onOpen}>{t('webSearchViewResults')}</button>:null}
    </div>
    <div className="reader-ai-web-search-activity-meta">
      {message.webSearchQuery?<span title={message.webSearchQuery}>{message.webSearchQuery}</span>:null}
      <small>{[message.webSearchProviderName,count].filter(Boolean).join(' · ')}</small>
      {(status==='FAILED_FALLBACK'||status==='FAILED_REQUIRED')&&message.webSearchErrorMessage?<small className="error">{message.webSearchErrorMessage}</small>:null}
    </div>
  </div>
}

function ReaderAiWebSearchDetailBody({message}:{message:LlmMessageRecord|null}):React.JSX.Element{
  const {t}=useTranslation()
  const [snapshot,setSnapshot]=useState<LlmAssistantEvidenceSnapshot|null>(null)
  const [error,setError]=useState<string|null>(null)
  useEffect(()=>{
    if(!message)return
    let cancelled=false
    setSnapshot(null);setError(null)
    void window.origread.getLlmAssistantEvidence(message.id)
      .then((value)=>{if(!cancelled)setSnapshot(value)})
      .catch((reason)=>{if(!cancelled)setError(reason instanceof Error?reason.message:String(reason))})
    return()=>{cancelled=true}
  },[message?.id])
  if(!message)return <div className="reader-ai-chat-state"><span>{t('webSearchResultsUnavailable')}</span></div>
  const refs=snapshot?.contextRefs.filter((ref)=>ref.type==='WEB_SEARCH_RESULT')??[]
  return <div className="reader-ai-web-search-detail">
    <div className="reader-ai-web-search-detail-summary">
      {message.webSearchQuery?<div><span>{t('webSearchQuery')}</span><strong>{message.webSearchQuery}</strong></div>:null}
      {message.webSearchProviderName?<div><span>{t('webSearchProvider')}</span><strong>{message.webSearchProviderName}</strong></div>:null}
      <div><span>{t('webSearchResultCountLabel')}</span><strong>{message.webSearchResultCount??refs.length}</strong></div>
    </div>
    {error?<div className="reader-ai-chat-error" role="alert">{error}</div>:null}
    {!snapshot&&!error?<div className="reader-ai-chat-state"><RefreshCw size={14} className="spinning"/><span>{t('loading')}</span></div>:null}
    {snapshot&&refs.length===0?<div className="reader-ai-history-empty">{t('webSearchResultsUnavailable')}</div>:null}
    <div className="reader-ai-web-search-results">
      {refs.map((ref,index)=>{
        const url=ref.sourceUrl??ref.sourceId
        const domain=webSearchDomain(url)
        const usage=ref.includedInPrompt?(ref.truncatedInPrompt?'USED_TRUNCATED':'USED'):'OMITTED'
        return <article className="reader-ai-web-search-result" key={ref.id}>
          <div className="reader-ai-web-search-result-head"><span className="reader-ai-web-search-result-index">{index+1}</span><div><strong>{ref.title||domain||url||t('webSearchUntitledResult')}</strong>{domain?<small>{domain}</small>:null}</div><span className={`reader-ai-web-search-usage usage-${usage.toLowerCase()}`}>{t(`webSearchUsage${usage}`)}</span></div>
          <p>{webSearchResultSnippet(ref.contentSnapshot)}</p>
          {url?<button type="button" className="reader-ai-web-search-open" onClick={()=>void window.origread.openExternalUrl(url)}><ExternalLink size={12}/>{t('openLink')}</button>:null}
        </article>
      })}
    </div>
  </div>
}

function ReaderAiAssistantAnswer({
  message,
  onOpenSources,
  onOpenCitation
}: {
  message: LlmMessageRecord
  onOpenSources(messageId: string): void
  onOpenCitation(messageId: string, citation: LlmCitationRefRecord, snapshot: LlmAssistantEvidenceSnapshot): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LlmAssistantEvidenceSnapshot | null>(null)

  useEffect(() => {
    if (message.status === 'STREAMING') {
      setSnapshot(null)
      return
    }
    let cancelled = false
    void window.origread.getLlmAssistantEvidence(message.id)
      .then((value) => { if (!cancelled) setSnapshot(value) })
      .catch(() => { if (!cancelled) setSnapshot(null) })
    return () => { cancelled = true }
  }, [message.id, message.status, message.updatedAt])

  const citationByProtocol = new Map(snapshot?.citations.map((citation) => [citation.protocolId, citation] as const) ?? [])
  const contextById = new Map(snapshot?.contextRefs.map((ref) => [ref.id, ref] as const) ?? [])
  const citedContextCount = new Set(snapshot?.citations.map((citation) => citation.contextRefId) ?? []).size
  const usedContextCount = snapshot?.contextRefs.filter((ref) => ref.includedInPrompt).length ?? 0

  return <>
    <CitationMarkdown
      text={message.content}
      renderCitation={(protocolId) => {
        const citation = citationByProtocol.get(protocolId)
        if (!citation || !snapshot) return null
        const contextRef = contextById.get(citation.contextRefId) ?? null
        const number = citation.displayOrder ?? snapshot.citations.findIndex((item) => item.id === citation.id) + 1
        const source = citationSourceName(citation, contextRef, t)
        const preview = citationPreview(citation.quoteSnapshot)
        return <span className="reader-ai-inline-citation-wrap" key={`${citation.id}-${protocolId}`}>
          <button
            type="button"
            className="reader-ai-inline-citation"
            aria-label={t('citationNumberLabel', { number, source })}
            onClick={()=>onOpenCitation(message.id, citation, snapshot)}
          >{number}</button>
          <span className="reader-ai-inline-citation-popover" role="tooltip">
            <strong>{source}</strong>
            <span>{preview}</span>
          </span>
        </span>
      }}
    />
    {snapshot && snapshot.contextRefs.length > 0 ? <button
      type="button"
      className="reader-ai-answer-sources"
      onClick={()=>onOpenSources(message.id)}
    >
      <Share2 size={12}/>
      <span>{t('answerSources')}</span>
      <small>{citedContextCount > 0 ? citedContextCount : usedContextCount}</small>
    </button> : null}
  </>
}

function ReaderAiSourcesDetailBody({
  message,
  focusCitationId,
  locationUnavailable,
  onOpenCitation,
  onOpenExternal
}: {
  message: LlmMessageRecord | null
  focusCitationId: string | null
  locationUnavailable: boolean
  onOpenCitation(citation: LlmCitationRefRecord, snapshot: LlmAssistantEvidenceSnapshot): void
  onOpenExternal(url: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<LlmAssistantEvidenceSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!message) return
    let cancelled = false
    setSnapshot(null)
    setError(null)
    void window.origread.getLlmAssistantEvidence(message.id)
      .then((value) => { if (!cancelled) setSnapshot(value) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [message?.id])

  useEffect(() => {
    if (!snapshot || !focusCitationId) return
    const frame = window.requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-citation-id="${CSS.escape(focusCitationId)}"]`)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      target?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [snapshot, focusCitationId])

  if (!message) return <div className="reader-ai-history-empty">{t('citationUnavailable')}</div>
  if (error) return <div className="reader-ai-chat-error" role="alert">{error}</div>
  if (!snapshot) return <div className="reader-ai-chat-state"><RefreshCw size={14} className="spinning"/><span>{t('loading')}</span></div>

  const evidenceByContext = new Map<string, LlmEvidenceBlockRecord[]>()
  for (const block of snapshot.evidenceBlocks) {
    const list = evidenceByContext.get(block.contextRefId) ?? []
    list.push(block)
    evidenceByContext.set(block.contextRefId, list)
  }
  const citationsByContext = new Map<string, LlmCitationRefRecord[]>()
  for (const citation of snapshot.citations) {
    const list = citationsByContext.get(citation.contextRefId) ?? []
    list.push(citation)
    citationsByContext.set(citation.contextRefId, list)
  }

  return <div className="reader-ai-sources-detail" ref={rootRef}>
    {locationUnavailable ? <div className="reader-ai-source-location-warning">{t('citationLocationUnavailable')}</div> : null}
    {snapshot.contextRefs.length === 0 ? <div className="reader-ai-history-empty">{t('citationUnavailable')}</div> : null}
    {snapshot.contextRefs.map((ref) => {
      const citations = (citationsByContext.get(ref.id) ?? []).sort((a,b)=>(a.displayOrder??999)-(b.displayOrder??999))
      const evidence = evidenceByContext.get(ref.id) ?? []
      const focused = Boolean(focusCitationId && citations.some((citation) => citation.id === focusCitationId))
      const primaryCitation = citations[0] ?? null
      const sourceName = primaryCitation
        ? citationSourceName(primaryCitation, ref, t)
        : contextSourceName(ref, t)
      const usage = ref.includedInPrompt
        ? ref.truncatedInPrompt ? t('contextUsageTruncated') : t('contextUsageIncluded')
        : t('contextUsageOmitted')
      const sourceUrl = primaryCitation?.sourceUrl ?? ref.sourceUrl
      const toolLocator = primaryCitation?.locatorSnapshot?.sourceKind === 'TOOL_RESULT' ? primaryCitation.locatorSnapshot : null
      return <article className={`reader-ai-source-card ${focused ? 'focused' : ''}`} key={ref.id}>
        <div className="reader-ai-source-card-head">
          <div>
            <span className="reader-ai-source-kind">{contextSourceKindLabel(ref, t)}</span>
            <strong>{sourceName}</strong>
          </div>
          <span className={`reader-ai-source-usage ${ref.includedInPrompt ? 'used' : 'omitted'}`}>{usage}</span>
        </div>
        {citations.length > 0 ? <div className="reader-ai-source-citations">
          {citations.map((citation) => <button
            key={citation.id}
            type="button"
            data-citation-id={citation.id}
            className={citation.id === focusCitationId ? 'focused' : ''}
            onClick={()=>onOpenCitation(citation, snapshot)}
          >[{citation.displayOrder ?? '?'}]</button>)}
          <small>{t('contextCitationCount', { count: citations.length })}</small>
        </div> : <small className="reader-ai-source-no-citation">{t('contextNoCitations')}</small>}
        <blockquote className="reader-ai-source-preview">
          {citationPreview(primaryCitation?.quoteSnapshot ?? ref.promptContentSnapshot ?? ref.contentSnapshot)}
        </blockquote>
        {toolLocator ? <div className="reader-ai-source-tool-meta">
          {toolLocator.toolName ? <span><strong>{toolLocator.toolName}</strong></span> : null}
          {toolLocator.toolSourceId ? <span>{t('contextToolServer')}: {toolLocator.toolSourceId}</span> : null}
          {toolLocator.toolCallId ? <span>call: {toolLocator.toolCallId}</span> : null}
        </div> : null}
        <div className="reader-ai-source-card-actions">
          {primaryCitation && (primaryCitation.locatorSnapshot?.sourceKind === 'ARTICLE' || primaryCitation.locatorSnapshot?.sourceKind === 'SELECTION')
            ? <button type="button" onClick={()=>onOpenCitation(primaryCitation, snapshot)}><BookOpenText size={12}/>{t('citationViewInReader')}</button>
            : null}
          {sourceUrl ? <button type="button" onClick={()=>onOpenExternal(sourceUrl)}><ExternalLink size={12}/>{t('citationOpenSource')}</button> : null}
        </div>
        <details className="reader-ai-source-audit">
          <summary>{t('contextSources')}</summary>
          <div>
            {ref.promptContentSnapshot ? <section><strong>{t('contextPromptSnapshot')}</strong><pre>{ref.promptContentSnapshot}</pre></section> : null}
            <section><strong>{t('contextFullSnapshot')}</strong><pre>{ref.contentSnapshot}</pre></section>
            {evidence.length > 0 ? <section><strong>{t('contextEvidenceBlocks')}</strong>{evidence.map((block)=><pre key={block.id}>{block.textSnapshot}</pre>)}</section> : null}
          </div>
        </details>
      </article>
    })}
  </div>
}

function contextSourceKindLabel(ref: LlmContextRefRecord, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (ref.type === 'WEB_SEARCH_RESULT') return t('citationSourceWeb')
  if (ref.type === 'TOOL_RESULT') return t('citationSourceTool')
  if (ref.type === 'SELECTED_TEXT') return t('citationSourceSelection')
  return t('citationSourceArticle')
}

function contextSourceName(ref: LlmContextRefRecord, t: (key: string, options?: Record<string, unknown>) => string): string {
  return ref.title?.trim() || webSearchDomain(ref.sourceUrl ?? ref.sourceId) || ref.sourceId?.trim() || contextSourceKindLabel(ref, t)
}

function citationSourceName(
  citation: LlmCitationRefRecord,
  ref: LlmContextRefRecord | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const locator = citation.locatorSnapshot
  if (locator?.sourceKind === 'TOOL_RESULT') return locator.toolName?.trim() || ref?.title?.trim() || t('citationSourceTool')
  if (locator?.sourceKind === 'WEB_SEARCH') return ref?.title?.trim() || webSearchDomain(citation.sourceUrl ?? ref?.sourceUrl) || t('citationSourceWeb')
  return ref?.title?.trim() || (locator?.sourceKind === 'SELECTION' ? t('citationSourceSelection') : t('citationSourceArticle'))
}

function citationPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= 240 ? compact : `${compact.slice(0, 240).trimEnd()}…`
}

function CitationMarkdown({
  text,
  renderCitation
}: {
  text: string
  renderCitation(protocolId: string): React.ReactNode | null
}): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let listItems: string[] = []
  const inline = (value: string): React.ReactNode[] => renderCitationInlineMarkdown(value, renderCitation)
  const flushList = (): void => {
    if (listItems.length === 0) return
    blocks.push(<ol key={`list-${blocks.length}`}>{listItems.map((item,index)=><li key={index}>{inline(item)}</li>)}</ol>)
    listItems = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { flushList(); continue }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/)
    if (numbered?.[1]) { listItems.push(numbered[1]); continue }
    flushList()
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading?.[1] && heading[2]) {
      const content = inline(heading[2])
      const level = heading[1].length
      if (level === 1) blocks.push(<h1 key={blocks.length}>{content}</h1>)
      else if (level === 2) blocks.push(<h2 key={blocks.length}>{content}</h2>)
      else if (level === 3) blocks.push(<h3 key={blocks.length}>{content}</h3>)
      else blocks.push(<h4 key={blocks.length}>{content}</h4>)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet?.[1]) {
      blocks.push(<p className="markdown-bullet" key={blocks.length}>• {inline(bullet[1])}</p>)
      continue
    }
    blocks.push(<p key={blocks.length}>{inline(line)}</p>)
  }
  flushList()
  return <div className="ai-summary-markdown reader-ai-citation-markdown">{blocks}</div>
}

function renderCitationInlineMarkdown(
  text: string,
  renderCitation: (protocolId: string) => React.ReactNode | null
): React.ReactNode[] {
  const result: React.ReactNode[] = []
  const pattern = /(\*\*(.+?)\*\*|\[\[(E\d+)\]\])/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > start) result.push(text.slice(start, match.index))
    if (match[3]) {
      result.push(renderCitation(match[3]) ?? '')
    } else {
      result.push(<strong key={`bold-${match.index}-${match[2]}`}>{match[2]}</strong>)
    }
    start = match.index + match[0].length
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

function findReaderCitationElement(root: HTMLElement, citation: LlmCitationRefRecord): HTMLElement | null {
  const locator = citation.locatorSnapshot
  const stableKey = locator?.stableLocatorKey?.trim()
  if (stableKey) {
    const exact = root.querySelector<HTMLElement>(`[data-origread-block-id="${CSS.escape(stableKey)}"]`)
    if (exact) return exact
  }

  const hash = locator?.normalizedHash?.trim()
  const hashMatches = hash
    ? Array.from(root.querySelectorAll<HTMLElement>(`[data-origread-block-hash="${CSS.escape(hash)}"]`))
    : []
  if (hashMatches.length === 1) return hashMatches[0]!

  const headingPath = locator?.headingPath?.length ? locator.headingPath.join('\u001f') : ''
  const normalizedQuote = normalizeReaderCitationText(citation.quoteSnapshot)
  const allBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-origread-block-id]'))
  if (headingPath && normalizedQuote) {
    const headingMatches = allBlocks.filter((element) =>
      element.dataset.origreadHeadingPath === headingPath
      && normalizeReaderCitationText(element.textContent ?? '').includes(normalizedQuote)
    )
    if (headingMatches.length === 1) return headingMatches[0]!
  }
  if (normalizedQuote) {
    const quoteMatches = allBlocks.filter((element) => normalizeReaderCitationText(element.textContent ?? '').includes(normalizedQuote))
    if (quoteMatches.length === 1) return quoteMatches[0]!
  }
  return null
}

function normalizeReaderCitationText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function readerAiModelPopoverWidthPx(providerName: string, modelName: string): number {
  const longestUnits = Math.max(
    10,
    readerAiTextVisualUnits(providerName),
    readerAiTextVisualUnits(modelName)
  )
  // 只按当前已选 Provider / Model 计算容器宽度。候选列表里存在超长模型时不应该把整个弹窗永久撑宽；
  // 原生 select 的下拉层仍可展示完整候选文本。
  return Math.min(360, Math.max(208, Math.round(92 + longestUnits * 7.1)))
}

function readerAiTextVisualUnits(value: string): number {
  return [...value].reduce((total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 1.75 : 1), 0)
}

function webSearchDomain(value:string|null|undefined):string{
  if(!value)return''
  try{return new URL(value).hostname.replace(/^www\./,'')}catch{return''}
}

function webSearchResultSnippet(value:string):string{
  const compact=value.replace(/^Published:\s*[^\n]+\n+/i,'').replace(/\s+/g,' ').trim()
  return compact.length<=420?compact:`${compact.slice(0,420).trimEnd()}…`
}

function selectionNodeElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

function normalizeReaderAiSelectionText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function readerAiSelectionPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= 240 ? compact : `${compact.slice(0, 240).trimEnd()}…`
}

function ReaderAiSummaryArtifact({
  summary,
  expanded,
  onExpandedChange
}: {
  summary: AiSummaryDocument
  expanded: boolean
  onExpandedChange(expanded: boolean): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const summaryMarkdown = stripRedundantSummaryHeading(summary.summary)
  return <details
    className="reader-ai-summary-artifact"
    open={expanded}
    onToggle={(event)=>onExpandedChange(event.currentTarget.open)}
  >
    <summary className="reader-ai-summary-artifact-summary">
      <AiSummaryAccentIcon variant="panel"/>
      <span className="reader-ai-summary-artifact-title">
        <strong>{t('aiSummary')}</strong>
        <small>{t(summaryLengthLabelKey(summary.length))} · {summary.providerName} · {summary.model}</small>
      </span>
      <ChevronDown size={14} className="reader-ai-summary-artifact-chevron"/>
    </summary>
    <div className="reader-ai-summary-artifact-body">
      {summary.reasoning ? <details className="ai-reasoning reader-ai-summary-artifact-reasoning"><summary>{t('aiReasoning')}</summary><pre>{summary.reasoning}</pre></details> : null}
      {summary.status === 'NOT_NEEDED'
        ? <div className="ai-summary-not-needed"><strong>{t('aiSummaryNotNeeded')}</strong><span>{t(summary.skipReason==='local_source_already_concise'?'aiSummaryNotNeededLocal':'aiSummaryNotNeededModel')}</span></div>
        : <SimpleMarkdown text={summaryMarkdown}/>}
    </div>
  </details>
}

function ReaderAiChatBody({
  messages,
  toolActivity,
  toolDecisionBusy,
  manualTools,
  manualToolContexts,
  manualToolBusy,
  manualToolConversationReady,
  attachedArticles,
  currentArticleId,
  summaryArtifact,
  draft,
  selectionText,
  selectionTruncated,
  composerRef,
  quickMessages,
  active,
  loading,
  error,
  modelLabel,
  providers,
  providerId,
  model,
  forceWebSearchNext,
  locateMessageId,
  placeholder,
  emptyContent,
  onDraftChange,
  onClearSelection,
  onProviderChange,
  onModelChange,
  onForceWebSearchNextChange,
  onOpenWebSearch,
  onOpenSources,
  onOpenCitation,
  onSend,
  onQuickMessage,
  onStop,
  onToolApproval,
  onManualToolExecute,
  onDiscardManualToolContext,
  onAttachedArticlesChange,
  onRegenerate,
  onLocateMessageHandled
}: {
  messages: LlmMessageRecord[]
  toolActivity: LlmToolActivityView[]
  toolDecisionBusy: Record<string, boolean>
  manualTools: LlmManualToolView[]
  manualToolContexts: LlmManualToolContextView[]
  manualToolBusy: boolean
  manualToolConversationReady: boolean
  attachedArticles: LlmConversationArticleRecord[]
  currentArticleId: string
  summaryArtifact: AiSummaryDocument | null
  draft: string
  selectionText: string | null
  selectionTruncated: boolean
  composerRef: RefObject<HTMLTextAreaElement | null>
  quickMessages: LlmQuickMessage[]
  active: boolean
  loading: boolean
  error: string | null
  modelLabel: string
  providers: AiProviderProfile[]
  providerId: string
  model: string
  forceWebSearchNext: boolean
  locateMessageId?: string | null
  placeholder: string
  emptyContent?: React.ReactNode
  onDraftChange(value: string): void
  onClearSelection(): void
  onProviderChange(providerId: string): void
  onModelChange(model: string): void
  onForceWebSearchNextChange(value: boolean): void
  onOpenWebSearch(messageId: string): void
  onOpenSources(messageId: string): void
  onOpenCitation(messageId: string, citation: LlmCitationRefRecord, snapshot: LlmAssistantEvidenceSnapshot): void
  onSend(): void
  onQuickMessage(message: LlmQuickMessage): void
  onStop(): void
  onToolApproval(toolCallId: string, decision: LlmToolApprovalDecision): void
  onManualToolExecute(toolId: string, argumentsJson: string): Promise<boolean>
  onDiscardManualToolContext(contextId: string): void
  onAttachedArticlesChange(articles: readonly LlmArticleContextCandidate[]): Promise<void>
  onRegenerate(assistantMessageId: string): void
  onLocateMessageHandled?(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const timelineRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDetailsElement>(null)
  const articlePickerRef = useRef<HTMLDetailsElement>(null)
  const composerActionsRef = useRef<HTMLDetailsElement>(null)
  const scrollOwnershipRef = useRef(initialReaderAiChatScrollOwnership())
  const userScrollIntentRef = useRef(false)
  const visibleMessages = messages.filter((message) => message.historyActive && (message.role === 'USER' || message.role === 'ASSISTANT'))
  const [followOutput, setFollowOutput] = useState(true)
  const [scrollAvailability, setScrollAvailability] = useState({ up: false, down: false })
  const [copyState, setCopyState] = useState<{ messageId: string; ok: boolean } | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [manualToolEditorId, setManualToolEditorId] = useState<string | null>(null)
  const [manualToolArguments, setManualToolArguments] = useState('{}')
  const [manualToolEditorError, setManualToolEditorError] = useState<string | null>(null)
  const [articlePickerOpen, setArticlePickerOpen] = useState(false)
  const [articleQuery, setArticleQuery] = useState('')
  const [articleCandidates, setArticleCandidates] = useState<LlmArticleContextCandidate[]>([])
  const [articleCandidatesLoading, setArticleCandidatesLoading] = useState(false)
  const [articlePickerError, setArticlePickerError] = useState<string | null>(null)
  const [summaryArtifactExpanded, setSummaryArtifactExpanded] = useState(() => visibleMessages.length === 0)
  const previousVisibleMessageCountRef = useRef(visibleMessages.length)
  const latestAssistantId = [...visibleMessages].reverse().find((message) => message.role === 'ASSISTANT')?.id ?? null
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null
  const modelOptions = selectedProvider
    ? [...new Set([model, selectedProvider.defaultModel, ...selectedProvider.models].map((item) => item.trim()).filter(Boolean))]
    : model ? [model] : []
  const modelPopoverWidth = readerAiModelPopoverWidthPx(selectedProvider?.name ?? '', model)
  const selectedManualTool = manualTools.find((tool) => tool.id === manualToolEditorId) ?? null
  const attachedCandidates = attachedArticles.map((article) => ({
    articleId: article.articleId,
    title: article.title,
    link: article.link,
    feedName: null,
    publishedAt: null
  } satisfies LlmArticleContextCandidate))
  const attachedArticleIds = new Set(attachedArticles.map((article) => article.articleId))

  useEffect(() => {
    if (!articlePickerOpen) return
    let cancelled = false
    setArticleCandidatesLoading(true)
    setArticlePickerError(null)
    const timer = window.setTimeout(() => {
      void window.origread.listLlmArticleContextCandidates(articleQuery).then((items) => {
        if (!cancelled) setArticleCandidates(items.filter((item) => item.articleId !== currentArticleId))
      }).catch(() => {
        if (!cancelled) setArticlePickerError(t('articleContextLoadFailed'))
      }).finally(() => {
        if (!cancelled) setArticleCandidatesLoading(false)
      })
    }, articleQuery.trim() ? 120 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [articlePickerOpen, articleQuery, currentArticleId, t])

  useEffect(() => {
    if (!summaryArtifact) return
    setSummaryArtifactExpanded(visibleMessages.length === 0)
  }, [summaryArtifact])

  useEffect(() => {
    const previous = previousVisibleMessageCountRef.current
    previousVisibleMessageCountRef.current = visibleMessages.length
    if (!summaryArtifact || previous !== 0 || visibleMessages.length === 0) return
    setSummaryArtifactExpanded(false)
  }, [summaryArtifact, visibleMessages.length])

  const openManualToolEditor = (tool: LlmManualToolView): void => {
    if (!manualToolConversationReady || active) return
    setManualToolEditorId(tool.id)
    setManualToolArguments('{}')
    setManualToolEditorError(null)
    composerActionsRef.current?.removeAttribute('open')
  }

  const closeManualToolEditor = (): void => {
    if (manualToolBusy) return
    setManualToolEditorId(null)
    setManualToolArguments('{}')
    setManualToolEditorError(null)
  }

  const runManualTool = async (): Promise<void> => {
    if (!selectedManualTool || manualToolBusy) return
    let parsed: unknown
    try {
      parsed = JSON.parse(manualToolArguments)
    } catch {
      setManualToolEditorError(t('manualToolArgumentsInvalid'))
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setManualToolEditorError(t('manualToolArgumentsObjectRequired'))
      return
    }
    setManualToolEditorError(null)
    const ok = await onManualToolExecute(selectedManualTool.id, JSON.stringify(parsed))
    if (ok) closeManualToolEditor()
  }

  const toggleAttachedArticle = async (candidate: LlmArticleContextCandidate): Promise<void> => {
    if (active) return
    setArticlePickerError(null)
    const selected = attachedArticleIds.has(candidate.articleId)
    if (!selected && attachedArticles.length >= 5) {
      setArticlePickerError(t('articleContextLimitReached'))
      return
    }
    const next = selected
      ? attachedCandidates.filter((item) => item.articleId !== candidate.articleId)
      : [...attachedCandidates, candidate]
    try {
      await onAttachedArticlesChange(next)
    } catch {
      setArticlePickerError(t('articleContextUpdateFailed'))
    }
  }

  const copyAssistantMessage = async (message: LlmMessageRecord): Promise<void> => {
    try {
      await copyPlainText(displayChatAssistantContent(message.content))
      setCopyState({ messageId: message.id, ok: true })
    } catch {
      setCopyState({ messageId: message.id, ok: false })
    }
    window.setTimeout(() => setCopyState((current) => current?.messageId === message.id ? null : current), 1_600)
  }

  const syncScrollAvailability = (timeline: HTMLDivElement): void => {
    const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
    const tolerance = 4
    setScrollAvailability({
      up: timeline.scrollTop > tolerance,
      down: timeline.scrollTop < maxScrollTop - tolerance
    })
  }

  useEffect(() => {
    if (!followOutput) return
    const frame = window.requestAnimationFrame(() => {
      const timeline = timelineRef.current
      if (!timeline) return
      timeline.scrollTop = timeline.scrollHeight
      const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
      scrollOwnershipRef.current = updateReaderAiChatScrollOwnership(
        scrollOwnershipRef.current,
        timeline.scrollTop,
        maxScrollTop
      )
      syncScrollAvailability(timeline)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [followOutput, messages])

  useEffect(() => {
    const timeline = timelineRef.current
    if (!timeline || typeof ResizeObserver === 'undefined') return
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
        const observed = updateReaderAiChatScrollOwnership(
          scrollOwnershipRef.current,
          timeline.scrollTop,
          maxScrollTop
        )
        scrollOwnershipRef.current = observed
        setFollowOutput(observed.following)
        if (observed.following) {
          timeline.scrollTop = timeline.scrollHeight
          const nextMaxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
          scrollOwnershipRef.current = updateReaderAiChatScrollOwnership(
            scrollOwnershipRef.current,
            timeline.scrollTop,
            nextMaxScrollTop
          )
        }
        syncScrollAvailability(timeline)
      })
    })
    observer.observe(timeline)
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    if (!locateMessageId) return
    const frame = window.requestAnimationFrame(() => {
      const timeline = timelineRef.current
      const target = timeline?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(locateMessageId)}"]`)
      if (!target) {
        onLocateMessageHandled?.()
        return
      }
      scrollOwnershipRef.current = pauseReaderAiChatScroll(scrollOwnershipRef.current)
      setFollowOutput(false)
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightedMessageId(locateMessageId)
      onLocateMessageHandled?.()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [locateMessageId, onLocateMessageHandled])

  useEffect(() => {
    if (!highlightedMessageId) return
    const timer = window.setTimeout(() => setHighlightedMessageId(null), 1_600)
    return () => window.clearTimeout(timer)
  }, [highlightedMessageId])

  const handleTimelineScroll = (): void => {
    const timeline = timelineRef.current
    if (!timeline) return
    const maxScrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight)
    const userInitiated = userScrollIntentRef.current
    userScrollIntentRef.current = false
    const next = updateReaderAiChatScrollOwnership(
      scrollOwnershipRef.current,
      timeline.scrollTop,
      maxScrollTop,
      userInitiated
    )
    scrollOwnershipRef.current = next
    setFollowOutput(next.following)
    syncScrollAvailability(timeline)
  }

  const markTimelineUserScrollIntent = (): void => {
    userScrollIntentRef.current = true
  }

  const handleTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const timeline = event.currentTarget
    if (timeline.scrollHeight <= timeline.clientHeight) return
    const bounds = timeline.getBoundingClientRect()
    const scrollbarHitWidth = Math.max(12, timeline.offsetWidth - timeline.clientWidth)
    if (event.clientX >= bounds.right - scrollbarHitWidth) markTimelineUserScrollIntent()
  }

  const handleTimelineKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      markTimelineUserScrollIntent()
    }
  }

  const jumpToBottom = (): void => {
    const timeline = timelineRef.current
    if (!timeline) return
    scrollOwnershipRef.current = resumeReaderAiChatScroll(scrollOwnershipRef.current)
    setFollowOutput(true)
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'smooth' })
  }

  const jumpToTop = (): void => {
    const timeline = timelineRef.current
    if (!timeline) return
    scrollOwnershipRef.current = pauseReaderAiChatScroll(scrollOwnershipRef.current)
    setFollowOutput(false)
    timeline.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submitChat = (): void => {
    modelPickerRef.current?.removeAttribute('open')
    composerActionsRef.current?.removeAttribute('open')
    onSend()
  }

  const selectQuickMessage = (message: LlmQuickMessage): void => {
    composerActionsRef.current?.removeAttribute('open')
    modelPickerRef.current?.removeAttribute('open')
    onQuickMessage(message)
  }

  return <div className="reader-ai-chat">
    <div className="reader-ai-chat-scroll-stage">
      <div
        className="reader-ai-chat-timeline"
        ref={timelineRef}
        onScroll={handleTimelineScroll}
        onWheel={markTimelineUserScrollIntent}
        onTouchStart={markTimelineUserScrollIntent}
        onPointerDown={handleTimelinePointerDown}
        onKeyDown={handleTimelineKeyDown}
      >
      {loading ? <div className="reader-ai-chat-state"><RefreshCw size={15} className="spinning"/><span>{t('loadingConversation')}</span></div> : null}
      {summaryArtifact ? <ReaderAiSummaryArtifact
        summary={summaryArtifact}
        expanded={summaryArtifactExpanded}
        onExpandedChange={setSummaryArtifactExpanded}
      /> : null}
      {!loading && visibleMessages.length === 0 && !summaryArtifact ? emptyContent ?? <div className="reader-ai-chat-state"><span>{t('startChatPrompt')}</span></div> : null}
      {visibleMessages.map((message) => message.role === 'USER'
        ? <div className={`reader-ai-message user ${highlightedMessageId === message.id ? 'search-highlight' : ''}`} key={message.id} data-message-id={message.id}>
            <div className="reader-ai-user-bubble">{message.content}</div>
          </div>
        : <article className={`reader-ai-message assistant status-${message.status.toLowerCase()} ${highlightedMessageId === message.id ? 'search-highlight' : ''}`} key={message.id} data-message-id={message.id}>
            {message.requestTask === 'ARTICLE_ANALYSIS' ? <div className="reader-ai-task-badge"><Sparkles size={11}/><span>{t('articleAnalysis')}</span></div> : null}
            <ReaderAiWebSearchActivity message={message} onOpen={()=>onOpenWebSearch(message.id)}/>
            {message.reasoning ? message.status === 'STREAMING'
              ? <div className="reader-ai-reasoning-stream"><strong>{t('thinking')}</strong><pre>{message.reasoning}</pre></div>
              : <details className="reader-ai-reasoning"><summary>{t('thinking')}</summary><pre>{message.reasoning}</pre></details>
            : null}
            {message.content
              ? <ReaderAiAssistantAnswer
                  message={message}
                  onOpenSources={onOpenSources}
                  onOpenCitation={onOpenCitation}
                />
              : message.status === 'STREAMING'
                ? <div className="reader-ai-assistant-working"><span/><span/><span/></div>
                : null}
            <ReaderAiToolActivity
              items={toolActivity.filter((item)=>item.assistantMessageId===message.id)}
              busy={toolDecisionBusy}
              onDecision={onToolApproval}
            />
            {message.status === 'STOPPED' ? <div className="reader-ai-message-status">{t('stopped')}</div> : null}
            {message.status === 'ERROR' ? <div className="reader-ai-message-status error">{message.errorMessage || t('aiChatRequestFailed')}</div> : null}
            {message.status !== 'STREAMING' ? <div className="reader-ai-message-actions">
              <button type="button" className="reader-ai-message-action" onClick={()=>void copyAssistantMessage(message)}>
                {copyState?.messageId === message.id ? t(copyState.ok ? 'copied' : 'copyFailed') : t('copyResponse')}
              </button>
              <details className="reader-ai-message-usage">
                <summary className="reader-ai-message-action">{t('usage')}</summary>
                <div className="reader-ai-message-usage-popover">
                  {message.providerId || message.model ? <div><span>{t('aiModel')}</span><strong>{[
                    providers.find((provider) => provider.id === message.providerId)?.name ?? message.providerId,
                    message.model
                  ].filter(Boolean).join(' · ')}</strong></div> : null}
                  <div><span>{t('inputTokens')}</span><strong>{formatUsageValue(message.promptTokens)}</strong></div>
                  <div><span>{t('outputTokens')}</span><strong>{formatUsageValue(message.completionTokens)}</strong></div>
                  <div><span>{t('duration')}</span><strong>{formatDurationMs(message.durationMs, t('notAvailable'))}</strong></div>
                  {message.tokenUsageEstimated ? <small>{t('tokenUsageEstimated')}</small> : null}
                </div>
              </details>
              {!active && message.id === latestAssistantId ? <button type="button" className="reader-ai-message-action" onClick={()=>onRegenerate(message.id)}>
                {t(message.status === 'ERROR' || message.status === 'STOPPED' ? 'retryResponse' : 'regenerateResponse')}
              </button> : null}
            </div> : null}
          </article>
        )}
      </div>
      {(scrollAvailability.up || scrollAvailability.down) && visibleMessages.length > 0 ? <div className="reader-ai-scroll-jumps" aria-label={t('chatScrollNavigation')}>
        {scrollAvailability.up ? <button type="button" aria-label={t('backToTop')} title={t('backToTop')} onClick={jumpToTop}><ChevronUp size={15}/></button> : null}
        {scrollAvailability.down ? <button type="button" aria-label={t('backToBottom')} title={t('backToBottom')} onClick={jumpToBottom}><ChevronDown size={15}/></button> : null}
      </div> : null}
    </div>
    {error ? <div className="reader-ai-chat-error" role="alert">{error}</div> : null}
    {selectionText ? <div className="reader-ai-selection-context" aria-label={t('selectedOriginalText')}>
      <div className="reader-ai-selection-context-copy">
        <span><strong>{t('selectedOriginalText')}</strong><small>{t('selectedOriginalTextNextMessage')}</small></span>
        <blockquote>{readerAiSelectionPreview(selectionText)}</blockquote>
        {selectionTruncated ? <small className="reader-ai-selection-context-warning">{t('selectedTextTruncated', { count: READER_AI_SELECTION_MAX_CHARS })}</small> : null}
      </div>
      <button type="button" aria-label={t('removeSelectedText')} title={t('removeSelectedText')} onClick={onClearSelection}><X size={12}/></button>
    </div> : null}
    {manualToolContexts.length > 0 ? <div className="reader-ai-manual-contexts" aria-label={t('manualToolAttachedResults')}>
      {manualToolContexts.map((context)=><div className="reader-ai-manual-context" key={context.contextId}>
        <span><strong>{context.name}</strong><small>{t('manualToolAttachedToNextMessage')}</small></span>
        <button type="button" aria-label={t('manualToolRemoveResult')} title={t('manualToolRemoveResult')} disabled={active} onClick={()=>onDiscardManualToolContext(context.contextId)}><X size={12}/></button>
      </div>)}
    </div> : null}
    {selectedManualTool ? <div className="reader-ai-manual-tool-editor">
      <div className="reader-ai-manual-tool-editor-head">
        <span><strong>{selectedManualTool.description || selectedManualTool.name}</strong><small>{selectedManualTool.name}</small></span>
        <span className={`reader-ai-tool-risk ${selectedManualTool.risk.toLowerCase()}`}>{t(selectedManualTool.risk==='READ_ONLY'?'toolRiskReadOnly':selectedManualTool.risk==='SENSITIVE'?'toolRiskSensitive':'toolRiskWrite')}</span>
      </div>
      <label>
        <span>{t('manualToolJsonArguments')}</span>
        <textarea value={manualToolArguments} rows={4} disabled={manualToolBusy} onChange={(event)=>setManualToolArguments(event.target.value)} spellCheck={false}/>
      </label>
      {selectedManualTool.risk !== 'READ_ONLY' ? <small className="reader-ai-manual-tool-warning">{t(selectedManualTool.risk==='WRITE'?'manualToolWriteWarning':'manualToolSensitiveWarning')}</small> : null}
      {manualToolEditorError ? <small className="reader-ai-manual-tool-error" role="alert">{manualToolEditorError}</small> : null}
      <div className="reader-ai-manual-tool-editor-actions">
        <button type="button" className="mini-action secondary" disabled={manualToolBusy} onClick={closeManualToolEditor}>{t('cancel')}</button>
        <button type="button" className="mini-action" disabled={manualToolBusy} onClick={()=>void runManualTool()}>{manualToolBusy?t('toolDecisionWorking'):t(selectedManualTool.risk==='READ_ONLY'?'manualToolRun':'manualToolConfirmAndRun')}</button>
      </div>
    </div> : null}
    <div className="reader-ai-composer">
      {attachedArticles.length > 0 ? <div className="reader-ai-article-attachments" aria-label={t('attachedArticleContexts')}>
        {attachedArticles.map((article) => <span className="reader-ai-article-attachment" key={article.articleId} title={article.title}>
          <BookOpenText size={11}/>
          <span>{article.title}</span>
          <button
            type="button"
            aria-label={t('removeArticleContext', { title: article.title })}
            title={t('removeArticleContext', { title: article.title })}
            disabled={active}
            onClick={() => void toggleAttachedArticle({ articleId: article.articleId, title: article.title, link: article.link, feedName: null, publishedAt: null })}
          ><X size={10}/></button>
        </span>)}
      </div> : null}
      <textarea
        ref={composerRef}
        value={draft}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={active}
        onChange={(event)=>onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          submitChat()
        }}
      />
      <div className="reader-ai-composer-footer">
        <div className="reader-ai-composer-left">
          <details
            className="reader-ai-article-picker"
            ref={articlePickerRef}
            onToggle={(event) => setArticlePickerOpen(event.currentTarget.open)}
          >
            <summary
              className={`reader-ai-article-picker-trigger ${attachedArticles.length > 0 ? 'active' : ''}`}
              aria-label={t('attachArticleContext')}
              title={t('attachArticleContext')}
            >
              <Paperclip size={13}/>
              {attachedArticles.length > 0 ? <span>{attachedArticles.length}</span> : null}
            </summary>
            <div className="reader-ai-article-picker-popover">
              <div className="reader-ai-article-picker-head">
                <div><strong>{t('articleContextTitle')}</strong><small>{t('articleContextCount', { count: attachedArticles.length })}</small></div>
                <span>{attachedArticles.length}/5</span>
              </div>
              <label className="reader-ai-article-picker-search">
                <Search size={13}/>
                <input
                  value={articleQuery}
                  placeholder={t('articleContextSearchPlaceholder')}
                  aria-label={t('articleContextSearchPlaceholder')}
                  disabled={active}
                  onChange={(event) => setArticleQuery(event.target.value)}
                />
              </label>
              {articlePickerError ? <small className="reader-ai-article-picker-error" role="alert">{articlePickerError}</small> : null}
              <div className="reader-ai-article-picker-list">
                {articleCandidatesLoading ? <div className="reader-ai-article-picker-state"><RefreshCw size={13} className="spinning"/><span>{t('loading')}</span></div>
                  : articleCandidates.length > 0 ? articleCandidates.map((candidate) => {
                      const selected = attachedArticleIds.has(candidate.articleId)
                      return <button
                        type="button"
                        key={candidate.articleId}
                        className={selected ? 'selected' : ''}
                        aria-pressed={selected}
                        disabled={active || (!selected && attachedArticles.length >= 5)}
                        onClick={() => void toggleAttachedArticle(candidate)}
                      >
                        <span><strong>{candidate.title}</strong><small>{candidate.feedName || (candidate.publishedAt ? new Date(candidate.publishedAt).toLocaleDateString() : t('articleContextLocalArticle'))}</small></span>
                        <span className="reader-ai-article-picker-check">{selected ? '✓' : '+'}</span>
                      </button>
                    })
                  : <div className="reader-ai-article-picker-state"><span>{t(articleQuery.trim() ? 'articleContextNoSearchResults' : 'articleContextNoRecent')}</span></div>}
              </div>
              <small className="reader-ai-article-picker-hint">{t('articleContextHint')}</small>
            </div>
          </details>
          <details className="reader-ai-composer-actions" ref={composerActionsRef}>
            <summary className="reader-ai-composer-add" aria-label={t('composerActions')} title={t('composerActions')}><Plus size={14}/></summary>
            <div className="reader-ai-composer-actions-popover">
              <strong>{t('quickMessagesTitle')}</strong>
              {quickMessages.length > 0 ? <div className="reader-ai-quick-message-menu">
                {quickMessages.map((message)=><button type="button" key={message.id} disabled={active} onClick={()=>selectQuickMessage(message)}><span>{message.title}</span><small>{message.content}</small></button>)}
              </div> : <small className="reader-ai-quick-message-empty">{t('quickMessagesEmpty')}</small>}
              <div className="reader-ai-composer-action-divider"/>
              <strong>{t('manualToolsTitle')}</strong>
              {!manualToolConversationReady ? <small className="reader-ai-quick-message-empty">{t('manualToolNeedsConversation')}</small>
                : manualTools.length > 0 ? <div className="reader-ai-manual-tool-menu">
                    {manualTools.map((tool)=><button type="button" key={tool.id} disabled={active} onClick={()=>openManualToolEditor(tool)}><span>{tool.description || tool.name}</span><small>{tool.name} · {t(tool.risk==='READ_ONLY'?'toolRiskReadOnly':tool.risk==='SENSITIVE'?'toolRiskSensitive':'toolRiskWrite')}</small></button>)}
                  </div>
                : <small className="reader-ai-quick-message-empty">{t('manualToolsEmpty')}</small>}
            </div>
          </details>
          <button
            type="button"
            className={`reader-ai-web-search-toggle ${forceWebSearchNext ? 'active' : ''}`}
            aria-pressed={forceWebSearchNext}
            aria-label={t('webSearchForceNext')}
            title={t(forceWebSearchNext ? 'webSearchForceArmedDescription' : 'webSearchForceNext')}
            disabled={active}
            onClick={()=>onForceWebSearchNextChange(!forceWebSearchNext)}
          >
            <Search size={13}/>
            <span>{t(forceWebSearchNext ? 'webSearchForceArmed' : 'webSearchForceNextShort')}</span>
          </button>
          <details className="reader-ai-model-picker" ref={modelPickerRef}>
            <summary className="reader-ai-model-label" title={modelLabel}>{modelLabel}</summary>
            <div className="reader-ai-model-popover" style={{ width: modelPopoverWidth, maxWidth: 'calc(100cqw - 20px)' }}>
              <label>
                <span>{t('aiProvider')}</span>
                <select value={providerId} aria-label={t('aiProvider')} disabled={active} onChange={(event)=>onProviderChange(event.target.value)}>
                  {providers.map((provider)=><option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <label>
                <span>{t('aiModel')}</span>
                <select value={model} aria-label={t('aiModel')} disabled={active || !selectedProvider || modelOptions.length === 0} onChange={(event)=>{
                  onModelChange(event.target.value)
                  modelPickerRef.current?.removeAttribute('open')
                }}>
                  {modelOptions.length === 0 ? <option value="">{t('selectModel')}</option> : modelOptions.map((item)=><option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <small>{t('conversationModelSwitchHint')}</small>
            </div>
          </details>
        </div>
        {active
          ? <button type="button" className="reader-ai-send stop" aria-label={t('stopGenerating')} title={t('stopGenerating')} onClick={onStop}><Square size={13}/></button>
          : <button type="button" className="reader-ai-send" aria-label={t('send')} title={t('send')} disabled={!draft.trim()} onClick={submitChat}><ArrowUp size={15}/></button>}
      </div>
    </div>
  </div>
}

function ReaderAiToolActivity({
  items,
  busy,
  onDecision
}: {
  items: LlmToolActivityView[]
  busy: Record<string, boolean>
  onDecision(toolCallId: string, decision: LlmToolApprovalDecision): void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return <div className="reader-ai-tool-activity">
    {items.map((item)=>{
      const pending=item.status==='PENDING_APPROVAL'
      const working=item.status==='RUNNING'
      const riskKey=item.risk==='READ_ONLY'?'toolRiskReadOnly':item.risk==='SENSITIVE'?'toolRiskSensitive':'toolRiskWrite'
      const statusKey=item.status==='COMPLETE'?'toolStatusComplete':item.status==='DENIED'?'toolStatusDenied':item.status==='ERROR'?'toolStatusError':working?'toolStatusRunning':'toolStatusApprovalRequired'
      return <section className={`reader-ai-tool-card risk-${item.risk.toLowerCase()} status-${item.status.toLowerCase()}`} key={item.toolCallId}>
        <div className="reader-ai-tool-head">
          <div><strong>{item.name}</strong><span>{item.description||t('toolNoDescription')}</span></div>
          <div className="reader-ai-tool-badges"><span className={`reader-ai-tool-risk ${item.risk.toLowerCase()}`}>{t(riskKey)}</span><span>{t(statusKey)}</span></div>
        </div>
        <details className="reader-ai-tool-arguments" open={pending}>
          <summary>{t('toolArguments')}{item.argumentsTruncated?` · ${t('toolArgumentsTruncated')}`:''}</summary>
          <pre>{item.argumentsPreview||'{}'}</pre>
        </details>
        {item.resultPreview&&item.status!=='DENIED'?<details className="reader-ai-tool-result"><summary>{t('toolResult')}</summary><pre>{item.resultPreview}</pre></details>:null}
        {item.errorMessage?<div className="reader-ai-tool-error">{item.errorMessage}</div>:null}
        {pending?<div className="reader-ai-tool-approval">
          <span>{t(item.risk==='WRITE'?'toolApprovalWriteWarning':'toolApprovalSensitiveWarning')}</span>
          <div><button type="button" className="mini-action secondary" disabled={busy[item.toolCallId]===true} onClick={()=>onDecision(item.toolCallId,'DENY')}>{t('toolDeny')}</button><button type="button" className="mini-action" disabled={busy[item.toolCallId]===true} onClick={()=>onDecision(item.toolCallId,'APPROVE')}>{busy[item.toolCallId]?t('toolDecisionWorking'):t('toolAllowOnce')}</button></div>
        </div>:null}
      </section>
    })}
  </div>
}

function ensureChatAssistantMessage(
  messages: LlmMessageRecord[],
  identity: LlmExecutionIdentity,
  requestTask: 'CHAT' | 'ARTICLE_ANALYSIS' = 'CHAT'
): LlmMessageRecord[] {
  if (messages.some((message) => message.id === identity.assistantMessageId)) return messages
  const now = Date.now()
  return [...messages, {
    id: identity.assistantMessageId,
    conversationId: identity.conversationId,
    role: 'ASSISTANT',
    content: '',
    requestTask,
    providerId: null,
    model: null,
    reasoning: null,
    status: 'STREAMING',
    errorMessage: null,
    historyActive: true,
    webSearchStatus: null,
    webSearchQuery: null,
    webSearchProviderName: null,
    webSearchResultCount: null,
    webSearchErrorMessage: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
    tokenUsageEstimated: false,
    finishReason: null,
    createdAt: now,
    updatedAt: now
  }]
}

function applyLlmExecutionEvent(
  messages: LlmMessageRecord[],
  event: LlmExecutionEvent,
  requestTask: 'CHAT' | 'ARTICLE_ANALYSIS' = 'CHAT'
): LlmMessageRecord[] {
  const withAssistant = ensureChatAssistantMessage(messages, event, requestTask)
  return withAssistant.map((message) => {
    if (message.id !== event.assistantMessageId) return message
    const updatedAt = event.emittedAt
    if (event.type === 'STARTED') return { ...message, status: 'STREAMING', updatedAt }
    if (event.type === 'WEB_SEARCH_STATE') return {
      ...message,
      webSearchStatus: event.status,
      webSearchQuery: event.query,
      webSearchProviderName: event.providerName,
      webSearchResultCount: event.resultCount,
      webSearchErrorMessage: event.errorMessage,
      status: 'STREAMING',
      updatedAt
    }
    if (event.type === 'REASONING_DELTA') return { ...message, reasoning: `${message.reasoning ?? ''}${event.delta}`, status: 'STREAMING', updatedAt }
    if (event.type === 'CONTENT_DELTA') return { ...message, content: `${message.content}${event.delta}`, status: 'STREAMING', updatedAt }
    if (event.type === 'TERMINAL') return {
      ...message,
      status: event.finishReason === 'CANCELLED' ? 'STOPPED' : 'COMPLETE',
      finishReason: event.finishReason,
      updatedAt
    }
    if (event.type === 'ERROR') return {
      ...message,
      status: 'ERROR',
      errorMessage: event.error.message,
      finishReason: 'ERROR',
      updatedAt
    }
    return message
  })
}

function chatConversationTitle(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim()
  return compact.length <= 42 ? compact : `${compact.slice(0, 42).trimEnd()}…`
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('clipboard unavailable')
}

function formatUsageValue(value: number | null): string {
  return value == null ? '—' : value.toLocaleString()
}

function formatDurationMs(value: number | null, unavailable: string): string {
  if (value == null) return unavailable
  if (value < 1_000) return `${value} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

function AiSummaryView({
  panelState,
  summary,
  loading,
  progressStage,
  streamUpdate,
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
  onFirstVisibleValue,
  onBackToHome,
  onContinueChat,
  onClose
}: {
  panelState: ReaderAiPanelState
  summary: AiSummaryDocument | null
  loading: boolean
  progressStage: AiSummaryProgressStage | null
  streamUpdate: AiSummaryStreamUpdate | null
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
  onFirstVisibleValue(firstVisible:'reasoning'|'content'):void
  onBackToHome():void
  onContinueChat():void
  onClose():void
}):React.JSX.Element{
  const {t}=useTranslation()
  const summaryMarkdown=summary ? stripRedundantSummaryHeading(summary.summary) : ''
  const streamingSummaryMarkdown=streamUpdate?.summaryPreview ? stripRedundantSummaryHeading(streamUpdate.summaryPreview) : ''
  const hasStreamingPreview=loading&&Boolean(streamingSummaryMarkdown||streamUpdate?.reasoningPreview)
  const firstVisibleValue: 'reasoning' | 'content' | null = loading
    ? streamUpdate?.reasoningPreview ? 'reasoning' : streamingSummaryMarkdown ? 'content' : null
    : summary?.status === 'GENERATED'
      ? summary.reasoning ? 'reasoning' : summaryMarkdown ? 'content' : null
      : null
  useEffect(() => {
    if (!firstVisibleValue) return
    let paintFrame: number | null = null
    // 第一帧让 React commit 的 DOM 进入绘制；第二帧记录用户实际可见后的近似时点。
    const commitFrame = window.requestAnimationFrame(() => {
      paintFrame = window.requestAnimationFrame(() => onFirstVisibleValue(firstVisibleValue))
    })
    return () => {
      window.cancelAnimationFrame(commitFrame)
      if (paintFrame !== null) window.cancelAnimationFrame(paintFrame)
    }
  }, [firstVisibleValue, onFirstVisibleValue])
  return <ReaderAiPanelShell
    view={panelState.view}
    detailView={panelState.detailView}
    placement={placement}
    panelSize={panelSize}
    leading={<AiSummaryAccentIcon variant="panel" loading={loading}/>}
    title={t('aiSummary')}
    subtitle={summary ? `${summary.providerName} · ${summary.model}` : t('aiSummaryWorking')}
    badge={summary ? <span className="ai-summary-mode-badge">{t(summaryLengthLabelKey(summary.length))}</span> : null}
    actions={<>
      <button type="button" className="icon-button" title={t('backToAiHome')} aria-label={t('backToAiHome')} onClick={onBackToHome}><ArrowLeft size={15}/></button>
      {summary?.status==='GENERATED'&&<button type="button" className={`icon-button ${speechActive?'active':''}`} title={speechActive&&speechStatus==='speaking'?t('pauseReading'):speechActive&&speechStatus==='paused'?t('resumeReading'):t('readSummary')} aria-label={t('readSummary')} onClick={onToggleSpeech}>{speechActive&&speechStatus==='speaking'?<Pause size={15}/>:speechActive&&speechStatus==='paused'?<Play size={15}/>:<Headphones size={15}/>}</button>}
      {speechActive&&speechStatus!=='idle'&&<button type="button" className="icon-button" title={t('stopReading')} aria-label={t('stopReading')} onClick={onStopSpeech}><Square size={13}/></button>}
    </>}
    onPlacementChange={onPlacementChange}
    onPanelSizeChange={onPanelSizeChange}
    onClose={onClose}
  >
      {loading&&<AiSummaryProgressStatus stage={progressStage} elapsedSeconds={elapsedSeconds}/>}
      {hasStreamingPreview ? <>
        {streamUpdate?.reasoningPreview&&<details className="ai-reasoning ai-reasoning-streaming" open><summary>{t('aiReasoning')}</summary><pre>{streamUpdate.reasoningPreview}</pre></details>}
        {streamingSummaryMarkdown&&<SimpleMarkdown text={streamingSummaryMarkdown}/>}
        <button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button>
      </> : summary ? <>
        {summary.reasoning&&<details className="ai-reasoning"><summary>{t('aiReasoning')}</summary><pre>{summary.reasoning}</pre></details>}
        {summary.status==='NOT_NEEDED'
          ? <div className="ai-summary-not-needed"><strong>{t('aiSummaryNotNeeded')}</strong><span>{t(summary.skipReason==='local_source_already_concise'?'aiSummaryNotNeededLocal':'aiSummaryNotNeededModel')}</span></div>
          : <SimpleMarkdown text={summaryMarkdown}/>}
        {loading
          ? <button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button>
          : <div className="ai-summary-footer-actions">
              <button className="mini-action" type="button" onClick={onContinueChat}>{t('continueAsking')}</button>
              <button className="mini-action regenerate-button" type="button" onClick={onRegenerate}><RefreshCw size={13}/>{t('regenerateWithOptions')}</button>
            </div>}
      </> : <div className="ai-summary-progress-empty"><AiSummaryAccentIcon variant="panel" loading/><strong>{t(aiSummaryProgressLabelKey(progressStage))}</strong><span>{t('aiSummaryElapsed',{count:elapsedSeconds})}</span><button className="mini-action ai-summary-stop-action" type="button" onClick={onStop}><Square size={12}/>{t('stopAiSummary')}</button></div>}
  </ReaderAiPanelShell>
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

