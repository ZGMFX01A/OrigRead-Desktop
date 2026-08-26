import { BookOpenText, ChevronDown, Compass, Download, Inbox, MoreHorizontal, Plus, RefreshCw, Rss, Search, Star, Upload } from 'lucide-react'
import { useEffect, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'

export type ArticleScope =
  | { kind: 'all' }
  | { kind: 'group'; id: string }
  | { kind: 'feed'; id: string }

/** 左栏一级文章集合导航；与来源范围 ArticleScope 正交。 */
export type Destination = 'all' | 'unread' | 'starred'

const destinations: Array<{ id: Destination; icon: typeof Inbox; labelKey: string }> = [
  { id: 'all', icon: Inbox, labelKey: 'allArticles' },
  { id: 'unread', icon: BookOpenText, labelKey: 'unread' },
  { id: 'starred', icon: Star, labelKey: 'starred' }
]

interface SourceGroupEntry {
  group: GroupRecord
  feeds: FeedRecord[]
}

interface SourceSidebarProps {
  destination: Destination
  articleScope: ArticleScope
  sourceQuery: string
  visibleFeedCount: number
  groupedFeeds: SourceGroupEntry[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  allArticleCount: number
  allUnreadCount: number
  scopedArticleCount: number
  scopedUnreadCount: number
  scopedStarredCount: number
  refreshingFeedId: string | null
  isRefreshingAll: boolean
  subscriptionMenuOpen: boolean
  opmlBusy: boolean
  opmlStatus: string | null
  sourceError: string | null
  showNotices: boolean
  onDestinationChange: (destination: Destination) => void
  onSourceQueryChange: (value: string) => void
  onSelectAll: () => void
  onSelectGroup: (group: GroupRecord) => void
  onSelectFeed: (feed: FeedRecord) => void
  onRefreshFeed: (feed: FeedRecord) => void
  onOpenFeedSettings: (feed: FeedRecord) => void
  onFeedContextMenu: (feed: FeedRecord, x: number, y: number) => void
  onShowSourceCatalog: () => void
  onToggleSubscriptionMenu: () => void
  onCloseSubscriptionMenu: () => void
  onAddSource: () => void
  onImportOpml: () => void
  onOpenOpmlExport: () => void
}

/**
 * 三栏模式中的来源栏。
 *
 * 这里只负责来源范围选择和来源级操作；文章筛选与文章列表由 ArticleListPane 独立承担。
 */
export function SourceSidebar({
  destination,
  articleScope,
  sourceQuery,
  visibleFeedCount,
  groupedFeeds,
  feedStatsById,
  allArticleCount,
  allUnreadCount,
  scopedArticleCount,
  scopedUnreadCount,
  scopedStarredCount,
  refreshingFeedId,
  isRefreshingAll,
  subscriptionMenuOpen,
  opmlBusy,
  opmlStatus,
  sourceError,
  showNotices,
  onDestinationChange,
  onSourceQueryChange,
  onSelectAll,
  onSelectGroup,
  onSelectFeed,
  onRefreshFeed,
  onOpenFeedSettings,
  onFeedContextMenu,
  onShowSourceCatalog,
  onToggleSubscriptionMenu,
  onCloseSubscriptionMenu,
  onAddSource,
  onImportOpml,
  onOpenOpmlExport
}: SourceSidebarProps): React.JSX.Element {
  const { t } = useTranslation()

  const feedStats = (feedId: string): FeedArticleStats =>
    feedStatsById.get(feedId) ?? { feedId, total: 0, unread: 0, starred: 0 }

  return (
    <section className="source-pane" aria-label={t('allSources')}>
      <header className="brand-row">
        <div className="brand-lockup">
          <img className="brand-logo" src="./logo.png" alt="" />
          <div>
            <div className="brand-name">{t('brand')}</div>
            <div className="brand-tagline">{t('tagline')}</div>
          </div>
        </div>
        <div className="brand-actions">
          <button className="icon-button source-discovery-button" type="button" title={t('sourceDiscoveryTitle')} aria-label={t('sourceDiscoveryTitle')} onClick={onShowSourceCatalog}>
            <Compass size={17}/>
          </button>
          <div className="subscription-menu-anchor">
            <button className="primary-action subscription-trigger" type="button" title={t('addSubscription')} aria-label={t('addSubscription')} onClick={onToggleSubscriptionMenu} disabled={opmlBusy} aria-expanded={subscriptionMenuOpen}>
              <Plus size={14} strokeWidth={2.2} />
              {t('add')}
              <ChevronDown size={12}/>
            </button>
            {subscriptionMenuOpen && (
              <>
                <button className="subscription-menu-backdrop" type="button" aria-label={t('cancel')} onClick={onCloseSubscriptionMenu}/>
                <div className="subscription-menu" role="menu">
                  <button type="button" role="menuitem" onClick={onAddSource}><Rss size={16}/><span>{t('addSourceTitle')}</span></button>
                  <button type="button" role="menuitem" onClick={onImportOpml}><Upload size={16}/><span>{t('importOpml')}</span></button>
                  <button type="button" role="menuitem" onClick={onOpenOpmlExport}><Download size={16}/><span>{t('exportOpml')}</span></button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <nav className="source-destination-nav" aria-label={t('allArticles')}>
        {destinations.map(({ id, icon: Icon, labelKey }) => {
          const count = id === 'all' ? scopedArticleCount : id === 'unread' ? scopedUnreadCount : scopedStarredCount
          return (
            <button
              key={id}
              type="button"
              className={`source-destination-item ${destination === id ? 'active' : ''}`}
              aria-current={destination === id ? 'page' : undefined}
              onClick={() => onDestinationChange(id)}
            >
              <Icon size={16} />
              <span>{t(labelKey)}</span>
              <span className="source-destination-count">{count}</span>
            </button>
          )
        })}
      </nav>

      <div className="list-toolbar source-list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            value={sourceQuery}
            onChange={(event) => onSourceQueryChange(event.target.value)}
            aria-label={t('searchSources')}
            placeholder={t('searchSources')}
          />
        </div>
        <div className="list-meta">
          <span>{t('sourceCount', { count: visibleFeedCount })}</span>
        </div>
      </div>

      <div className="workspace-list-stage">
        {showNotices && opmlStatus && <div className="workspace-notice">{opmlStatus}</div>}
        {showNotices && sourceError && <div className="workspace-error">{sourceError}</div>}

        <div className="list-content source-list source-scope-picker">
          <button className={`source-scope-all ${articleScope.kind === 'all' ? 'selected' : ''}`} type="button" onClick={onSelectAll}>
            <div className="scope-icon"><Inbox size={15}/></div>
            <div><strong>{t('allSources')}</strong><span>{t('articleCount', { count: allArticleCount })}</span></div>
            <span className="scope-unread-count">{t('unreadCountShort', { count: allUnreadCount })}</span>
          </button>

          {groupedFeeds.map(({ group, feeds }) => {
            const groupUnread = feeds.reduce((sum, feed) => sum + feedStats(feed.id).unread, 0)
            return (
              <section className="source-group-section" key={group.id}>
                <button className={`source-group-header source-group-scope ${articleScope.kind === 'group' && articleScope.id === group.id ? 'selected' : ''}`} type="button" onClick={() => onSelectGroup(group)}>
                  <span className="source-group-name"><strong>{group.name}</strong><small>{t('sourceCount', { count: feeds.length })}</small></span>
                  <span>{t('unreadCountShort', { count: groupUnread })}</span>
                </button>
                <div className="source-group-items">
                  {feeds.map((feed) => (
                    <article
                      className={`source-item ${articleScope.kind === 'feed' && articleScope.id === feed.id ? 'selected' : ''}`}
                      key={feed.id}
                      tabIndex={0}
                      role="button"
                      onClick={() => onSelectFeed(feed)}
                      onContextMenu={(event) => handleFeedContextMenu(event, feed, onFeedContextMenu)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelectFeed(feed)
                        }
                      }}
                    >
                      <FeedIcon feed={feed} />
                      <div className="source-copy">
                        <strong>{feed.name}</strong>
                        <span>
                          <span className="source-type-inline">{feed.sourceType.toUpperCase()}</span>
                          {t('sourceArticleStats', { total: feedStats(feed.id).total, unread: feedStats(feed.id).unread })}
                        </span>
                      </div>
                      <div className="source-actions">
                        <button
                          type="button"
                          className="source-refresh-button"
                          title={t('refresh')}
                          aria-label={t('refresh')}
                          disabled={refreshingFeedId !== null || isRefreshingAll}
                          onClick={(event) => { event.stopPropagation(); onRefreshFeed(feed) }}
                        >
                          <RefreshCw size={13} className={refreshingFeedId === feed.id ? 'spinning' : ''} />
                        </button>
                        <button
                          type="button"
                          className="source-settings-button"
                          title={t('sourceSettings')}
                          aria-label={t('sourceSettings')}
                          onClick={(event) => { event.stopPropagation(); onOpenFeedSettings(feed) }}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function handleFeedContextMenu(
  event: MouseEvent<HTMLElement>,
  feed: FeedRecord,
  onFeedContextMenu: SourceSidebarProps['onFeedContextMenu']
): void {
  event.preventDefault()
  event.stopPropagation()
  onFeedContextMenu(feed, event.clientX, event.clientY)
}

/** 来源图标在两个左侧 Pane 中共用，失败时稳定回退到 RSS 图标。 */
export function FeedIcon({ feed }: { feed: FeedRecord }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [feed.icon])
  const icon = failed ? null : normalizeHttpUrl(feed.icon)
  return <div className="source-icon">{icon ? <img src={icon} alt="" onError={() => setFailed(true)}/> : <Rss size={16}/>}</div>
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
