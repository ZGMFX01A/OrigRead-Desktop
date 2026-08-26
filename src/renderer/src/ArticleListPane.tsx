import { MoreHorizontal, Plus, RefreshCw, Rss, Search, Star, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { FeedIcon, type ArticleScope, type Destination } from './SourceSidebar'

interface ArticleListPaneProps {
  destination: Destination
  articleScope: ArticleScope
  activeScopeFeed: FeedRecord | null
  scopeLabel: string
  articleQuery: string
  visibleArticles: ArticleRecord[]
  feeds: FeedRecord[]
  selectedArticleId: string | null
  refreshing: boolean
  refreshDisabled: boolean
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
 * UI-3P.4 起只负责当前来源范围、搜索与文章列表；一级 Destination 导航固定由 SourceSidebar 承担。
 */
export function ArticleListPane({
  destination,
  articleScope,
  activeScopeFeed,
  scopeLabel,
  articleQuery,
  visibleArticles,
  feeds,
  selectedArticleId,
  refreshing,
  refreshDisabled,
  onClearScope,
  onArticleQueryChange,
  onRefresh,
  onSelectArticle,
  onToggleStarred,
  onArticleContextMenu,
  onAddSource
}: ArticleListPaneProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <section className="article-pane" aria-label={t(destination === 'all' ? 'allArticles' : destination)}>
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
            <button type="button" className="icon-button" title={t('clearSourceFilter')} aria-label={t('clearSourceFilter')} onClick={onClearScope}><X size={14}/></button>
          )}
        </div>
      </div>

      <div className="list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            value={articleQuery}
            onChange={(event) => onArticleQueryChange(event.target.value)}
            aria-label={t('searchArticles')}
            placeholder={t('searchArticles')}
          />
          <kbd>Ctrl K</kbd>
        </div>
        <div className="list-meta">
          <span>{t('articleCount', { count: visibleArticles.length })}</span>
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
            <button type="button" className="icon-button" aria-label={t('more')}>
              <MoreHorizontal size={17} />
            </button>
          </div>
        </div>
      </div>

      <div className="workspace-list-stage">
        {visibleArticles.length > 0 ? (
          <div className="list-content article-list">
            {visibleArticles.map((article) => (
              <article
                className={`article-item ${article.isUnread ? 'unread' : 'read'} ${selectedArticleId === article.id ? 'selected' : ''}`}
                key={article.id}
                data-article-id={article.id}
                data-feed-id={article.feedId}
                onClick={() => onSelectArticle(article)}
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
                    aria-label={t('starred')}
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
          <div className="empty-list-state">
            <div className="empty-icon"><Rss size={22} /></div>
            <h1>{t('timelineEmpty')}</h1>
            <p>{t('timelineEmptyDesc')}</p>
            <button className="secondary-action" type="button" onClick={onAddSource}>
              <Plus size={16} />
              {t('addSourceNow')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
