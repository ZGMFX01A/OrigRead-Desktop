import { Inbox, Plus, RefreshCw, Rss, Search, SearchX, Star, X } from 'lucide-react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { FeedIcon, type ArticleScope, type Destination } from './SourceSidebar'

interface ArticleListPaneProps {
  destination: Destination
  articleScope: ArticleScope
  activeScopeFeed: FeedRecord | null
  scopeLabel: string
  scopeArticleCount: number
  scopeUnreadCount: number
  scopeStarredCount: number
  articleQuery: string
  visibleArticles: ArticleRecord[]
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
}

/**
 * 三栏模式中的文章列表栏。
 *
 * 只负责当前来源范围、文章集合过滤、搜索与文章列表。
 * SourceSidebar 只管理来源范围，避免“来源”和“文章过滤”在两个 Pane 重复出现。
 */
export function ArticleListPane({
  destination,
  articleScope,
  activeScopeFeed,
  scopeLabel,
  scopeArticleCount,
  scopeUnreadCount,
  scopeStarredCount,
  articleQuery,
  visibleArticles,
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
  onAddSource
}: ArticleListPaneProps): React.JSX.Element {
  const { t } = useTranslation()
  const destinationLabelKey = destination === 'all' ? 'allArticles' : destination
  const destinationCount = destination === 'all'
    ? scopeArticleCount
    : destination === 'unread'
      ? scopeUnreadCount
      : scopeStarredCount
  const hasArticleQuery = articleQuery.trim().length > 0
  const hasSubscriptions = feeds.length > 0
  const searchShortcut = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'

  return (
    <section className="article-pane" aria-label={t(destinationLabelKey)} aria-busy={refreshing}>
      <header className="article-scope-bar">
        <div className="article-scope-current">
          {activeScopeFeed ? <FeedIcon feed={activeScopeFeed} /> : <div className="scope-icon"><Rss size={15}/></div>}
          <div className="article-scope-copy">
            <span>{t(destinationLabelKey)}</span>
            <strong>{scopeLabel}</strong>
          </div>
        </div>
        <div className="article-scope-actions">
          {articleScope.kind !== 'all' && (
            <button type="button" className="icon-button" title={t('clearSourceFilter')} aria-label={t('clearSourceFilter')} onClick={onClearScope}><X size={14}/></button>
          )}
        </div>
        <div className="article-scope-stats" aria-label={t('readingScope')}>
          <button
            type="button"
            className={`article-destination-item ${destination === 'all' ? 'active' : ''}`}
            aria-current={destination === 'all' ? 'page' : undefined}
            onClick={() => onDestinationChange('all')}
          ><small>{t('allArticles')}</small><strong>{scopeArticleCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'unread' ? 'active' : ''}`}
            aria-current={destination === 'unread' ? 'page' : undefined}
            onClick={() => onDestinationChange('unread')}
          ><small>{t('unread')}</small><strong>{scopeUnreadCount}</strong></button>
          <button
            type="button"
            className={`article-destination-item ${destination === 'starred' ? 'active' : ''}`}
            aria-current={destination === 'starred' ? 'page' : undefined}
            onClick={() => onDestinationChange('starred')}
          ><small>{t('starred')}</small><strong>{scopeStarredCount}</strong></button>
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
            : t('articleCount', { count: destinationCount })}</span>
          <div className="article-list-actions">
            <button
              type="button"
              className="icon-button refresh-all-button"
              aria-label={activeScopeFeed ? t('refresh') : t('refreshAll')}
              title={activeScopeFeed ? t('reloadSourceArticles') : t('refreshAll')}
              disabled={refreshDisabled}
              onClick={onRefresh}
            >
              <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </div>
      </div>

      <div className="workspace-list-stage">
        {articleListError && <div className="workspace-error article-list-error" role="alert">{articleListError}</div>}
        {visibleArticles.length > 0 ? (
          <div className="list-content article-list">
            {visibleArticles.map((article) => (
              <article
                className={`article-item ${article.isUnread ? 'unread' : 'read'} ${selectedArticleId === article.id ? 'selected' : ''}`}
                key={article.id}
                data-article-id={article.id}
                data-feed-id={article.feedId}
                tabIndex={0}
                role="button"
                aria-current={selectedArticleId === article.id ? 'true' : undefined}
                onClick={() => onSelectArticle(article)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelectArticle(article)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onArticleContextMenu(article, event.clientX, event.clientY)
                }}
              >
                <div className="article-topline">
                  <span className={`unread-dot ${article.isUnread ? 'visible' : ''}`} />
                  <strong>{article.title}</strong>
                  <button
                    className={`star-button ${article.isStarred ? 'active' : ''}`}
                    type="button"
                    aria-label={article.isStarred ? t('removeStar') : t('addStar')}
                    title={article.isStarred ? t('removeStar') : t('addStar')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleStarred(article)
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
          <div className="empty-list-state article-list-empty">
            <div className="empty-icon">
              {!hasSubscriptions ? <Rss size={22} /> : hasArticleQuery ? <SearchX size={22} /> : <Inbox size={22} />}
            </div>
            <h1>{!hasSubscriptions ? t('timelineEmpty') : hasArticleQuery ? t('articleSearchEmpty') : t('readerScopeEmpty')}</h1>
            <p>{!hasSubscriptions ? t('timelineEmptyDesc') : hasArticleQuery ? t('articleSearchEmptyDesc') : t('readerScopeEmptyDesc')}</p>
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
}
