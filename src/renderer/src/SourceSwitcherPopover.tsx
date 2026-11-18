import { Check, ChevronDown, ChevronRight, Folder, Inbox, Search, SlidersHorizontal } from 'lucide-react'
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
import {
  buildSourceSwitcherTree,
  feedHost,
  getRecentSourceScopeItems,
  sanitizeOptionId,
  type SourceSwitcherGroupNode
} from './source-switcher-tree'

interface SourceSwitcherPopoverProps {
  triggerRef: RefObject<HTMLButtonElement | null>
  searchInputRef: RefObject<HTMLInputElement | null>
  query: string
  groups: GroupRecord[]
  feeds: FeedRecord[]
  feedStatsById: ReadonlyMap<string, FeedArticleStats>
  articleScope: ArticleScope
  recentScopeKeys: string[]
  collapsedGroupIds: ReadonlySet<string>
  allArticleCount: number
  allUnreadCount: number
  onQueryChange: (value: string) => void
  onSelectAll: () => void
  onSelectGroup: (group: GroupRecord) => void
  onToggleGroupCollapsed: (groupId: string) => void
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

/**
 * 双栏模式的轻量来源切换器。
 *
 * 遵循真实分组树结构递归展示：
 * - 直属源与子分组折叠同步；
 * - 8 层视觉缩进封顶；
 * - 搜索命中组包含其完整子树，后代命中保留祖先通路并临时展开；
 * - 父范围统计聚合完整 self + 后代源集（不随 query 缩水）；
 * - 键盘导航严格按 Preorder 可见项顺序遍历，折叠后活动项平滑恢复。
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
  collapsedGroupIds,
  allArticleCount,
  allUnreadCount,
  onQueryChange,
  onSelectAll,
  onSelectGroup,
  onToggleGroupCollapsed,
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

  const treeResult = useMemo(
    () => buildSourceSwitcherTree({ groups, feeds, feedStatsById, query }),
    [groups, feeds, feedStatsById, query]
  )

  const recentScopes = useMemo(
    () =>
      getRecentSourceScopeItems({
        recentScopeKeys,
        groups,
        feeds,
        feedStatsById,
        normalizedQuery
      }),
    [recentScopeKeys, groups, feeds, feedStatsById, normalizedQuery]
  )

  const allScopeMatches = !normalizedQuery || t('allSources').toLocaleLowerCase().includes(normalizedQuery)

  /** 每次 Popover 挂载都立即把键盘焦点交给 Search，避免外层 rAF 与 Trigger 点击焦点竞争。 */
  useLayoutEffect(() => {
    searchInputRef.current?.focus()
  }, [searchInputRef])

  /**
   * Search 保持真实 DOM 焦点，方向键只移动 aria-activedescendant。
   * 查询导致当前 active option 消失或分组折叠时，优先回到当前选中 Scope，否则落到第一个可见项。
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
  }, [activeOptionId, allScopeMatches, articleScope, collapsedGroupIds, treeResult, recentScopes])

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
  }, [collapsedGroupIds, feeds, groups, normalizedQuery, triggerRef])

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
    `source-switcher-option-${kind}-${sanitizeOptionId(id)}`

  /**
   * Combobox 键盘导航不会把焦点移出 Search。
   * 支持 Enter, ArrowUp, ArrowDown, Home, End, Escape。
   */
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (
      event.key !== 'ArrowDown'
      && event.key !== 'ArrowUp'
      && event.key !== 'Enter'
      && event.key !== 'Home'
      && event.key !== 'End'
      && event.key !== 'Escape'
    ) {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onRequestClose(true)
      return
    }

    const options = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
    if (options.length === 0) return

    if (event.key === 'Enter') {
      const active = options.find((option) => option.id === activeOptionId)
      if (!active) return
      event.preventDefault()
      active.click()
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      const first = options[0]
      if (first) {
        setActiveOptionId(first.id)
        first.scrollIntoView?.({ block: 'nearest' })
      }
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      const last = options[options.length - 1]
      if (last) {
        setActiveOptionId(last.id)
        last.scrollIntoView?.({ block: 'nearest' })
      }
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
    next.scrollIntoView?.({ block: 'nearest' })
  }

  const renderGroupNode = (node: SourceSwitcherGroupNode): React.JSX.Element => {
    const groupSelected = articleScope.kind === 'group' && articleScope.id === node.id
    // 搜索期间临时展开所有命中分组，避免匹配 Feed/后代被折叠隐藏；清空搜索后恢复原折叠状态。
    const collapsed = !normalizedQuery && collapsedGroupIds.has(node.id)
    const id = optionId('group', node.id)

    return (
      <section
        className="source-switcher-group"
        key={node.id}
        role="group"
        aria-label={node.name}
        data-group-id={node.id}
        data-group-depth={node.depth}
      >
        <div className="source-switcher-group-header">
          <button
            type="button"
            id={id}
            role="option"
            tabIndex={-1}
            aria-selected={groupSelected}
            className={`source-switcher-option source-switcher-group-option ${groupSelected ? 'selected' : ''} ${activeOptionId === id ? 'keyboard-active' : ''}`}
            onMouseEnter={() => setActiveOptionId(id)}
            onClick={() => onSelectGroup(node.group)}
          >
            <span className="source-switcher-icon"><Folder size={15}/></span>
            <span className="source-switcher-copy">
              <strong>{node.name}</strong>
              <small>{t('sourceCount', { count: node.totalFeeds })}</small>
            </span>
            <span className="source-switcher-meta">{t('unreadCountShort', { count: node.totalUnread })}</span>
            {groupSelected && <Check className="source-switcher-check" size={14}/>}
          </button>
          <button
            type="button"
            className="source-switcher-group-collapse"
            aria-label={t(collapsed ? 'expandSourceGroup' : 'collapseSourceGroup', { name: node.name })}
            aria-expanded={!collapsed}
            disabled={Boolean(normalizedQuery)}
            onClick={() => onToggleGroupCollapsed(node.id)}
          >
            {collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}
          </button>
        </div>

        {!collapsed && (
          <>
            {node.directFeeds.map((feed) => {
              const stats = statsFor(feed.id)
              const selected = articleScope.kind === 'feed' && articleScope.id === feed.id
              const feedOptionId = optionId('feed', feed.id)
              return (
                <button
                  type="button"
                  id={feedOptionId}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''} ${activeOptionId === feedOptionId ? 'keyboard-active' : ''}`}
                  key={feed.id}
                  onMouseEnter={() => setActiveOptionId(feedOptionId)}
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
            {node.children.length > 0 && (
              <div
                className="source-switcher-children"
                style={{ paddingLeft: node.depth < 8 ? '10px' : 0 }}
              >
                {node.children.map(renderGroupNode)}
              </div>
            )}
          </>
        )}
      </section>
    )
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
        <span>{t('sourceCount', { count: treeResult.visibleFeedCount })}</span>
      </div>

      <div id={listboxId} className="source-switcher-list" role="listbox" aria-label={t('chooseSourceScope')}>
        {recentScopes.length > 0 && (
          <section className="source-switcher-group source-switcher-recent" role="group" aria-label={t('recentSources')}>
            <div className="source-switcher-group-label">{t('recentSources')}</div>
            {recentScopes.map((recent) => {
              if (recent.kind === 'group') {
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
                    title={recent.fullLabel}
                    onMouseEnter={() => setActiveOptionId(id)}
                    onClick={() => onSelectGroup(recent.group)}
                  >
                    <span className="source-switcher-icon"><Folder size={15}/></span>
                    <span className="source-switcher-copy">
                      <strong>{recent.fullLabel}</strong>
                      <small>{t('sourceCount', { count: recent.totalFeeds })}</small>
                    </span>
                    <span className="source-switcher-meta">{t('unreadCountShort', { count: recent.totalUnread })}</span>
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
                  title={recent.feed.name}
                  onMouseEnter={() => setActiveOptionId(id)}
                  onClick={() => onSelectFeed(recent.feed)}
                >
                  <FeedIcon feed={recent.feed}/>
                  <span className="source-switcher-copy">
                    <strong>{recent.feed.name}</strong>
                    <small title={recent.fullSubtitle}>{recent.fullSubtitle}</small>
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

        {treeResult.tree.map(renderGroupNode)}

        {treeResult.ungrouped.length > 0 && (
          <section className="source-switcher-group" role="group" aria-label={t('ungroupedSources')}>
            <div className="source-switcher-group-label">{t('ungroupedSources')}</div>
            {treeResult.ungrouped.map((feed) => {
              const stats = statsFor(feed.id)
              const selected = articleScope.kind === 'feed' && articleScope.id === feed.id
              const feedOptionId = optionId('feed', feed.id)
              return (
                <button
                  type="button"
                  id={feedOptionId}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`source-switcher-option source-switcher-feed-option ${selected ? 'selected' : ''} ${activeOptionId === feedOptionId ? 'keyboard-active' : ''}`}
                  key={feed.id}
                  onMouseEnter={() => setActiveOptionId(feedOptionId)}
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

        {!allScopeMatches && !treeResult.hasResults && (
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
