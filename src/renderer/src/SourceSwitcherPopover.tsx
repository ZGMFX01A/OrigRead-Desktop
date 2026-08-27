import { Check, Folder, Inbox, Search } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'
import { FeedIcon, type ArticleScope } from './SourceSidebar'

interface SourceSwitcherPopoverProps {
  triggerRef: RefObject<HTMLButtonElement | null>
  searchInputRef: RefObject<HTMLInputElement | null>
  query: string
  groups: GroupRecord[]
  feeds: FeedRecord[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  articleScope: ArticleScope
  allArticleCount: number
  allUnreadCount: number
  onQueryChange: (value: string) => void
  onSelectAll: () => void
  onSelectGroup: (group: GroupRecord) => void
  onSelectFeed: (feed: FeedRecord) => void
  onRequestClose: (restoreFocus: boolean) => void
}

interface PopoverGeometry {
  left: number
  top: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

const POPOVER_GAP = 6
const POPOVER_SAFE_EDGE = 12
const POPOVER_MAX_WIDTH = 360
const POPOVER_MIN_WIDTH = 280
const POPOVER_MAX_HEIGHT = 480

/**
 * 双栏模式的轻量来源切换器。
 *
 * 组件只承担高频 Scope 导航；不会复用完整 SourceSidebar，也不提供刷新、设置、OPML 等管理动作。
 */
export function SourceSwitcherPopover({
  triggerRef,
  searchInputRef,
  query,
  groups,
  feeds,
  feedStatsById,
  articleScope,
  allArticleCount,
  allUnreadCount,
  onQueryChange,
  onSelectAll,
  onSelectGroup,
  onSelectFeed,
  onRequestClose
}: SourceSwitcherPopoverProps): React.JSX.Element {
  const { t } = useTranslation()
  const popoverRef = useRef<HTMLElement>(null)
  const [geometry, setGeometry] = useState<PopoverGeometry>({
    left: POPOVER_SAFE_EDGE,
    top: POPOVER_SAFE_EDGE,
    width: POPOVER_MAX_WIDTH,
    maxHeight: POPOVER_MAX_HEIGHT,
    placement: 'bottom'
  })
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const matchingGroups = useMemo(() => {
    const sortedGroups = groups.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    const knownGroupIds = new Set(sortedGroups.map((group) => group.id))
    const feedMatches = (feed: FeedRecord): boolean => {
      if (!normalizedQuery) return true
      return `${feed.name} ${feedHost(feed.url)}`.toLocaleLowerCase().includes(normalizedQuery)
    }

    const entries = sortedGroups
      .map((group) => {
        const groupMatched = normalizedQuery.length > 0 && group.name.toLocaleLowerCase().includes(normalizedQuery)
        const groupFeeds = feeds.filter((feed) => feed.groupId === group.id)
        const visibleFeeds = groupMatched ? groupFeeds : groupFeeds.filter(feedMatches)
        if (normalizedQuery && !groupMatched && visibleFeeds.length === 0) return null
        return { group, feeds: visibleFeeds, groupMatched }
      })
      .filter((entry): entry is { group: GroupRecord; feeds: FeedRecord[]; groupMatched: boolean } => entry !== null)

    const ungrouped = feeds.filter((feed) => !knownGroupIds.has(feed.groupId) && feedMatches(feed))
    return { entries, ungrouped }
  }, [feeds, groups, normalizedQuery])

  const visibleFeedCount = useMemo(
    () => matchingGroups.entries.reduce((sum, entry) => sum + entry.feeds.length, 0) + matchingGroups.ungrouped.length,
    [matchingGroups]
  )
  const hasResults = matchingGroups.entries.length > 0 || matchingGroups.ungrouped.length > 0
  const allScopeMatches = !normalizedQuery || t('allSources').toLocaleLowerCase().includes(normalizedQuery)

  /** 每次 Popover 挂载都立即把键盘焦点交给 Search，避免外层 rAF 与 Trigger 点击焦点竞争。 */
  useLayoutEffect(() => {
    searchInputRef.current?.focus()
  }, [searchInputRef])

  /** Popover 相对 Workspace 内容区定位，窗口 / Workspace resize 时实时重算。 */
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const popover = popoverRef.current
    const container = trigger?.closest<HTMLElement>('.two-pane-workspace-content') ?? null
    if (!trigger || !popover || !container) return

    const updateGeometry = (): void => {
      const triggerRect = trigger.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      const width = Math.min(
        POPOVER_MAX_WIDTH,
        Math.max(POPOVER_MIN_WIDTH, Math.floor(containerRect.width - POPOVER_SAFE_EDGE * 2))
      )
      const maxHeight = Math.min(POPOVER_MAX_HEIGHT, Math.max(220, Math.floor(containerRect.height * 0.65)))
      const measuredHeight = Math.min(popover.scrollHeight || maxHeight, maxHeight)
      const triggerLeft = triggerRect.left - containerRect.left
      const left = Math.min(
        Math.max(POPOVER_SAFE_EDGE, triggerLeft),
        Math.max(POPOVER_SAFE_EDGE, containerRect.width - POPOVER_SAFE_EDGE - width)
      )
      const availableBelow = containerRect.bottom - triggerRect.bottom - POPOVER_GAP - POPOVER_SAFE_EDGE
      const availableAbove = triggerRect.top - containerRect.top - POPOVER_GAP - POPOVER_SAFE_EDGE
      const placement: 'top' | 'bottom' = availableBelow >= Math.min(measuredHeight, 260) || availableBelow >= availableAbove
        ? 'bottom'
        : 'top'
      const top = placement === 'bottom'
        ? Math.min(
            triggerRect.bottom - containerRect.top + POPOVER_GAP,
            Math.max(POPOVER_SAFE_EDGE, containerRect.height - POPOVER_SAFE_EDGE - measuredHeight)
          )
        : Math.max(
            POPOVER_SAFE_EDGE,
            triggerRect.top - containerRect.top - POPOVER_GAP - measuredHeight
          )

      setGeometry((current) => {
        if (
          current.left === left
          && current.top === top
          && current.width === width
          && current.maxHeight === maxHeight
          && current.placement === placement
        ) return current
        return { left, top, width, maxHeight, placement }
      })
    }

    updateGeometry()
    const resizeObserver = new ResizeObserver(updateGeometry)
    resizeObserver.observe(container)
    resizeObserver.observe(trigger)
    window.addEventListener('resize', updateGeometry)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateGeometry)
    }
  }, [feeds, groups, normalizedQuery, triggerRef])

  /** 点击 Popover / Trigger 之外的区域只关闭切换器，不抢走用户刚点击目标的焦点。 */
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      onRequestClose(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onRequestClose, triggerRef])

  const statsFor = (feedId: string): FeedArticleStats =>
    feedStatsById.get(feedId) ?? { feedId, total: 0, unread: 0, starred: 0 }

  return (
    <section
      ref={popoverRef}
      className="source-switcher-popover"
      role="dialog"
      aria-modal="false"
      aria-label={t('chooseSourceScope')}
      data-placement={geometry.placement}
      style={{
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        maxHeight: geometry.maxHeight
      }}
    >
      <div className="source-switcher-search">
        <Search size={15}/>
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={t('searchSources')}
          placeholder={t('searchSources')}
        />
        <span>{t('sourceCount', { count: visibleFeedCount })}</span>
      </div>

      <div className="source-switcher-list">
        {allScopeMatches && (
          <button
            type="button"
            className={`source-switcher-option source-switcher-all ${articleScope.kind === 'all' ? 'selected' : ''}`}
            aria-current={articleScope.kind === 'all' ? 'true' : undefined}
            onClick={onSelectAll}
          >
            <span className="source-switcher-icon"><Inbox size={15}/></span>
            <span className="source-switcher-copy">
              <strong>{t('allSources')}</strong>
              <small>{t('articleCount', { count: allArticleCount })}</small>
            </span>
            <span className="source-switcher-meta">{t('unreadCountShort', { count: allUnreadCount })}</span>
            {articleScope.kind === 'all' && <Check className="source-switcher-check" size={14}/>}
          </button>
        )}

        {matchingGroups.entries.map(({ group, feeds: groupFeeds }) => {
          const groupUnread = groupFeeds.reduce((sum, feed) => sum + statsFor(feed.id).unread, 0)
          const groupSelected = articleScope.kind === 'group' && articleScope.id === group.id
          return (
            <section className="source-switcher-group" key={group.id}>
              <button
                type="button"
                className={`source-switcher-option source-switcher-group-option ${groupSelected ? 'selected' : ''}`}
                aria-current={groupSelected ? 'true' : undefined}
                onClick={() => onSelectGroup(group)}
              >
                <span className="source-switcher-icon"><Folder size={15}/></span>
                <span className="source-switcher-copy">
                  <strong>{group.name}</strong>
                  <small>{t('sourceCount', { count: groupFeeds.length })}</small>
                </span>
                <span className="source-switcher-meta">{t('unreadCountShort', { count: groupUnread })}</span>
                {groupSelected && <Check className="source-switcher-check" size={14}/>}
              </button>

              {groupFeeds.map((feed) => {
                const stats = statsFor(feed.id)
                const selected = articleScope.kind === 'feed' && articleScope.id === feed.id
                return (
                  <button
                    type="button"
                    className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''}`}
                    aria-current={selected ? 'true' : undefined}
                    key={feed.id}
                    onClick={() => onSelectFeed(feed)}
                  >
                    <FeedIcon feed={feed}/>
                    <span className="source-switcher-copy">
                      <strong>{feed.name}</strong>
                      <small>{feedHost(feed.url)}</small>
                    </span>
                    <span className="source-switcher-meta">{t('unreadCountShort', { count: stats.unread })}</span>
                    {selected && <Check className="source-switcher-check" size={14}/>}
                  </button>
                )
              })}
            </section>
          )
        })}

        {matchingGroups.ungrouped.length > 0 && (
          <section className="source-switcher-group">
            <div className="source-switcher-group-label">{t('ungroupedSources')}</div>
            {matchingGroups.ungrouped.map((feed) => {
              const stats = statsFor(feed.id)
              const selected = articleScope.kind === 'feed' && articleScope.id === feed.id
              return (
                <button
                  type="button"
                  className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  key={feed.id}
                  onClick={() => onSelectFeed(feed)}
                >
                  <FeedIcon feed={feed}/>
                  <span className="source-switcher-copy">
                    <strong>{feed.name}</strong>
                    <small>{feedHost(feed.url)}</small>
                  </span>
                  <span className="source-switcher-meta">{t('unreadCountShort', { count: stats.unread })}</span>
                  {selected && <Check className="source-switcher-check" size={14}/>}
                </button>
              )
            })}
          </section>
        )}

        {!allScopeMatches && !hasResults && (
          <div className="source-switcher-empty">
            <Search size={18}/>
            <strong>{t('sourceSwitcherNoResults')}</strong>
            <span>{t('sourceSwitcherNoResultsHint')}</span>
          </div>
        )}
      </div>
    </section>
  )
}

/** 来源切换器只展示简短 host，避免完整 URL 占据有限 Popover 宽度。 */
function feedHost(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}
