import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Languages,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  Star,
  Rss,
  Inbox,
  ExternalLink,
  RefreshCw,
  Settings,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import { resolveDesktopLanguage } from '../../shared/locale'
import type { ArticleRecord, FeedRecord, LibrarySnapshot } from '../../shared/library'
import type { DesktopSettings } from '../../shared/settings'
import type { SourceDiscoveryResult } from '../../shared/source-discovery'
import type { ReaderArticleContent } from '../../shared/reader'
import type { SyncRuntimeState } from '../../shared/sync-runtime'
import type { OriginalArticleViewState, OriginalViewBounds } from '../../shared/original-view'
import { SettingsPanel } from './SettingsPanel'

type Destination = 'all' | 'unread' | 'starred' | 'sources'

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
  const [articles, setArticles] = useState<ArticleRecord[]>([])
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [query, setQuery] = useState('')
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [syncRuntimeState, setSyncRuntimeState] = useState<SyncRuntimeState | null>(null)
  const [originalViewState, setOriginalViewState] = useState<OriginalArticleViewState>(closedOriginalState())
  const readerStageRef = useRef<HTMLDivElement>(null)
  const lastObservedSyncFinish = useRef<number | null>(null)

  const reloadLibrary = useCallback(async (): Promise<void> => {
    const [snapshot, loadedFeeds, loadedArticles] = await Promise.all([
      window.origread.getLibrarySnapshot(),
      window.origread.listFeeds(),
      window.origread.listArticles()
    ])
    setLibrarySnapshot(snapshot)
    setFeeds(loadedFeeds)
    setArticles(loadedArticles)
  }, [])

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
      setWorkspaceCollapsed(loadedSettings.workspaceCollapsed)
      const language = loadedSettings.language === 'system'
        ? resolveDesktopLanguage(info.locale)
        : loadedSettings.language
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
      if (!normalizedQuery) return true
      return `${article.title} ${article.author ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)
    })
  }, [articles, destination, normalizedQuery])
  const visibleFeeds = useMemo(() => {
    if (destination !== 'sources') return []
    if (!normalizedQuery) return feeds
    return feeds.filter((feed) => `${feed.name} ${feed.url}`.toLocaleLowerCase().includes(normalizedQuery))
  }, [destination, feeds, normalizedQuery])
  const selectedArticle = articles.find((article) => article.id === selectedArticleId) ?? null
  const selectedFeed = selectedArticle ? feeds.find((feed) => feed.id === selectedArticle.feedId) ?? null : null
  const originalUrl = normalizeHttpUrl(selectedArticle?.url)

  const toggleWorkspace = (): void => {
    const next = !workspaceCollapsed
    setWorkspaceCollapsed(next)
    setSettings((current) => current ? { ...current, workspaceCollapsed: next } : current)
    void window.origread.updateSettings({ workspaceCollapsed: next })
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

  const selectArticle = (article: ArticleRecord): void => {
    if (settingsOpen) setSettingsOpen(false)
    if (originalViewState.open) void closeOriginalArticle()
    setSelectedArticleId(article.id)
    if (!article.isUnread) return
    setArticles((current) => current.map((item) => item.id === article.id ? { ...item, isUnread: false } : item))
    setLibrarySnapshot((current) => current ? { ...current, unread: Math.max(0, current.unread - 1) } : current)
    void window.origread.setArticleUnread(article.id, false)
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

  const openAddSource = (): void => {
    setSourceError(null)
    setSourceDiscovery(null)
    setSelectedCandidateId(null)
    setAddSourceOpen(true)
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
    '--reader-content-width': `${settings?.readerContentWidth ?? 760}px`
  } as CSSProperties

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
            <button className="primary-action" type="button" onClick={openAddSource}>
              <Plus size={16} strokeWidth={2.2} />
              {t('addSubscription')}
            </button>
          </header>

          <nav className="destination-tabs" aria-label="Article filters">
            {destinations.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                type="button"
                className={`destination-tab ${destination === id ? 'active' : ''}`}
                onClick={() => setDestination(id)}
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

          {sourceError && !addSourceOpen && (
            <div className="workspace-error">{sourceError}</div>
          )}

          {destination === 'sources' && visibleFeeds.length > 0 ? (
            <div className="list-content">
              {visibleFeeds.map((feed) => (
                <article className="source-item" key={feed.id}>
                  <div className="source-icon"><Rss size={16} /></div>
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
                      onClick={() => void refreshFeed(feed)}
                    >
                      <RefreshCw size={13} className={refreshingFeedId === feed.id ? 'spinning' : ''} />
                    </button>
                  </div>
                </article>
              ))}
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
            {settingsOpen ? t('settings') : originalViewState.open ? (originalViewState.title || t('original')) : t('reader')}
          </div>
          <div className="reader-actions">
            {settingsOpen ? (
              <button type="button" className="settings-close-button" onClick={() => setSettingsOpen(false)}>
                <X size={17} /><span>{t('closeSettings')}</span>
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
                <button type="button" disabled><Sparkles size={17} /><span>{t('aiSummary')}</span></button>
                <button type="button" disabled><Languages size={17} /><span>{t('translation')}</span></button>
                <button
                  type="button"
                  className="full-content-button"
                  disabled={!selectedArticle || selectedFeed?.sourceType !== 'rss' || !originalUrl || readerContentLoading || readerContent?.mode === 'full'}
                  onClick={() => void fetchSelectedFullContent()}
                >
                  <BookOpenText size={17} /><span>{t('fullContent')}</span>
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
            />
          </>
        ) : selectedArticle ? (
          <div className="reader-content">
            <div className="article-heading">
              <span>{selectedFeed?.name ?? ''}</span>
              <h1>{selectedArticle.title}</h1>
              <div>{selectedArticle.author ?? ''}</div>
            </div>
            {readerContentLoading ? (
              <div className="article-body-status">{t('loadingContent')}</div>
            ) : readerContentError ? (
              <div className="article-body-status error">{t('readerContentFailed')}: {readerContentError}</div>
            ) : readerContent?.html ? (
              <div
                className="article-body"
                onClick={(event) => {
                  const target = event.target as HTMLElement
                  const anchor = target.closest('a[href]')
                  if (!anchor) return
                  const url = normalizeHttpUrl(anchor.getAttribute('href'))
                  if (!url) return
                  event.preventDefault()
                  void openExternal(url)
                }}
                // HTML 只来自 main 进程 ReaderContentService，经 ContentHtmlSanitizer 清洗后才进入 Renderer。
                dangerouslySetInnerHTML={{ __html: readerContent.html }}
              />
            ) : (
              <div className="article-body-status">{selectedArticle.description || t('noSummary')}</div>
            )}
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
    </main>
  )
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

