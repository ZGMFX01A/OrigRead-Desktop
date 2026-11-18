import { ChevronDown, History, Inbox, Layers, Mail, MailOpen, Plus, RefreshCw, Rss, Search, SearchX, Star, Trash2, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleRecord, FeedRecord, GroupRecord } from '../../shared/library'
import { resolveArticleImageUrl } from '../../shared/article-image-url'
import { ArticleThumbnail, useArticleThumbnailFailures, type ArticleThumbnailFailureCache } from './ArticleThumbnail'
import { FeedIcon, type ArticleScope, type Destination } from './SourceSidebar'
import { ListTranslationButton, ListTranslationStatus, useListTranslation } from './ListTranslationControls'
import type { ListTranslationItem } from '../../shared/translation'
import { useArticleListWindow } from './useArticleListWindow'
import { articleListEstimatedRowHeight } from './article-list-window'
import { formatArticlePublishTime } from './article-publish-time'

interface ArticleListPaneProps {
  accountId?: number | null
  uiFontScale?: number
  showArticleThumbnails?: boolean
  showArticleSummaries?: boolean
  destination: Destination
  articleScope: ArticleScope
  activeScopeFeed: FeedRecord | null
  activeScopeGroup?: GroupRecord | null
  isLocalAccount?: boolean
  scopeLabel: string
  scopeArticleCount: number
  scopeUnreadCount: number
  scopeReadCount?: number
  scopeStarredCount: number
  scopeRecentCount?: number
  articleQuery: string
  filterQuery?: string
  visibleArticles: ArticleRecord[]
  thumbnailArticles?: readonly ArticleRecord[]
  feeds: FeedRecord[]
  selectedArticleId: string | null
  articleListError: string | null
  searchInputRef: RefObject<HTMLInputElement | null>
  refreshing: boolean
  refreshDisabled: boolean
  onDestinationChange: (destination: Destination) => void
  onClearScope: () => void
  onArticleQueryChange: (value: string) => void
  onRefresh: () => void
  onSelectArticle: (article: ArticleRecord) => void
  onToggleStarred: (article: ArticleRecord) => void
  onArticleContextMenu: (article: ArticleRecord, x: number, y: number) => void
  onAddSource: () => void
  onClearHistory?: () => void
  onChooseSourceScope?: () => void
  sourceSwitcherTriggerRef?: RefObject<HTMLButtonElement | null>
  sourceSwitcherOpen?: boolean
  onOpenTranslationSettings?: () => void
}

/**
 * Desktop 共用的文章列表内容。
 *
 * 三栏中作为独立 Article Pane；双栏中由 TwoPaneWorkspace 作为常态内容承载。
 * 只负责当前来源范围、文章集合过滤、搜索与文章列表。
 * SourceSidebar 只管理来源范围，避免“来源”和“文章过滤”在两个 Pane 重复出现。
 */
export const ArticleListPane = memo(function ArticleListPane({
  accountId,
  uiFontScale = 100,
  showArticleThumbnails = false,
  showArticleSummaries = true,
  destination,
  articleScope,
  activeScopeFeed,
  activeScopeGroup,
  isLocalAccount = true,
  scopeLabel,
  scopeArticleCount,
  scopeUnreadCount,
  scopeReadCount,
  scopeStarredCount,
  scopeRecentCount,
  articleQuery,
  filterQuery = articleQuery,
  visibleArticles,
  thumbnailArticles = visibleArticles,
  feeds,
  selectedArticleId,
  articleListError,
  searchInputRef,
  refreshing,
  refreshDisabled,
  onDestinationChange,
  onClearScope,
  onArticleQueryChange,
  onRefresh,
  onSelectArticle,
  onToggleStarred,
  onArticleContextMenu,
  onAddSource,
  onClearHistory,
  onChooseSourceScope,
  sourceSwitcherTriggerRef,
  sourceSwitcherOpen = false,
  onOpenTranslationSettings = () => {}
}: ArticleListPaneProps): React.JSX.Element {
  const { t } = useTranslation()
  const readCount = scopeReadCount ?? Math.max(0, scopeArticleCount - scopeUnreadCount)
  const destinationLabelKey = destination === 'all'
    ? 'allArticles'
    : destination === 'read'
      ? 'readStatus'
      : destination === 'recent'
        ? 'recentArticles'
        : destination
  const destinationCount = destination === 'all'
    ? scopeArticleCount
    : destination === 'unread'
      ? scopeUnreadCount
      : destination === 'read'
        ? readCount
        : destination === 'recent'
          ? (scopeRecentCount ?? 0)
          : scopeStarredCount
  const hasArticleQuery = filterQuery.trim().length > 0
  const hasSubscriptions = feeds.length > 0
  const searchShortcut = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'
  const articleScopeKey = articleScope.kind === 'all' ? 'all' : `${articleScope.kind}:${articleScope.id}`
  const articleListMotionKey = `${articleScopeKey}:${destination}`
  const listRef = useRef<HTMLDivElement>(null)
  const listAccountId = accountId ?? activeScopeFeed?.accountId ?? feeds[0]?.accountId ?? visibleArticles[0]?.accountId ?? ''
  const listScope = `${listAccountId}:${articleListMotionKey}:${filterQuery}`
  const thumbnailScope = `${listAccountId}:${articleScopeKey}`
  const thumbnailFailures = useArticleThumbnailFailures(thumbnailScope, thumbnailArticles, feeds, refreshing)
  const fontScale = Number.isFinite(uiFontScale) && uiFontScale > 0 ? uiFontScale : 100
  const destinationsRef = useRef<HTMLDivElement>(null)
  const [compactDestinations, setCompactDestinations] = useState(false)
  useLayoutEffect(() => {
    const element = destinationsRef.current
    if (!element) return
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.article-destination-item'))
    const update = (): void => {
      if (!(element.clientWidth > 0)) return
      const compact = buttons.some(button => {
        const label = button.querySelector('small')!
        const count = button.querySelector('strong')!
        const style = window.getComputedStyle(button)
        const padding = 2 * parseFloat(style.getPropertyValue('--destination-text-padding'))
        const gap = parseFloat(style.getPropertyValue('--destination-text-gap'))
        return label.scrollWidth + count.scrollWidth + padding + gap + 1 > button.clientWidth
      })
      setCompactDestinations(compact)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    for (const button of buttons) {
      observer?.observe(button.querySelector('small')!)
      observer?.observe(button.querySelector('strong')!)
    }
    return () => observer?.disconnect()
  }, [t, fontScale, scopeArticleCount, scopeUnreadCount, scopeStarredCount, readCount, scopeRecentCount])
  const feedsById = useMemo(() => new Map(feeds.map(feed => [feed.id, feed])), [feeds])
  const thumbnailUrls = useMemo(() => {
    const urls = new Map<string, string>()
    if (!showArticleThumbnails) return urls
    for (const article of visibleArticles) {
      const feed = feedsById.get(article.feedId)
      const url = resolveArticleImageUrl(article.imageUrl, {
        articleUrl: article.url, sourcePageUrl: feed?.sourcePageUrl, feedUrl: feed?.url
      })
      if (url) urls.set(article.id, url)
    }
    return urls
  }, [showArticleThumbnails, visibleArticles, feedsById])
  const textEstimate = articleListEstimatedRowHeight(fontScale, false, showArticleSummaries)
  const thumbnailEstimate = articleListEstimatedRowHeight(fontScale, true, showArticleSummaries)
  const estimateRowHeight = useCallback((article: ArticleRecord) =>
    thumbnailUrls.has(article.id) ? thumbnailEstimate : textEstimate, [thumbnailUrls, thumbnailEstimate, textEstimate])
  const virtual = useArticleListWindow(visibleArticles, listScope, listRef, selectedArticleId, {
    key: `${fontScale}:${showArticleThumbnails}:${showArticleSummaries}`, estimatedRowHeight: textEstimate, estimateRowHeight
  })
  const translation = useListTranslation(listScope, visibleArticles, virtual.first)
  const articlesById = useMemo(() => new Map(visibleArticles.map(article => [article.id, article])), [visibleArticles])
  const select = useCallback((article: ArticleRecord) => {
    translation.controller.stop()
    onSelectArticle(article)
  }, [translation.controller, onSelectArticle])
  const bilingual = translation.state.settings?.displayMode === 'BILINGUAL'
  const previousTranslationLayout = useRef<{ scope: string; bilingual: boolean; signatures: Map<string, string> } | null>(null)
  useLayoutEffect(() => {
    const signatures = new Map<string, string>()
    // Only cached translations are inspected on progress, not the complete article list.
    for (const id of translation.state.items.keys()) {
      const article = articlesById.get(id)
      const item = article ? translation.item(article) : null
      if (item) signatures.set(id, JSON.stringify([item.translatedTitle, item.translatedDescription]))
    }
    const previous = previousTranslationLayout.current
    previousTranslationLayout.current = { scope: listScope, bilingual, signatures }
    if (!previous || previous.scope !== listScope) return
    if (previous.bilingual !== bilingual) {
      virtual.invalidateMeasurements()
      return
    }
    const changed = new Set([...previous.signatures.keys(), ...signatures.keys()])
    const ids = [...changed].filter(id => previous.signatures.get(id) !== signatures.get(id))
    if (ids.length > 0) virtual.invalidateMeasurements(ids)
  }, [listScope, bilingual, articlesById, translation.state.items, translation.state.settings?.targetLanguage, virtual.invalidateMeasurements])
  // Keyboard/next-article navigation also leaves the screening task, not only mouse clicks.
  useEffect(() => { translation.controller.stop() }, [translation.controller, selectedArticleId])

  return (
    <section className="article-pane" aria-label={t(destinationLabelKey)} aria-busy={refreshing}>
      <header className="article-scope-bar">
        {onChooseSourceScope ? (
          <button
            ref={sourceSwitcherTriggerRef}
            type="button"
            className={`article-scope-current source-switcher-trigger ${sourceSwitcherOpen ? 'active' : ''}`}
            aria-haspopup="listbox"
            aria-expanded={sourceSwitcherOpen}
            aria-label={`${t('chooseSourceScope')}: ${scopeLabel}`}
            title={t('chooseSourceScope')}
            onClick={onChooseSourceScope}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' || sourceSwitcherOpen) return
              event.preventDefault()
              onChooseSourceScope()
            }}
          >
            {activeScopeFeed ? <FeedIcon feed={activeScopeFeed} /> : <div className="scope-icon"><Rss size={15}/></div>}
            <div className="article-scope-copy">
              <span>{t(destinationLabelKey)}</span>
              <strong>{scopeLabel}</strong>
            </div>
            <ChevronDown className="source-switcher-trigger-chevron" size={14}/>
          </button>
        ) : (
          <div className="article-scope-current">
            {activeScopeFeed ? <FeedIcon feed={activeScopeFeed} /> : <div className="scope-icon"><Rss size={15}/></div>}
            <div className="article-scope-copy">
              <span>{t(destinationLabelKey)}</span>
              <strong>{scopeLabel}</strong>
            </div>
          </div>
        )}
        <div className="article-scope-actions">
          {articleScope.kind !== 'all' && (
            <button type="button" className="icon-button" title={t('clearSourceFilter')} aria-label={t('clearSourceFilter')} onClick={onClearScope}><X size={14}/></button>
          )}
        </div>
        <div ref={destinationsRef} className={`article-scope-stats${compactDestinations ? ' icons-only' : ''}`} aria-label={t('readingScope')}>
          <button
            type="button"
            className={`article-destination-item ${destination === 'all' ? 'active' : ''}`}
            data-destination="all"
            title={`${t('allArticles')}: ${scopeArticleCount}`}
            aria-label={`${t('allArticles')}: ${scopeArticleCount}`}
            aria-current={destination === 'all' ? 'page' : undefined}
            onClick={() => onDestinationChange('all')}
          ><Layers className="article-destination-icon" size={14} aria-hidden="true"/><small>{t('allArticles')}</small><strong>{scopeArticleCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'unread' ? 'active' : ''}`}
            data-destination="unread"
            title={`${t('unread')}: ${scopeUnreadCount}`}
            aria-label={`${t('unread')}: ${scopeUnreadCount}`}
            aria-current={destination === 'unread' ? 'page' : undefined}
            onClick={() => onDestinationChange('unread')}
          ><Mail className="article-destination-icon" size={14} aria-hidden="true"/><small>{t('unread')}</small><strong>{scopeUnreadCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'starred' ? 'active' : ''}`}
            data-destination="starred"
            title={`${t('starred')}: ${scopeStarredCount}`}
            aria-label={`${t('starred')}: ${scopeStarredCount}`}
            aria-current={destination === 'starred' ? 'page' : undefined}
            onClick={() => onDestinationChange('starred')}
          ><Star className="article-destination-icon" size={14} aria-hidden="true"/><small>{t('starred')}</small><strong>{scopeStarredCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'read' ? 'active' : ''}`}
            data-destination="read"
            title={`${t('readStatus')}: ${readCount}`}
            aria-label={`${t('readStatus')}: ${readCount}`}
            aria-current={destination === 'read' ? 'page' : undefined}
            onClick={() => onDestinationChange('read')}
          ><MailOpen className="article-destination-icon" size={14} aria-hidden="true"/><small>{t('readStatus')}</small><strong>{readCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'recent' ? 'active' : ''}`}
            aria-current={destination === 'recent' ? 'page' : undefined}
            data-destination="recent"
            title={`${t('recentArticles')}: ${scopeRecentCount ?? 0}`}
            aria-label={`${t('recentArticles')}: ${scopeRecentCount ?? 0}`}
            onClick={() => onDestinationChange('recent')}
          ><History className="article-destination-icon" size={14} aria-hidden="true"/><small>{t('recentArticles')}</small><strong>{scopeRecentCount ?? 0}</strong></button>
        </div>
      </header>

      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={articleQuery}
            onChange={(event) => onArticleQueryChange(event.target.value)}
            aria-label={t('searchArticles')}
            placeholder={t('searchArticles')}
          />
          <kbd>{searchShortcut}</kbd>
        </div>
        <div className="list-meta">
          <span>{hasArticleQuery
            ? t('articleSearchResultCount', { visible: visibleArticles.length, total: destinationCount })
            : visibleArticles.length < destinationCount
              ? t('articleLoadedCount', { visible: visibleArticles.length, total: destinationCount })
              : t('articleCount', { count: destinationCount })}</span>
          <div className="article-list-actions">
            <ListTranslationButton translation={translation} onOpenSettings={onOpenTranslationSettings} />
            {destination === 'recent' && onClearHistory && (
              <button
                type="button"
                className="icon-button clear-history-button"
                aria-label={t('clearReadingHistory')}
                title={t('clearReadingHistory')}
                disabled={refreshDisabled || destinationCount === 0}
                onClick={onClearHistory}
              >
                <Trash2 size={16} />
              </button>
            )}
            {(() => {
              const refreshAriaLabel = activeScopeFeed
                ? t('refresh')
                : articleScope.kind === 'group'
                  ? (!isLocalAccount ? t('refreshRemoteGroup') : t('refreshGroup'))
                  : t('refreshAll')
              const refreshTitle = activeScopeFeed
                ? t('reloadSourceArticles')
                : articleScope.kind === 'group'
                  ? (!isLocalAccount ? t('refreshRemoteGroupTooltip') : t('refreshGroupSources'))
                  : t('refreshAll')
              return (
                <button
                  type="button"
                  className="icon-button refresh-all-button"
                  aria-label={refreshAriaLabel}
                  title={refreshTitle}
                  disabled={refreshDisabled}
                  onClick={onRefresh}
                >
                  <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
                </button>
              )
            })()}
          </div>
        </div>
        <ListTranslationStatus translation={translation} />
      </div>

      <div className="workspace-list-stage">
        {articleListError && <div className="workspace-error article-list-error" role="alert">{articleListError}</div>}
        {visibleArticles.length > 0 ? (
          <div ref={listRef} className="list-content article-list article-list-motion">
            <div aria-hidden="true" style={{ height: virtual.offsets[virtual.start] }} />
            {visibleArticles.slice(virtual.start, virtual.end).map((article) => {
              const translated = translation.item(article)
              const feed = feedsById.get(article.feedId)
              const thumbnailUrl = thumbnailUrls.get(article.id) ?? null
              return <ArticleListRow key={article.id} article={article} translated={translated} bilingual={bilingual}
                showSummary={showArticleSummaries}
                selected={selectedArticleId === article.id} feedName={feed?.name ?? ''}
                thumbnailUrl={thumbnailUrl} thumbnailFailures={thumbnailFailures}
                onMeasure={virtual.measure} onSelect={select} onToggleStarred={onToggleStarred} onContextMenu={onArticleContextMenu} />
            })}
            <div aria-hidden="true" style={{ height: virtual.offsets[visibleArticles.length]! - virtual.offsets[virtual.end]! }} />
          </div>
        ) : (
          <div key={`${articleListMotionKey}:empty`} className="empty-list-state article-list-empty article-list-motion">
            <div className="empty-icon">
              {!hasSubscriptions ? <Rss size={22} /> : hasArticleQuery ? <SearchX size={22} /> : destination === 'recent' ? <History size={22} /> : <Inbox size={22} />}
            </div>
            <h1>{!hasSubscriptions ? t('timelineEmpty') : hasArticleQuery ? t('articleSearchEmpty') : destination === 'recent' ? t('noRecentArticles') : t('readerScopeEmpty')}</h1>
            <p>{!hasSubscriptions ? t('timelineEmptyDesc') : hasArticleQuery ? t('articleSearchEmptyDesc') : destination === 'recent' ? t('noRecentArticlesDescription') : t('readerScopeEmptyDesc')}</p>
            {!hasSubscriptions ? (
              <button className="secondary-action" type="button" onClick={onAddSource}>
                <Plus size={16} />
                {t('addSourceNow')}
              </button>
            ) : hasArticleQuery ? (
              <button className="secondary-action" type="button" onClick={() => onArticleQueryChange('')}>
                <Search size={15} />
                {t('clearArticleSearch')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
})

const ArticleListRow = memo(function ArticleListRow({ article, translated, bilingual, showSummary, selected, feedName, thumbnailUrl, thumbnailFailures, onMeasure, onSelect, onToggleStarred, onContextMenu }: {
  article: ArticleRecord; translated: ListTranslationItem | null; bilingual: boolean; showSummary: boolean; selected: boolean; feedName: string
  thumbnailUrl: string | null; thumbnailFailures: ArticleThumbnailFailureCache
  onMeasure(id: string, height: number): void
  onSelect(article: ArticleRecord): void
  onToggleStarred(article: ArticleRecord): void
  onContextMenu(article: ArticleRecord, x: number, y: number): void
}) {
  const { t, i18n } = useTranslation()
  const publishTime = formatArticlePublishTime(article.publishedAt, i18n?.language)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) onMeasure(article.id, entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height + 4)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [article.id, onMeasure])
  const preview = showSummary ? <>
    <p dir="auto">{(translated && !bilingual ? translated.translatedDescription : article.description) || t('sourcePreviewUnavailable')}</p>
    {translated && bilingual && translated.translatedDescription && translated.translatedDescription !== article.description &&
      <p className="article-preview-translation" dir="auto">{translated.translatedDescription}</p>}
  </> : null
  return <div ref={ref} className="article-virtual-row">
    <article className={`article-item ${article.isUnread ? 'unread' : 'read'} ${selected ? 'selected' : ''}`}
      data-article-id={article.id} data-feed-id={article.feedId} tabIndex={0} role="button"
      aria-current={selected ? 'true' : undefined} onClick={() => onSelect(article)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(article) }
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onContextMenu(article, event.clientX, event.clientY) }}>
      <div className="article-topline">
        <span className={`unread-dot ${article.isUnread ? 'visible' : ''}`} />
        <div className="article-title-copy">
          <strong dir="auto">{translated && !bilingual ? translated.translatedTitle || article.title : article.title}</strong>
          {translated && bilingual && translated.translatedTitle && translated.translatedTitle !== article.title &&
            <strong className="article-title-translation" dir="auto">{translated.translatedTitle}</strong>}
        </div>
        <button className={`star-button ${article.isStarred ? 'active' : ''}`} type="button"
          aria-label={article.isStarred ? t('removeStar') : t('addStar')} title={article.isStarred ? t('removeStar') : t('addStar')}
          onClick={event => { event.stopPropagation(); onToggleStarred(article) }}>
          <Star size={15} fill={article.isStarred ? 'currentColor' : 'none'} />
        </button>
      </div>
      {thumbnailUrl ? <div className="article-preview-with-thumbnail">
        <div className="article-preview-copy">{preview}</div>
        <ArticleThumbnail url={thumbnailUrl} failures={thumbnailFailures} />
      </div> : preview}
      <div className="article-meta">
        <span>{feedName}</span>
        {publishTime && (
          <time className="article-publish-time" dateTime={publishTime.iso} title={publishTime.full}>
            {publishTime.relative}
          </time>
        )}
        <span>{article.isUnread ? t('unreadStatus') : t('readStatus')}</span>
      </div>
    </article>
  </div>
})
