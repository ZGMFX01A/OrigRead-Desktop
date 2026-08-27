import { Check, Folder, Inbox, Search, SlidersHorizontal } from 'lucide-react'
import {
  useEffect,
  useId,
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
  recentScopeKeys: string[]
  allArticleCount: number
  allUnreadCount: number
  onQueryChange: (value: string) => void
  onSelectAll: () => void
  onSelectGroup: (group: GroupRecord) => void
  onSelectFeed: (feed: FeedRecord) => void
  onManageSources: () => void
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

type RecentSourceScope =
  | { key: string; kind: 'group'; group: GroupRecord }
  | { key: string; kind: 'feed'; feed: FeedRecord }

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
  recentScopeKeys,
  allArticleCount,
  allUnreadCount,
  onQueryChange,
  onSelectAll,
  onSelectGroup,
  onSelectFeed,
  onManageSources,
  onRequestClose
}: SourceSwitcherPopoverProps): React.JSX.Element {
  const { t } = useTranslation()
  const popoverRef = useRef<HTMLElement>(null)
  const listboxId = `source-switcher-listbox-${useId().replace(/:/g, '')}`
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null)
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
  const recentScopes = useMemo<RecentSourceScope[]>(() => {
    if (normalizedQuery) return []
    const groupsById = new Map(groups.map((group) => [group.id, group]))
    const feedsById = new Map(feeds.map((feed) => [feed.id, feed]))
    return recentScopeKeys.reduce<RecentSourceScope[]>((result, key) => {
      const separator = key.indexOf(':')
      if (separator <= 0) return result
      const kind = key.slice(0, separator)
      const id = key.slice(separator + 1)
      if (kind === 'group') {
        const group = groupsById.get(id)
        if (group) result.push({ key, kind: 'group', group })
        return result
      }
      if (kind === 'feed') {
        const feed = feedsById.get(id)
        if (feed) result.push({ key, kind: 'feed', feed })
        return result
      }
      return result
    }, [])
  }, [feeds, groups, normalizedQuery, recentScopeKeys])

  /** 每次 Popover 挂载都立即把键盘焦点交给 Search，避免外层 rAF 与 Trigger 点击焦点竞争。 */
  useLayoutEffect(() => {
    searchInputRef.current?.focus()
  }, [searchInputRef])

  /**
   * Search 保持真实 DOM 焦点，方向键只移动 aria-activedescendant。
   * 查询导致当前 active option 消失时，优先回到当前选中 Scope，否则落到第一个可见项。
   */
  useLayoutEffect(() => {
    const popover = popoverRef.current
    if (!popover) return
    const options = Array.from(popover.querySelectorAll<HTMLElement>('[role="option"]'))
    if (options.length === 0) {
      setActiveOptionId(null)
      return
    }
    if (activeOptionId && options.some((option) => option.id === activeOptionId)) return
    const selected = options.find((option) => option.getAttribute('aria-selected') === 'true')
    const fallback = selected ?? options[0]
    if (fallback) setActiveOptionId(fallback.id)
  }, [activeOptionId, allScopeMatches, articleScope, matchingGroups, recentScopes])

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

  const optionId = (kind: string, id: string): string =>
    `source-switcher-option-${kind}-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`

  /** Combobox 键盘导航不会把焦点移出 Search，Enter 复用现有 click 选择链。 */
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    const options = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    if (options.length === 0) return
    if (event.key === 'Enter') {
      const active = options.find((option) => option.id === activeOptionId)
      if (!active) return
      event.preventDefault()
      active.click()
      return
    }

    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const currentIndex = options.findIndex((option) => option.id === activeOptionId)
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : options.length - 1)
      : (currentIndex + direction + options.length) % options.length
    const next = options[nextIndex]
    if (!next) return
    setActiveOptionId(next.id)
    next.scrollIntoView({ block: 'nearest' })
  }

  return (
    <section
      ref={popoverRef}
      className="source-switcher-popover"
      role="region"
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
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId ?? undefined}
          onChange={(event) => {
            setActiveOptionId(null)
            onQueryChange(event.target.value)
          }}
          onKeyDown={handleSearchKeyDown}
          aria-label={t('searchSources')}
          placeholder={t('searchSources')}
        />
        <span>{t('sourceCount', { count: visibleFeedCount })}</span>
      </div>

      <div id={listboxId} className="source-switcher-list" role="listbox" aria-label={t('chooseSourceScope')}>
        {recentScopes.length > 0 && (
          <section className="source-switcher-group source-switcher-recent" role="group" aria-label={t('recentSources')}>
            <div className="source-switcher-group-label">{t('recentSources')}</div>
            {recentScopes.map((recent) => {
              if (recent.kind === 'group') {
                const groupFeeds = feeds.filter((feed) => feed.groupId === recent.group.id)
                const unread = groupFeeds.reduce((sum, feed) => sum + statsFor(feed.id).unread, 0)
                const selected = articleScope.kind === 'group' && articleScope.id === recent.group.id
                const id = optionId('recent-group', recent.group.id)
                return (
                  <button
                    type="button"
                    id={id}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    className={`source-switcher-option source-switcher-group-option source-switcher-recent-option ${selected ? 'selected' : ''} ${activeOptionId === id ? 'keyboard-active' : ''}`}
                    key={recent.key}
                    onMouseEnter={() => setActiveOptionId(id)}
                    onClick={() => onSelectGroup(recent.group)}
                  >
                    <span className="source-switcher-icon"><Folder size={15}/></span>
                    <span className="source-switcher-copy">
                      <strong>{recent.group.name}</strong>
                      <small>{t('sourceCount', { count: groupFeeds.length })}</small>
                    </span>
                    <span className="source-switcher-meta">{t('unreadCountShort', { count: unread })}</span>
                    {selected && <Check className="source-switcher-check" size={14}/>}
                  </button>
                )
              }

              const stats = statsFor(recent.feed.id)
              const selected = articleScope.kind === 'feed' && articleScope.id === recent.feed.id
              const id = optionId('recent-feed', recent.feed.id)
              return (
                <button
                  type="button"
                  id={id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`source-switcher-option source-switcher-feed-option source-switcher-recent-option ${selected ? 'selected' : ''} ${activeOptionId === id ? 'keyboard-active' : ''}`}
                  key={recent.key}
                  onMouseEnter={() => setActiveOptionId(id)}
                  onClick={() => onSelectFeed(recent.feed)}
                >
                  <FeedIcon feed={recent.feed}/>
                  <span className="source-switcher-copy">
                    <strong>{recent.feed.name}</strong>
                    <small>{feedHost(recent.feed.url)}</small>
                  </span>
                  <span className="source-switcher-meta">{t('unreadCountShort', { count: stats.unread })}</span>
                  {selected && <Check className="source-switcher-check" size={14}/>}
                </button>
              )
            })}
          </section>
        )}

        {allScopeMatches && (
          <button
            type="button"
            id={optionId('all', 'all')}
            role="option"
            tabIndex={-1}
            aria-selected={articleScope.kind === 'all'}
            className={`source-switcher-option source-switcher-all ${articleScope.kind === 'all' ? 'selected' : ''} ${activeOptionId === optionId('all', 'all') ? 'keyboard-active' : ''}`}
            onMouseEnter={() => setActiveOptionId(optionId('all', 'all'))}
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
            <section className="source-switcher-group" key={group.id} role="group" aria-label={group.name}>
              <button
                type="button"
                id={optionId('group', group.id)}
                role="option"
                tabIndex={-1}
                aria-selected={groupSelected}
                className={`source-switcher-option source-switcher-group-option ${groupSelected ? 'selected' : ''} ${activeOptionId === optionId('group', group.id) ? 'keyboard-active' : ''}`}
                onMouseEnter={() => setActiveOptionId(optionId('group', group.id))}
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
                    id={optionId('feed', feed.id)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''} ${activeOptionId === optionId('feed', feed.id) ? 'keyboard-active' : ''}`}
                    key={feed.id}
                    onMouseEnter={() => setActiveOptionId(optionId('feed', feed.id))}
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
          <section className="source-switcher-group" role="group" aria-label={t('ungroupedSources')}>
            <div className="source-switcher-group-label">{t('ungroupedSources')}</div>
            {matchingGroups.ungrouped.map((feed) => {
              const stats = statsFor(feed.id)
              const selected = articleScope.kind === 'feed' && articleScope.id === feed.id
              return (
                <button
                  type="button"
                  id={optionId('feed', feed.id)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''} ${activeOptionId === optionId('feed', feed.id) ? 'keyboard-active' : ''}`}
                  key={feed.id}
                  onMouseEnter={() => setActiveOptionId(optionId('feed', feed.id))}
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

      <div className="source-switcher-footer">
        <button type="button" className="source-switcher-manage" onClick={onManageSources}>
          <SlidersHorizontal size={14}/>
          <span>{t('manageSources')}</span>
        </button>
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
