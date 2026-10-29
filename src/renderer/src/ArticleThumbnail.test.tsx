import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { ArticleThumbnail, useArticleThumbnailFailures } from './ArticleThumbnail'

const feeds: FeedRecord[] = []
const urls = ['https://images.example/a', 'https://images.example/b']
const articles: ArticleRecord[] = urls.map((url, index) => ({
  id: 'article-' + index, accountId: 1, feedId: 'feed', title: 'Title', url: null,
  author: null, publishedAt: null, description: '', contentHtml: null, fullContentHtml: null,
  imageUrl: url, isUnread: true, isStarred: false, createdAt: 0, updatedAt: 0
}))
const roots = new Set<Root>()

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount())
  roots.clear()
  vi.unstubAllGlobals()
})

function mount() {
  const window = parseHTML('<html><body><div id="root"></div></body></html>')
  const navigator = { onLine: true }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = window.document.getElementById('root')!
  const root = createRoot(container)
  roots.add(root)
  const fail = async () => {
    await act(() => { container.querySelector('img')!.dispatchEvent(new window.Event('error')) })
  }
  return { window, navigator, container, root, fail }
}

function Thumbnail({ index = 0, scope = '1:all', refreshing = false,
  source = articles }: { index?: number; scope?: string; refreshing?: boolean; source?: ArticleRecord[] }) {
  const failures = useArticleThumbnailFailures(scope, source, feeds, refreshing)
  return <ArticleThumbnail url={urls[index]!} failures={failures} />
}

describe('thumbnail failure lifecycle', () => {
  it('keeps failures across visible-row/filter changes but prunes removed source data', async () => {
    const { root, container, fail } = mount()
    await act(() => root.render(<Thumbnail />))
    const image = container.querySelector('img')!
    // LinkeDOM preserves React's attribute casing; Chromium normalizes HTML attribute names.
    const referrerPolicy = image.getAttributeNames().find(name => name.toLowerCase() === 'referrerpolicy')
    expect(image.getAttribute(referrerPolicy!)).toBe('no-referrer')
    await fail()
    await act(() => root.render(<Thumbnail index={1} />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(urls[1])
    await act(() => root.render(<Thumbnail />))
    expect(container.querySelector('img')).toBeNull()
    await act(() => root.render(<Thumbnail index={1} source={[articles[1]!]} />))
    await act(() => root.render(<Thumbnail />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(urls[0])
  })

  it('retries once per refresh start, not every render while refreshing', async () => {
    const { root, container, fail } = mount()
    await act(() => root.render(<Thumbnail />))
    await fail()
    await act(() => root.render(<Thumbnail refreshing />))
    expect(container.querySelector('img')).not.toBeNull()
    await fail()
    await act(() => root.render(<Thumbnail refreshing source={[...articles]} />))
    expect(container.querySelector('img')).toBeNull()
    await act(() => root.render(<Thumbnail />))
    await act(() => root.render(<Thumbnail refreshing />))
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('uses an independent failure scope after changing source or account', async () => {
    const { root, container, fail } = mount()
    await act(() => root.render(<Thumbnail />))
    await fail()
    await act(() => root.render(<Thumbnail scope="2:all" />))
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('does not mount attempts while offline and resumes only previously unfailed images', async () => {
    const { root, container, navigator, window, fail } = mount()
    await act(() => root.render(<Thumbnail />))
    await fail()
    await act(() => {
      navigator.onLine = false
      window.dispatchEvent(new window.Event('offline'))
    })
    await act(() => root.render(<Thumbnail index={1} />))
    expect(container.querySelector('img')).toBeNull()
    await act(() => {
      navigator.onLine = true
      window.dispatchEvent(new window.Event('online'))
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(urls[1])
    await act(() => root.render(<Thumbnail />))
    expect(container.querySelector('img')).toBeNull()
  })

  it('keeps an already loaded image while offline without allowing a different URL to start', async () => {
    const { root, container, navigator, window } = mount()
    await act(() => root.render(<Thumbnail />))
    const image = container.querySelector('img')!
    await act(() => { image.dispatchEvent(new window.Event('load')) })
    await act(() => {
      navigator.onLine = false
      window.dispatchEvent(new window.Event('offline'))
    })
    expect(container.querySelector('img')).toBe(image)
    await act(() => root.render(<Thumbnail index={1} />))
    expect(container.querySelector('img')).toBeNull()
  })
})
