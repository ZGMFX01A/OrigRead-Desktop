import { ChevronDown, ChevronRight, Compass, Download, Inbox, MoreHorizontal, Plus, RefreshCw, Rss, Search, Upload } from 'lucide-react'
import { useEffect, useState, type MouseEvent, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'

export type ArticleScope =
  | { kind: 'all' }
  | { kind: 'group'; id: string }
  | { kind: 'feed'; id: string }

/** Article Pane 使用的文章集合过滤状态；与来源范围 ArticleScope 正交。 */
export type Destination = 'all' | 'unread' | 'starred'

interface SourceGroupEntry {
  group: GroupRecord
  feeds: FeedRecord[]
}

interface SourceSidebarProps {
  articleScope: ArticleScope
  sourceQuery: string
  visibleFeedCount: number
  groupedFeeds: SourceGroupEntry[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  allArticleCount: number
  allUnreadCount: number
  collapsedGroupIds: ReadonlySet<string>
  refreshingFeedId: string | null
  isRefreshingAll: boolean
  subscriptionMenuOpen: boolean
  opmlBusy: boolean
  opmlStatus: string | null
  sourceError: string | null
  showNotices: boolean
  onSourceQueryChange: (value: string) => void
  onSelectAll: () => void
  onSelectGroup: (group: GroupRecord) => void
  onToggleGroupCollapsed: (groupId: string) => void
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
  showHeader?: boolean
  searchInputRef?: RefObject<HTMLInputElement | null>
}

interface SourceBrandHeaderProps {
  subscriptionMenuOpen: boolean
  opmlBusy: boolean
  onShowSourceCatalog: () => void
  onToggleSubscriptionMenu: () => void
  onCloseSubscriptionMenu: () => void
  onAddSource: () => void
  onImportOpml: () => void
  onOpenOpmlExport: () => void
}

/** Source 与双栏 Workspace 共用的品牌和订阅操作区，避免两套布局复制入口行为。 */
export function SourceBrandHeader({
  subscriptionMenuOpen,
  opmlBusy,
  onShowSourceCatalog,
  onToggleSubscriptionMenu,
  onCloseSubscriptionMenu,
  onAddSource,
  onImportOpml,
  onOpenOpmlExport
}: SourceBrandHeaderProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
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
          <button className="primary-action subscription-trigger" type="button" title={t('addSubscription')} aria-label={t('addSubscription')} aria-haspopup="menu" onClick={onToggleSubscriptionMenu} disabled={opmlBusy} aria-expanded={subscriptionMenuOpen}>
            <Plus size={14} strokeWidth={2.2} />
            <span className="subscription-trigger-label">{t('add')}</span>
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
  )
}

/**
 * Desktop 共用的来源范围内容。
 *
 * 三栏中直接作为常驻 Source Pane；双栏只在低频 Source Manager 中复用完整管理能力。
 * 高频来源切换由独立 SourceSwitcherPopover 负责，避免再次把完整来源页当成快速导航。
 * 这里只负责来源范围选择和来源级操作；文章筛选与文章列表由 ArticleListPane 独立承担。
 */
export function SourceSidebar({
  articleScope,
  sourceQuery,
  visibleFeedCount,
  groupedFeeds,
  feedStatsById,
  allArticleCount,
  allUnreadCount,
  collapsedGroupIds,
  refreshingFeedId,
  isRefreshingAll,
  subscriptionMenuOpen,
  opmlBusy,
  opmlStatus,
  sourceError,
  showNotices,
  onSourceQueryChange,
  onSelectAll,
  onSelectGroup,
  onToggleGroupCollapsed,
  onSelectFeed,
  onRefreshFeed,
  onOpenFeedSettings,
  onFeedContextMenu,
  onShowSourceCatalog,
  onToggleSubscriptionMenu,
  onCloseSubscriptionMenu,
  onAddSource,
  onImportOpml,
  onOpenOpmlExport,
  showHeader = true,
  searchInputRef
}: SourceSidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const sourceSearchActive = sourceQuery.trim().length > 0

  const feedStats = (feedId: string): FeedArticleStats =>
    feedStatsById.get(feedId) ?? { feedId, total: 0, unread: 0, starred: 0 }

  return (
    <section className={`source-pane ${showHeader ? '' : 'embedded-source-pane'}`.trim()} aria-label={t('allSources')}>
      {showHeader && (
        <SourceBrandHeader
          subscriptionMenuOpen={subscriptionMenuOpen}
          opmlBusy={opmlBusy}
          onShowSourceCatalog={onShowSourceCatalog}
          onToggleSubscriptionMenu={onToggleSubscriptionMenu}
          onCloseSubscriptionMenu={onCloseSubscriptionMenu}
          onAddSource={onAddSource}
          onImportOpml={onImportOpml}
          onOpenOpmlExport={onOpenOpmlExport}
        />
      )}

      <div className="list-toolbar source-list-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            ref={searchInputRef}
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
        {showNotices && opmlStatus && <div className="workspace-notice" role="status" aria-live="polite">{opmlStatus}</div>}
        {showNotices && sourceError && <div className="workspace-error" role="alert">{sourceError}</div>}

        <div className="list-content source-list source-scope-picker">
          <button className={`source-scope-all ${articleScope.kind === 'all' ? 'selected' : ''}`} type="button" aria-current={articleScope.kind === 'all' ? 'true' : undefined} onClick={onSelectAll}>
            <div className="scope-icon"><Inbox size={15}/></div>
            <div><strong>{t('allSources')}</strong><span>{t('articleCount', { count: allArticleCount })}</span></div>
            <span className="scope-unread-count">{t('unreadCountShort', { count: allUnreadCount })}</span>
          </button>

          {groupedFeeds.map(({ group, feeds }) => {
            const groupUnread = feeds.reduce((sum, feed) => sum + feedStats(feed.id).unread, 0)
            // 搜索来源时临时展开所有命中分组，避免“搜索到了但被折叠隐藏”的假空结果。
            // 分组的原始折叠状态仍保留，清空搜索后自动恢复。
            const collapsed = !sourceSearchActive && collapsedGroupIds.has(group.id)
            return (
              <section className="source-group-section" key={group.id}>
                <div className="source-group-header">
                  <button
                    className="source-group-collapse"
                    type="button"
                    aria-label={t(collapsed ? 'expandSourceGroup' : 'collapseSourceGroup', { name: group.name })}
                    aria-expanded={!collapsed}
                    disabled={sourceSearchActive}
                    onClick={() => onToggleGroupCollapsed(group.id)}
                  >
                    {collapsed ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}
                  </button>
                  <button
                    className={`source-group-scope ${articleScope.kind === 'group' && articleScope.id === group.id ? 'selected' : ''}`}
                    type="button"
                    aria-current={articleScope.kind === 'group' && articleScope.id === group.id ? 'true' : undefined}
                    title={group.name}
                    onClick={() => onSelectGroup(group)}
                  >
                    <span className="source-group-name"><strong>{group.name}</strong><small>{t('sourceCount', { count: feeds.length })}</small></span>
                    <span>{t('unreadCountShort', { count: groupUnread })}</span>
                  </button>
                </div>
                {!collapsed && <div className="source-group-items">
                  {feeds.map((feed) => (
                    <article
                      className={`source-item ${articleScope.kind === 'feed' && articleScope.id === feed.id ? 'selected' : ''}`}
                      key={feed.id}
                      tabIndex={0}
                      role="button"
                      aria-current={articleScope.kind === 'feed' && articleScope.id === feed.id ? 'true' : undefined}
                      title={feed.name}
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
                </div>}
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
