import { act, useCallback, useRef, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import type { ListTranslationItem } from '../../shared/translation'

const translationMock = vi.hoisted(() => ({ useListTranslation: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ListTranslationControls', () => ({
  useListTranslation: translationMock.useListTranslation,
  ListTranslationButton: () => null,
  ListTranslationStatus: () => null
}))
import { ArticleListPane } from './ArticleListPane'
import { ArticleThumbnail, ArticleThumbnailFailureCache } from './ArticleThumbnail'
import { useArticleListWindow } from './useArticleListWindow'
import { captureArticleListAnchor } from './article-list-window'

const translationState = {
  items: new Map<string, ListTranslationItem>(),
  settings: undefined as { displayMode: 'TRANSLATED' | 'BILINGUAL'; targetLanguage: string } | undefined
}
const roots = new Set<Root>()
const noop = () => {}

beforeEach(() => {
  vi.stubGlobal('navigator', { platform: 'Win32' })
  translationState.items.clear()
  translationState.settings = undefined
  translationMock.useListTranslation.mockReset().mockReturnValue({
    state: translationState,
    controller: { stop: noop },
    item: (article: ArticleRecord) => translationState.items.get(article.id) ?? null
  })
})

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount())
  roots.clear()
  vi.unstubAllGlobals()
})

function article(index = 0, overrides: Partial<ArticleRecord> = {}): ArticleRecord {
  return {
    id: 'article-' + index, accountId: 1, feedId: 'feed', title: 'Title ' + index,
    url: 'https://example.com/news/story-' + index, author: null, publishedAt: index, description: 'Preview',
    contentHtml: null, fullContentHtml: null, imageUrl: 'https://cdn.example/cover-' + index + '.jpg',
    isUnread: true, isStarred: false, createdAt: index, updatedAt: index, ...overrides
  }
}

function feed(): FeedRecord {
  return {
    id: 'feed', accountId: 1, groupId: 'group', name: 'Source', url: 'https://feed.example/rss',
    sourcePageUrl: 'https://source.example/news/', sourceType: 'rss', icon: null,
    isNotification: false, isFullContent: false, isBrowser: false, dynamicRendering: false,
    createdAt: 0, updatedAt: 0
  }
}

function renderList(articles: ArticleRecord[], overrides: Partial<ComponentProps<typeof ArticleListPane>> = {}): string {
  return renderToStaticMarkup(<ArticleListPane destination="all" articleScope={{ kind: 'all' }}
    activeScopeFeed={null} scopeLabel="All" scopeArticleCount={articles.length}
    scopeUnreadCount={articles.length} scopeStarredCount={0} articleQuery="" visibleArticles={articles}
    feeds={[]} selectedArticleId={null} articleListError={null} searchInputRef={{ current: null }}
    refreshing={false} refreshDisabled={false} onDestinationChange={noop} onClearScope={noop}
    onArticleQueryChange={noop} onRefresh={noop} onSelectArticle={noop} onToggleStarred={noop}
    onArticleContextMenu={noop} onAddSource={noop} {...overrides} />)
}

function markup(html: string): Document {
  return parseHTML('<html><body>' + html + '</body></html>').document
}

describe('article list thumbnails', () => {
  it.each([false, true])('bounds mounted rows and images for 10,000 articles with thumbnails=%s', showArticleThumbnails => {
    const articles = Array.from({ length: 10_000 }, (_, index) => article(index))
    const document = markup(renderList(articles, { showArticleThumbnails }))
    const mounted = document.querySelectorAll('[data-article-id]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(40)
    expect(document.querySelectorAll('.article-thumbnail img')).toHaveLength(showArticleThumbnails ? mounted : 0)
    expect(document.body.textContent).toContain('Title 0')
  })

  it('keeps the existing text-only layout by default', () => {
    const document = markup(renderList([article()]))
    expect(document.querySelector('.article-thumbnail')).toBeNull()
    expect(document.querySelector('.article-preview-with-thumbnail')).toBeNull()
    expect(document.querySelector('.article-item > p')?.textContent).toBe('Preview')
  })

  it('keeps title and star above the image/preview row, with metadata below', () => {
    const document = markup(renderList([article()], { showArticleThumbnails: true }))
    const row = document.querySelector('.article-item')!
    const preview = row.querySelector('.article-preview-with-thumbnail')!
    const image = preview.querySelector('img')!
    expect(row.querySelector('.article-topline .article-title-copy strong')?.textContent).toBe('Title 0')
    expect(row.querySelector('.article-topline .star-button')).not.toBeNull()
    expect(row.querySelector('.article-topline img')).toBeNull()
    expect(preview.querySelector('.article-preview-copy')?.textContent).toBe('Preview')
    expect(preview.nextElementSibling?.className).toBe('article-meta')
    expect(image.getAttribute('width')).toBe('80')
    expect(image.getAttribute('height')).toBe('60')
    expect(image.getAttribute('loading')).toBe('lazy')
    expect(image.getAttribute('decoding')).toBe('async')
    expect(image.getAttribute('alt')).toBe('')
  })

  it('uses feed source metadata for legacy relative image URLs and leaves invalid or missing images as text', () => {
    const document = markup(renderList([
      article(0, { url: null, imageUrl: 'cover.jpg' }),
      article(1, { imageUrl: null }),
      article(2, { imageUrl: 'javascript:alert(1)' }),
      article(3, { imageUrl: 'data:image/png;base64,AAAA' })
    ], { showArticleThumbnails: true, feeds: [feed()] }))
    expect(document.querySelectorAll('.article-thumbnail img')).toHaveLength(1)
    expect(document.querySelector('.article-thumbnail img')?.getAttribute('src')).toBe('https://source.example/news/cover.jpg')
    expect(document.querySelector('[data-article-id="article-1"] .article-preview-with-thumbnail')).toBeNull()
  })

  it('does not change the translation scope when font size or thumbnails change', () => {
    const articles = [article()]
    renderList(articles, { uiFontScale: 100, showArticleThumbnails: false })
    renderList(articles, { uiFontScale: 150, showArticleThumbnails: true })
    expect(translationMock.useListTranslation.mock.calls[0]?.[0]).toBe(translationMock.useListTranslation.mock.calls[1]?.[0])
  })

  it('keeps both translated titles and previews alongside one thumbnail in bilingual mode', () => {
    translationState.settings = { displayMode: 'BILINGUAL', targetLanguage: 'zh' }
    translationState.items.set('article-0', {
      articleId: 'article-0', accountId: 1, feedId: 'feed', title: 'Title 0', description: 'Preview',
      translatedTitle: '翻译标题', translatedDescription: '翻译摘要', language: 'zh',
      target: { type: 'traditional', provider: 'MICROSOFT' }, cacheKey: null, expiresAt: Date.now() + 60_000,
      showTranslation: true, cacheWriteFailed: false
    })
    const document = markup(renderList([article()], { showArticleThumbnails: true }))
    expect(document.querySelectorAll('.article-title-copy strong')).toHaveLength(2)
    expect(document.querySelectorAll('.article-preview-copy p')).toHaveLength(2)
    expect(document.querySelector('.article-preview-translation')?.textContent).toBe('翻译摘要')
    expect(document.querySelectorAll('.article-thumbnail img')).toHaveLength(1)
  })
})

describe('thumbnail failures', () => {
  function mount(): { root: Root; container: HTMLElement; window: ReturnType<typeof parseHTML> } {
    const window = parseHTML('<html><body><div id="root"></div></body></html>')
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', window.document)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = window.document.getElementById('root')!
    const root = createRoot(container)
    roots.add(root)
    return { root, container, window }
  }

  it('keeps a stable failed placeholder across virtual remounts and retries only after the failure is cleared', async () => {
    const { root, container, window } = mount()
    const failures = new ArticleThumbnailFailureCache(['https://cdn.example/broken.jpg'])
    const thumbnail = <ArticleThumbnail url="https://cdn.example/broken.jpg" failures={failures} />
    await act(() => root.render(thumbnail))
    await act(() => { container.querySelector('img')!.dispatchEvent(new window.Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.article-thumbnail-failed')).not.toBeNull()
    await act(() => root.render(null))
    await act(() => root.render(thumbnail))
    expect(container.querySelector('img')).toBeNull()
    await act(() => failures.clear())
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/broken.jpg')
  })

  it('shares failure state by URL and allows a changed URL immediately', async () => {
    const { root, container, window } = mount()
    const failures = new ArticleThumbnailFailureCache(['https://cdn.example/shared.jpg', 'https://cdn.example/new.jpg'])
    await act(() => root.render(<>
      <ArticleThumbnail url="https://cdn.example/shared.jpg" failures={failures} />
      <ArticleThumbnail url="https://cdn.example/shared.jpg" failures={failures} />
    </>))
    await act(() => { container.querySelector('img')!.dispatchEvent(new window.Event('error')) })
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelectorAll('.article-thumbnail-failed')).toHaveLength(2)
    await act(() => root.render(<ArticleThumbnail url="https://cdn.example/new.jpg" failures={failures} />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/new.jpg')
  })

})

describe('article list geometry commits', () => {
  function harness() {
    const environment = parseHTML('<html><body><div id="root"></div></body></html>')
    vi.stubGlobal('window', environment)
    vi.stubGlobal('document', environment.document)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const callbacks = new Set<() => void>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe() { callbacks.add(this.callback) }
      disconnect() { callbacks.delete(this.callback) }
    })
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    const geometry = { width: 320, height: 600, top: 0, scrollHeight: 12_018, widthReads: 0 }
    const articles = Array.from({ length: 100 }, (_, index) => article(index))
    let virtual!: ReturnType<typeof useArticleListWindow>
    let element!: HTMLDivElement
    function Probe({ tick = 0, scope = 'scope', layoutKey = '100', selectedId = null }: {
      tick?: number; scope?: string; layoutKey?: string; selectedId?: string | null
    }) {
      const ref = useRef<HTMLDivElement | null>(null)
      virtual = useArticleListWindow(articles, scope, ref, selectedId, { key: layoutKey })
      const bind = useCallback((node: HTMLDivElement | null) => {
        ref.current = node
        if (!node) return
        element = node
        Object.defineProperties(node, {
          clientWidth: { configurable: true, get: () => { geometry.widthReads++; return geometry.width } },
          clientHeight: { configurable: true, get: () => geometry.height },
          scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
          scrollTop: { configurable: true, get: () => geometry.top, set: (value: number) => {
            geometry.top = Math.max(0, Math.min(value, geometry.scrollHeight - geometry.height))
          } }
        })
      }, [])
      return <div ref={bind} data-tick={tick}>{virtual.start}:{virtual.end}</div>
    }
    const root = createRoot(environment.document.getElementById('root')!)
    roots.add(root)
    const render = async (props: ComponentProps<typeof Probe> = {}) => { await act(() => root.render(<Probe {...props} />)) }
    const flushFrames = async () => {
      for (let count = 0; frames.size && count < 20; count++) {
        const batch = [...frames.values()]
        frames.clear()
        await act(() => { batch.forEach(callback => callback(performance.now())) })
      }
      expect(frames.size).toBe(0)
    }
    return { render, geometry, articles, flushFrames, frames,
      resize: async () => { await act(() => { callbacks.forEach(callback => callback()) }) },
      scroll: async (top: number) => {
        geometry.top = top
        await act(() => { element.dispatchEvent(new environment.Event('scroll')) })
      },
      current: () => virtual
    }
  }

  it('skips geometry reads for unrelated renders and ordinary scroll commits but still reacts to layout/selection/scope changes', async () => {
    const state = harness()
    await state.render()
    const initialReads = state.geometry.widthReads
    await state.render({ tick: 1 })
    expect(state.geometry.widthReads).toBe(initialReads)
    await state.scroll(500)
    const eventReads = state.geometry.widthReads
    await state.flushFrames()
    expect(state.geometry.widthReads).toBe(eventReads)
    const anchor = captureArticleListAnchor(state.articles.map(article => article.id), state.current().offsets, state.geometry.top)
    await state.render({ tick: 2, layoutKey: '150' })
    expect(state.geometry.widthReads).toBeGreaterThan(eventReads)
    expect(captureArticleListAnchor(state.articles.map(article => article.id), state.current().offsets, state.geometry.top)).toEqual(anchor)
    state.geometry.width = 480
    await state.resize()
    expect(captureArticleListAnchor(state.articles.map(article => article.id), state.current().offsets, state.geometry.top)).toEqual(anchor)
    await state.render({ layoutKey: '150', selectedId: 'article-80' })
    expect(state.geometry.top).toBeGreaterThan(8000)
    await state.render({ layoutKey: '150', selectedId: 'article-80', scope: 'other-source' })
    expect(state.geometry.top).toBe(0)
  })

  it('lets a later DOM scroll win over a queued measured anchor even before a scroll event arrives', async () => {
    const state = harness()
    await state.render()
    await state.scroll(500)
    await state.flushFrames()
    state.current().measure('article-0', 160)
    const frame = [...state.frames.values()][0]!
    expect(frame).toBeTypeOf('function')
    state.frames.clear()
    await act(() => {
      frame(performance.now())
      state.geometry.top = 5000
    })
    expect(state.geometry.top).toBe(5000)
    expect(state.current().start).toBeLessThanOrEqual(state.current().first)
    expect(state.current().first).toBeGreaterThan(30)
    const reads = state.geometry.widthReads
    await state.render({ tick: 1 })
    expect(state.geometry.widthReads).toBe(reads)
  })
})
