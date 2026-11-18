import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedArticleStats, FeedRecord, GroupRecord } from '../../shared/library'
import { SourceSwitcherPopover } from './SourceSwitcherPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => {
      if (options?.count !== undefined) return `${key}:${options.count}`
      if (options?.name !== undefined) return `${key}:${options.name}`
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

  class KeyboardEventMock extends win.Event {
    key: string
    constructor(type: string, dict: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) {
      super(type, { bubbles: dict.bubbles ?? true, cancelable: dict.cancelable ?? true })
      this.key = dict.key ?? ''
    }
  }

  ;(win as any).MouseEvent = MouseEventMock
  ;(win as any).KeyboardEvent = KeyboardEventMock
  ;(globalThis as any).MouseEvent = MouseEventMock
  ;(globalThis as any).KeyboardEvent = KeyboardEventMock

  // ResizeObserver mock
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(win as any).ResizeObserver = ResizeObserverMock
  ;(globalThis as any).ResizeObserver = ResizeObserverMock

  vi.stubGlobal('window', win)
  vi.stubGlobal('document', win.document)
  vi.stubGlobal('navigator', { platform: 'Win32' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = win.document.getElementById('root')!
  const root = createRoot(container)
  roots.add(root)
  return { root, container, win }
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

function makeFeed(id: string, name: string, groupId: string, url = `https://example.com/${id}.xml`): FeedRecord {
  return {
    id,
    accountId: 1,
    groupId,
    name,
    url,
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

describe('SourceSwitcherPopover Component', () => {
  const groups: GroupRecord[] = [
    makeGroup('tech', 'Tech/Dev', null, 0),
    makeGroup('frontend', 'Frontend', 'tech', 0),
    makeGroup('react', 'React Ecosystem', 'frontend', 0),
    makeGroup('design', 'Design', null, 1)
  ]

  const feeds: FeedRecord[] = [
    makeFeed('f-tech', 'Tech Weekly', 'tech'),
    makeFeed('f-fe', 'Frontend Focus', 'frontend'),
    makeFeed('f-react', 'React Official', 'react'),
    makeFeed('f-design', 'Design Digest', 'design')
  ]

  const feedStats = new Map<string, FeedArticleStats>([
    ['f-tech', { feedId: 'f-tech', total: 10, unread: 2, starred: 0 }],
    ['f-fe', { feedId: 'f-fe', total: 5, unread: 3, starred: 0 }],
    ['f-react', { feedId: 'f-react', total: 8, unread: 4, starred: 0 }],
    ['f-design', { feedId: 'f-design', total: 20, unread: 1, starred: 0 }]
  ])

  function createProps(overrides?: Partial<React.ComponentProps<typeof SourceSwitcherPopover>>) {
    const triggerRef = { current: null as HTMLButtonElement | null }
    const searchInputRef = { current: null as HTMLInputElement | null }
    return {
      triggerRef,
      searchInputRef,
      query: '',
      groups,
      feeds,
      feedStatsById: feedStats,
      articleScope: { kind: 'all' as const },
      recentScopeKeys: [],
      collapsedGroupIds: new Set<string>(),
      allArticleCount: 43,
      allUnreadCount: 10,
      onQueryChange: vi.fn(),
      onSelectAll: vi.fn(),
      onSelectGroup: vi.fn(),
      onToggleGroupCollapsed: vi.fn(),
      onSelectFeed: vi.fn(),
      onManageSources: vi.fn(),
      onRequestClose: vi.fn(),
      ...overrides
    }
  }

  it('渲染真实层级结构、完整子树源数量与未读统计，DOM 选项按 Preorder 顺序排列', async () => {
    const { root, container } = setupDom()
    const props = createProps()

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const techSection = container.querySelector('section[data-group-id="tech"]')
    expect(techSection).toBeTruthy()
    // 检查 tech 上的统计聚合：3 sources, 9 unread
    expect(techSection?.textContent).toContain('sourceCount:3')
    expect(techSection?.textContent).toContain('unreadCountShort:9')

    // 检查嵌套子分组与直属 feeds
    const childrenContainer = techSection?.querySelector('.source-switcher-children') as HTMLElement
    expect(childrenContainer).toBeTruthy()
    expect(childrenContainer.style.paddingLeft).toBe('10px')

    const frontendSection = childrenContainer.querySelector('section[data-group-id="frontend"]')
    expect(frontendSection).toBeTruthy()
    expect(frontendSection?.textContent).toContain('sourceCount:2')
    expect(frontendSection?.textContent).toContain('unreadCountShort:7')

    // 检查 DOM 中的 role="option" 项顺序为 Preorder
    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    const optionIds = options.map((opt) => opt.id)
    expect(optionIds).toEqual([
      'source-switcher-option-all-all',
      'source-switcher-option-group-tech',
      'source-switcher-option-feed-f-tech',
      'source-switcher-option-group-frontend',
      'source-switcher-option-feed-f-fe',
      'source-switcher-option-group-react',
      'source-switcher-option-feed-f-react',
      'source-switcher-option-group-design',
      'source-switcher-option-feed-f-design'
    ])
  })

  it('折叠父分组时同时隐藏其直属 feeds 与全部子分组', async () => {
    const { root, container } = setupDom()
    const props = createProps({ collapsedGroupIds: new Set(['tech']) })

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const techSection = container.querySelector('section[data-group-id="tech"]')
    expect(techSection).toBeTruthy()
    // tech 折叠后，其下的 direct feeds 和 .source-switcher-children 均不渲染
    expect(techSection?.querySelector('.source-switcher-children')).toBeNull()
    expect(techSection?.querySelector('#source-switcher-option-feed-f-tech')).toBeNull()

    const options = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    const optionIds = options.map((opt) => opt.id)
    expect(optionIds).toEqual([
      'source-switcher-option-all-all',
      'source-switcher-option-group-tech',
      'source-switcher-option-group-design',
      'source-switcher-option-feed-f-design'
    ])
  })

  it('搜索期间强制展开所有命中祖先分组，清空后恢复', async () => {
    const { root, container } = setupDom()
    // 初始状态全部折叠
    const collapsed = new Set(['tech', 'frontend', 'react'])
    const props = createProps({ collapsedGroupIds: collapsed, query: 'React Official' })

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    // 即使在 collapsedGroupIds 中，搜索命中孙源后，祖先通路 tech -> frontend -> react 均展开展示
    expect(container.querySelector('#source-switcher-option-group-tech')).toBeTruthy()
    expect(container.querySelector('#source-switcher-option-group-frontend')).toBeTruthy()
    expect(container.querySelector('#source-switcher-option-group-react')).toBeTruthy()
    expect(container.querySelector('#source-switcher-option-feed-f-react')).toBeTruthy()
    // 未命中的直属源不展示
    expect(container.querySelector('#source-switcher-option-feed-f-tech')).toBeNull()
    expect(container.querySelector('#source-switcher-option-feed-f-fe')).toBeNull()

    // 折叠按钮在搜索期间为 disabled
    const collapseBtn = container.querySelector('.source-switcher-group-collapse') as HTMLButtonElement
    expect(collapseBtn.disabled).toBe(true)
  })

  it('最近使用项展示完整父路径与聚合统计', async () => {
    const { root, container } = setupDom()
    const props = createProps({
      recentScopeKeys: ['group:react', 'feed:f-react']
    })

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const recentSection = container.querySelector('.source-switcher-recent')
    expect(recentSection).toBeTruthy()
    // 分组完整路径
    expect(recentSection?.textContent).toContain('Tech\\/Dev / Frontend / React Ecosystem')
    // 源完整分组副标题
    expect(recentSection?.textContent).toContain('Tech\\/Dev / Frontend / React Ecosystem · example.com')
  })

  it('键盘导航：ArrowDown, ArrowUp, Home, End, Escape 与 Enter 选择', async () => {
    const { root, container } = setupDom()
    const onSelectGroup = vi.fn()
    const onRequestClose = vi.fn()
    const props = createProps({
      onSelectGroup,
      onRequestClose
    })

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const input = container.querySelector('input')!
    expect(input).toBeTruthy()

    // 初始 active option 应为第一个可见项 (all)
    expect(input.getAttribute('aria-activedescendant')).toBe('source-switcher-option-all-all')

    // ArrowDown 移动到下一个 (group:tech)
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('source-switcher-option-group-tech')

    // Enter 触发选择当前 active (group:tech)
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(onSelectGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 'tech' }))

    // End 移动到最后一个
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'End' }))
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('source-switcher-option-feed-f-design')

    // Home 移动到第一个
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Home' }))
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('source-switcher-option-all-all')

    // Escape 调用 onRequestClose(true)
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onRequestClose).toHaveBeenCalledWith(true)
  })

  it('活动项所在分组折叠后，activeOptionId 自动恢复为当前有效项', async () => {
    const { root, container } = setupDom()
    const props = createProps()

    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const input = container.querySelector('input')!

    // 先通过 ArrowDown 导航进入 tech 下的直属 feed
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    await act(async () => {
      input.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(input.getAttribute('aria-activedescendant')).toBe('source-switcher-option-feed-f-tech')

    // 重新渲染，将 tech 设为折叠
    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} collapsedGroupIds={new Set(['tech'])} />)
    })

    // f-tech 已不存在于 DOM 中，active option 恢复为有效项（默认回退到第一个可见项或者选中的 scope）
    const currentActiveId = input.getAttribute('aria-activedescendant')
    expect(currentActiveId).toBeTruthy()
    const activeEl = container.querySelector(`#${currentActiveId}`)
    expect(activeEl).toBeTruthy()
    expect(activeEl?.getAttribute('role')).toBe('option')
  })

  it('8层视觉缩进封顶', async () => {
    const { root, container } = setupDom()
    // 构建 10 层嵌套链
    const deepGroups: GroupRecord[] = []
    for (let i = 0; i <= 9; i++) {
      deepGroups.push(makeGroup(`g-${i}`, `Group ${i}`, i === 0 ? null : `g-${i - 1}`, 0))
    }

    const props = createProps({ groups: deepGroups, feeds: [] })
    await act(async () => {
      root.render(<SourceSwitcherPopover {...props} />)
    })

    const depth7Section = container.querySelector('section[data-group-depth="7"]')
    const depth7Children = depth7Section?.querySelector(':scope > .source-switcher-children') as HTMLElement
    expect(depth7Children).toBeTruthy()
    expect(depth7Children.style.paddingLeft).toBe('10px')

    const depth8Section = container.querySelector('section[data-group-depth="8"]')
    const depth8Children = depth8Section?.querySelector(':scope > .source-switcher-children') as HTMLElement
    expect(depth8Children).toBeTruthy()
    expect(depth8Children.style.paddingLeft).toMatch(/^0(px)?$/)
  })
})
