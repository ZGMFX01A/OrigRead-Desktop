import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'
import { SourceSidebar } from './SourceSidebar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (options?.count !== undefined) return `${key}:${options.count}`
      if (options?.total !== undefined && options?.unread !== undefined) {
        return `${key}:${options.total}/${options.unread}`
      }
      return key
    }
  })
}))

const roots = new Set<Root>()

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount())
  roots.clear()
  vi.unstubAllGlobals()
})

function setupDom() {
  const dom = parseHTML('<html><body><div id="root"></div></body></html>')
  const win = dom.window as unknown as Window & typeof globalThis

  class MouseEventMock extends win.Event {
    clientX: number
    clientY: number
    constructor(type: string, dict: { clientX?: number; clientY?: number; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, { bubbles: dict.bubbles ?? true, cancelable: dict.cancelable ?? true })
      this.clientX = dict.clientX ?? 0
      this.clientY = dict.clientY ?? 0
    }
  }

  ;(win as any).MouseEvent = MouseEventMock
  ;(globalThis as any).MouseEvent = MouseEventMock

  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', { platform: 'Win32' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = win.document.getElementById('root')!
  const root = createRoot(container)
  roots.add(root)
  return { root, container }
}

function makeGroup(id: string, name: string, parentId: string | null = null, sortOrder = 0): GroupRecord {
  return {
    id,
    accountId: 1,
    name,
    parentId,
    sortOrder,
    isDefault: false
  }
}

function makeFeed(id: string, name: string, groupId: string): FeedRecord {
  return {
    id,
    accountId: 1,
    groupId,
    name,
    url: `https://example.com/${id}.xml`,
    sourcePageUrl: 'https://example.com',
    sourceType: 'rss',
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: 1000,
    updatedAt: 1000
  }
}

function defaultProps() {
  return {
    articleScope: { kind: 'all' as const },
    sourceQuery: '',
    visibleFeedCount: 0,
    groupedFeeds: [],
    feedStatsById: new Map<string, FeedArticleStats>(),
    allArticleCount: 0,
    allUnreadCount: 0,
    collapsedGroupIds: new Set<string>(),
    refreshingFeedId: null,
    isRefreshingAll: false,
    subscriptionMenuOpen: false,
    opmlBusy: false,
    opmlStatus: null,
    sourceError: null,
    showNotices: false,
    onSourceQueryChange: vi.fn(),
    onSelectAll: vi.fn(),
    onSelectGroup: vi.fn(),
    onToggleGroupCollapsed: vi.fn(),
    onSelectFeed: vi.fn(),
    onRefreshFeed: vi.fn(),
    onOpenFeedSettings: vi.fn(),
    onFeedContextMenu: vi.fn(),
    onGroupContextMenu: vi.fn(),
    onShowSourceCatalog: vi.fn(),
    onToggleSubscriptionMenu: vi.fn(),
    onCloseSubscriptionMenu: vi.fn(),
    onAddSource: vi.fn(),
    onImportOpml: vi.fn(),
    onOpenOpmlExport: vi.fn()
  }
}

describe('SourceSidebar group tree rendering', () => {
  it('renders parent -> child -> grandchild hierarchy with nested containers and depth attributes', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null, 0)
    const groupChild = makeGroup('group-c', 'Child Group', 'group-p', 0)
    const groupGrandchild = makeGroup('group-gc', 'Grandchild Group', 'group-c', 0)

    const groupedFeeds = [
      { group: groupParent, feeds: [] },
      { group: groupChild, feeds: [] },
      { group: groupGrandchild, feeds: [] }
    ]

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
        />
      )
    })

    const parentSection = container.querySelector('section[data-group-id="group-p"]')
    expect(parentSection).toBeTruthy()
    expect(parentSection?.getAttribute('data-group-depth')).toBe('0')

    const childContainer = parentSection?.querySelector('.source-group-children')
    expect(childContainer).toBeTruthy()

    const childSection = childContainer?.querySelector('section[data-group-id="group-c"]')
    expect(childSection).toBeTruthy()
    expect(childSection?.getAttribute('data-group-depth')).toBe('1')

    const grandchildContainer = childSection?.querySelector('.source-group-children')
    expect(grandchildContainer).toBeTruthy()

    const grandchildSection = grandchildContainer?.querySelector('section[data-group-id="group-gc"]')
    expect(grandchildSection).toBeTruthy()
    expect(grandchildSection?.getAttribute('data-group-depth')).toBe('2')
  })

  it('aggregates source count and unread count from self and descendants, and displays feeds only in direct group', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const groupChild = makeGroup('group-c', 'Child Group', 'group-p')
    const groupGrandchild = makeGroup('group-gc', 'Grandchild Group', 'group-c')

    const feedP = makeFeed('feed-p', 'Feed P', 'group-p')
    const feedC = makeFeed('feed-c', 'Feed C', 'group-c')
    const feedGC = makeFeed('feed-gc', 'Feed GC', 'group-gc')

    const feedStatsById = new Map<string, FeedArticleStats>([
      ['feed-p', { feedId: 'feed-p', total: 10, unread: 4, starred: 0 }],
      ['feed-c', { feedId: 'feed-c', total: 20, unread: 6, starred: 0 }],
      ['feed-gc', { feedId: 'feed-gc', total: 5, unread: 3, starred: 0 }]
    ])

    const groupedFeeds = [
      { group: groupParent, feeds: [feedP] },
      { group: groupChild, feeds: [feedC] },
      { group: groupGrandchild, feeds: [feedGC] }
    ]

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          feedStatsById={feedStatsById}
        />
      )
    })

    // Parent stats: 3 feeds, 4+6+3 = 13 unread
    const parentHeader = container.querySelector('section[data-group-id="group-p"] > .source-group-header')
    expect(parentHeader?.textContent).toContain('sourceCount:3')
    expect(parentHeader?.textContent).toContain('unreadCountShort:13')

    // Child stats: 2 feeds, 6+3 = 9 unread
    const childHeader = container.querySelector('section[data-group-id="group-c"] > .source-group-header')
    expect(childHeader?.textContent).toContain('sourceCount:2')
    expect(childHeader?.textContent).toContain('unreadCountShort:9')

    // Grandchild stats: 1 feed, 3 unread
    const grandchildHeader = container.querySelector('section[data-group-id="group-gc"] > .source-group-header')
    expect(grandchildHeader?.textContent).toContain('sourceCount:1')
    expect(grandchildHeader?.textContent).toContain('unreadCountShort:3')

    // Direct feeds verification:
    // Parent's direct source-group-items contains only feed-p
    const parentDirectItems = container.querySelectorAll('section[data-group-id="group-p"] > .source-group-items > article')
    expect(parentDirectItems.length).toBe(1)
    expect(parentDirectItems[0]?.textContent).toContain('Feed P')

    // Child's direct source-group-items contains only feed-c
    const childDirectItems = container.querySelectorAll('section[data-group-id="group-c"] > .source-group-items > article')
    expect(childDirectItems.length).toBe(1)
    expect(childDirectItems[0]?.textContent).toContain('Feed C')

    // Grandchild's direct source-group-items contains only feed-gc
    const grandchildDirectItems = container.querySelectorAll('section[data-group-id="group-gc"] > .source-group-items > article')
    expect(grandchildDirectItems.length).toBe(1)
    expect(grandchildDirectItems[0]?.textContent).toContain('Feed GC')
  })

  it('deduplicates feeds across descendants when computing aggregated stats', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const groupChild = makeGroup('group-c', 'Child Group', 'group-p')

    // Duplicate feed appearing in both parent and child
    const feedShared = makeFeed('feed-dup', 'Duplicate Feed', 'group-p')
    const feedStatsById = new Map<string, FeedArticleStats>([
      ['feed-dup', { feedId: 'feed-dup', total: 10, unread: 5, starred: 0 }]
    ])

    const groupedFeeds = [
      { group: groupParent, feeds: [feedShared] },
      { group: groupChild, feeds: [feedShared] }
    ]

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          feedStatsById={feedStatsById}
        />
      )
    })

    const parentHeader = container.querySelector('section[data-group-id="group-p"] > .source-group-header')
    // Deduplicated count should be 1, unread should be 5
    expect(parentHeader?.textContent).toContain('sourceCount:1')
    expect(parentHeader?.textContent).toContain('unreadCountShort:5')
  })

  it('keeps empty parent and empty child visible with zero counts', async () => {
    const { root, container } = setupDom()
    const groupEmptyParent = makeGroup('group-empty-p', 'Empty Parent', null)
    const groupEmptyChild = makeGroup('group-empty-c', 'Empty Child', 'group-empty-p')

    const groupedFeeds = [
      { group: groupEmptyParent, feeds: [] },
      { group: groupEmptyChild, feeds: [] }
    ]

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
        />
      )
    })

    const parentSection = container.querySelector('section[data-group-id="group-empty-p"]')
    expect(parentSection).toBeTruthy()
    expect(parentSection?.textContent).toContain('Empty Parent')
    expect(parentSection?.textContent).toContain('sourceCount:0')
    expect(parentSection?.textContent).toContain('unreadCountShort:0')

    const childSection = parentSection?.querySelector('section[data-group-id="group-empty-c"]')
    expect(childSection).toBeTruthy()
    expect(childSection?.textContent).toContain('Empty Child')
    expect(childSection?.textContent).toContain('sourceCount:0')
    expect(childSection?.textContent).toContain('unreadCountShort:0')
  })

  it('hides direct feeds and child groups when parent is collapsed', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const groupChild = makeGroup('group-c', 'Child Group', 'group-p')
    const feedP = makeFeed('feed-p', 'Feed P', 'group-p')
    const feedC = makeFeed('feed-c', 'Feed C', 'group-c')

    const groupedFeeds = [
      { group: groupParent, feeds: [feedP] },
      { group: groupChild, feeds: [feedC] }
    ]

    const onToggleGroupCollapsed = vi.fn()

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          collapsedGroupIds={new Set(['group-p'])}
          onToggleGroupCollapsed={onToggleGroupCollapsed}
        />
      )
    })

    const parentSection = container.querySelector('section[data-group-id="group-p"]')
    expect(parentSection).toBeTruthy()

    // Neither direct feeds nor child sections should be rendered
    expect(parentSection?.querySelector('.source-group-items')).toBeNull()
    expect(parentSection?.querySelector('.source-group-children')).toBeNull()
    expect(container.querySelector('section[data-group-id="group-c"]')).toBeNull()

    // Collapse button should have aria-expanded="false"
    const collapseBtn = parentSection?.querySelector('.source-group-collapse') as HTMLButtonElement
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('false')

    // Click collapse button toggles collapsed state
    await act(async () => {
      collapseBtn.click()
    })
    expect(onToggleGroupCollapsed).toHaveBeenCalledWith('group-p')
  })

  it('triggers onSelectGroup and onGroupContextMenu correctly', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const groupedFeeds = [{ group: groupParent, feeds: [] }]

    const onSelectGroup = vi.fn()
    const onGroupContextMenu = vi.fn()

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          onSelectGroup={onSelectGroup}
          onGroupContextMenu={onGroupContextMenu}
        />
      )
    })

    const groupScopeBtn = container.querySelector('.source-group-scope') as HTMLButtonElement
    expect(groupScopeBtn).toBeTruthy()

    await act(async () => {
      groupScopeBtn.click()
    })
    expect(onSelectGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'group-p', name: 'Parent Group' }))

    const menuBtn = container.querySelector('.source-group-menu-button') as HTMLButtonElement
    expect(menuBtn).toBeTruthy()

    await act(async () => {
      menuBtn.click()
    })
    expect(onGroupContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'group-p' }),
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('caps visual nesting indentation at 8 levels', async () => {
    const { root, container } = setupDom()
    const groups: GroupRecord[] = []
    let parentId: string | null = null
    for (let i = 0; i < 10; i++) {
      const id = `grp-${i}`
      groups.push(makeGroup(id, `Group ${i}`, parentId))
      parentId = id
    }

    const groupedFeeds = groups.map((group) => ({ group, feeds: [] }))

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
        />
      )
    })

    const depth7Section = container.querySelector('section[data-group-depth="7"]')
    const depth7Children = depth7Section?.querySelector(':scope > .source-group-children') as HTMLElement
    expect(depth7Children).toBeTruthy()
    expect(depth7Children.style.paddingLeft).toBe('10px')

    const depth8Section = container.querySelector('section[data-group-depth="8"]')
    const depth8Children = depth8Section?.querySelector(':scope > .source-group-children') as HTMLElement
    expect(depth8Children).toBeTruthy()
    expect(depth8Children.style.paddingLeft).toMatch(/^0(px)?$/)
  })

  it('uses groupStatsById when provided to display actual scope count rather than filtered query count', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const groupedFeeds = [{ group: groupParent, feeds: [] }]

    const groupStatsById = new Map([
      ['group-p', { totalFeeds: 5, totalUnread: 12 }]
    ])

    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          groupStatsById={groupStatsById}
        />
      )
    })

    const parentHeader = container.querySelector('section[data-group-id="group-p"] > .source-group-header')
    expect(parentHeader?.textContent).toContain('sourceCount:5')
    expect(parentHeader?.textContent).toContain('unreadCountShort:12')
  })

  it('temporarily expands collapsed groups during search and restores original collapsed state when search cleared', async () => {
    const { root, container } = setupDom()
    const groupParent = makeGroup('group-p', 'Parent Group', null)
    const feedP = makeFeed('feed-p', 'Feed P', 'group-p')
    const groupedFeeds = [{ group: groupParent, feeds: [feedP] }]
    const collapsedGroupIds = new Set(['group-p'])

    // Initially collapsed
    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          collapsedGroupIds={collapsedGroupIds}
          sourceQuery=""
        />
      )
    })
    expect(container.querySelector('.source-group-items')).toBeNull()

    // When searching, group is temporarily expanded
    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          collapsedGroupIds={collapsedGroupIds}
          sourceQuery="Feed"
        />
      )
    })
    expect(container.querySelector('.source-group-items')).toBeTruthy()
    expect(container.querySelector('.source-group-items')?.textContent).toContain('Feed P')

    // When search is cleared, group returns to collapsed state
    await act(async () => {
      root.render(
        <SourceSidebar
          {...defaultProps()}
          groupedFeeds={groupedFeeds}
          collapsedGroupIds={collapsedGroupIds}
          sourceQuery=""
        />
      )
    })
    expect(container.querySelector('.source-group-items')).toBeNull()
  })
})


describe('SourceSidebar blank area context menu', () => {
  it('opens the blank-area menu without intercepting group, feed, search or all-sources actions', async () => {
    const { root, container } = setupDom()
    const props = defaultProps()
    const onBlankContextMenu = vi.fn()
    const group = makeGroup('group', 'Group')
    const feed = makeFeed('feed', 'Feed', group.id)
    await act(async () => root.render(<SourceSidebar {...props} groupedFeeds={[{ group, feeds: [feed] }]} onBlankContextMenu={onBlankContextMenu} />))
    for (const selector of ['.source-pane', '.workspace-list-stage', '.source-list']) {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 45, clientY: 350 })
      await act(async () => { container.querySelector(selector)!.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
    }
    expect(onBlankContextMenu).toHaveBeenCalledTimes(3)
    expect(onBlankContextMenu).toHaveBeenLastCalledWith(45, 350)
    for (const selector of ['.source-group-header', '.source-item', '.source-scope-all', 'input']) {
      await act(async () => { container.querySelector(selector)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    }
    expect(onBlankContextMenu).toHaveBeenCalledTimes(3)
    expect(props.onGroupContextMenu).toHaveBeenCalledTimes(1)
    expect(props.onFeedContextMenu).toHaveBeenCalledTimes(1)
  })
})
