import { describe, expect, it } from 'vitest'
import { articleAtOffset, articleListAtEnd, articleListEndScrollTop, articleListOffsets, articleListOverscan, articleListEstimatedRowHeight, articleListScrollChanged, articleListWindow, articleSelectionScrollTop, captureArticleListAnchor, restoreArticleListAnchor } from './article-list-window'

describe('variable height article window', () => {
  it.each([
    { scale: 100, thumbnail: false, measured: 109.4375 },
    { scale: 100, thumbnail: true, measured: 139 },
    { scale: 150, thumbnail: false, measured: 148.1667 },
    { scale: 150, thumbnail: true, measured: 162.5 }
  ])('estimates the sampled two-line card geometry without scaling fixed padding: %j', ({ scale, thumbnail, measured }) => {
    const height = articleListEstimatedRowHeight(scale, thumbnail)
    expect(height).toBeGreaterThanOrEqual(measured)
    expect(height).toBeLessThan(measured + 3)
  })

  it('keeps mixed image/text estimates per row and prefers actual measurements', () => {
    const estimate = (index: number) => articleListEstimatedRowHeight(100, index === 1)
    expect(articleListOffsets(['text', 'image', 'measured'], new Map([['measured', 92]]), estimate)).toEqual([0, 111, 251, 343])
    expect(articleListOffsets(['a', 'b'], new Map(), index => index ? NaN : 0)).toEqual([0, 118, 236])
    expect(articleListEstimatedRowHeight(NaN, true)).toBe(articleListEstimatedRowHeight(100, true))
  })

  it('uses viewport-sized pixel buffers and gives recent motion bounded extra coverage ahead', () => {
    expect(articleListOverscan(600)).toEqual({ before: 900, after: 900 })
    expect(articleListOverscan(600, 100)).toEqual({ before: 900, after: 1800 })
    expect(articleListOverscan(600, -100)).toEqual({ before: 1800, after: 900 })
    expect(articleListOverscan(1200, 1_000_000)).toEqual({ before: 1800, after: 3600 })
  })

  it('shares one DOM budget across both directions while preserving the full visible range', () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => String(index))
    const offsets = articleListOffsets(ids, new Map(), index => [83, 128, 162][index % 3]!)
    for (const top of [0, 20_000, 500_000, offsets.at(-1)! - 800]) {
      for (const velocity of [0, 100, -100]) {
        const window = articleListWindow(offsets, top, 800, articleListOverscan(800, velocity))
        expect(window.start).toBeLessThanOrEqual(articleAtOffset(offsets, top))
        expect(window.end).toBeGreaterThan(articleAtOffset(offsets, top + 800))
        expect(window.end - window.start).toBeLessThan(40)
      }
    }
    const forward = articleListWindow(offsets, 20_000, 800, articleListOverscan(800, 100))
    const backward = articleListWindow(offsets, 20_000, 800, articleListOverscan(800, -100))
    expect(forward.end).toBeGreaterThan(backward.end)
    expect(backward.start).toBeLessThan(forward.start)
  })

  it('never crops visible rows when an unusually tall viewport needs more than the normal DOM budget', () => {
    const offsets = articleListOffsets(Array.from({ length: 1000 }, (_, index) => String(index)), new Map(), 20)
    const window = articleListWindow(offsets, 1000, 1200, articleListOverscan(1200, 100))
    expect(window.start).toBe(50)
    expect(window.end).toBe(111)
    expect(window.end - window.start).toBe(61)
  })

  it('uses actual row heights and includes rows that intersect viewport edges', () => {
    const offsets = articleListOffsets(['a', 'b', 'c', 'd'], new Map([['a', 60], ['b', 200], ['c', 90], ['d', 50]]))
    expect(offsets).toEqual([0, 60, 260, 350, 400])
    expect(articleAtOffset(offsets, 59)).toBe(0)
    expect(articleAtOffset(offsets, 60)).toBe(1)
    expect(articleListWindow(offsets, 70, 200, { before: 0, after: 0 })).toEqual({ first: 1, start: 1, end: 3 })
    expect(articleListWindow(offsets, 399, 600, { before: 0, after: 0 })).toEqual({ first: 3, start: 3, end: 4 })
  })

  it('bounds work at the middle and end of a 10,000 article list', () => {
    const offsets = articleListOffsets(Array.from({ length: 10_000 }, (_, index) => String(index)), new Map())
    for (const top of [0, 590_000, 1_179_500]) {
      const window = articleListWindow(offsets, top, 600)
      expect(window.end - window.start).toBeLessThan(40)
      expect(offsets[window.first + 1]).toBeGreaterThan(top)
    }
    expect(articleListWindow([0], 0, 600)).toEqual({ first: 0, start: 0, end: 0 })
  })

  it('preserves the anchor by ID after reordering and clamps its offset if its row shrinks', () => {
    const ids = ['a', 'b', 'c']
    const anchor = captureArticleListAnchor(ids, [0, 80, 280, 380], 214)
    expect(anchor).toEqual({ id: 'b', index: 1, offsetWithinRow: 130 })
    expect(restoreArticleListAnchor(['c', 'a', 'b'], [0, 90, 190, 390], anchor)).toBe(324)
    expect(restoreArticleListAnchor(ids, [0, 100, 160, 260], anchor)).toBe(163)
    expect(restoreArticleListAnchor(['a', 'c'], [0, 100, 260], anchor)).toBe(234)
    expect(restoreArticleListAnchor([], [0], anchor)).toBe(0)
  })

  it('keeps the padding at the top and ignores stale row heights before invalidation commits', () => {
    const ids = ['a', 'b']
    const anchor = captureArticleListAnchor(ids, [0, 80, 180], 0)
    expect(restoreArticleListAnchor(ids, [0, 120, 240], anchor)).toBe(0)
    expect(captureArticleListAnchor([], [0], 0)).toBeNull()
    expect(articleListOffsets(ids, new Map([['a', 80], ['b', 200]]), 120, new Set(['b']))).toEqual([0, 80, 200])
  })

  it('keeps keyboard targets visible and aligns a row taller than the viewport at its top', () => {
    expect(articleSelectionScrollTop([0, 100, 200], 1, 0, 150)).toBe(54)
    expect(articleSelectionScrollTop([0, 100, 200], 0, 54, 150)).toBe(4)
    expect(articleSelectionScrollTop([0, 100, 400], 1, 0, 150)).toBe(104)
    expect(articleSelectionScrollTop([0, 100, 200], 1, 80, 150)).toBe(80)
  })

  it('keeps the last article visible when shrinking tail rows clamp scrollTop before their offsets commit', () => {
    const ids = Array.from({ length: 1200 }, (_, index) => String(index))
    const oldOffsets = articleListOffsets(ids, new Map())
    const measured = new Map(ids.slice(-20).map(id => [id, 60]))
    const nextOffsets = articleListOffsets(ids, measured)
    const viewportHeight = 600
    const actualScrollHeight = nextOffsets.at(-1)! + 4 + 14
    const clampedTop = actualScrollHeight - viewportHeight
    // This is the old failure: a clamped DOM position interpreted against obsolete offsets.
    const wrongAnchor = captureArticleListAnchor(ids, oldOffsets, clampedTop)
    const wrongTop = restoreArticleListAnchor(ids, nextOffsets, wrongAnchor)
    expect(wrongTop + viewportHeight).toBeLessThan(nextOffsets[1199]! + 4)

    expect(articleListAtEnd(clampedTop, viewportHeight, actualScrollHeight)).toBe(true)
    const tailTop = articleListEndScrollTop(nextOffsets, viewportHeight)
    expect(articleListWindow(nextOffsets, tailTop - 4, viewportHeight).end).toBe(ids.length)
    expect(tailTop + viewportHeight).toBeGreaterThanOrEqual(nextOffsets.at(-1)! + 4)
    // Keyboard navigation can still override the bottom correction.
    expect(articleSelectionScrollTop(nextOffsets, 1180, tailTop, viewportHeight)).toBe(nextOffsets[1180]! + 4)
  })

  it('only treats an actually scrollable bottom edge as end intent and permits fractional pixel rounding', () => {
    expect(articleListAtEnd(399.5, 600, 1000)).toBe(true)
    expect(articleListAtEnd(398, 600, 1000)).toBe(false)
    expect(articleListAtEnd(0, 600, 500)).toBe(false)
    expect(articleListAtEnd(1000, 0, 1000)).toBe(false)
    expect(articleListEndScrollTop([0], 600)).toBe(0)
  })

  it('rejects a queued head anchor when a later scroll reaches the unread tail before its scroll event', () => {
    const ids = Array.from({ length: 1198 }, (_, index) => String(index))
    const offsets = articleListOffsets(ids, new Map())
    const capturedTop = 0
    const queued = captureArticleListAnchor(ids, offsets, capturedTop)
    const viewportHeight = 702
    const scrollHeight = offsets.at(-1)! + 4 + 14
    // The measurement frame captured the head; a later rAF now writes the DOM directly.
    const latestTop = scrollHeight - viewportHeight
    expect(restoreArticleListAnchor(ids, offsets, queued)).toBe(0)
    expect(articleListScrollChanged(capturedTop, latestTop, viewportHeight, scrollHeight)).toBe(true)
    expect(articleListWindow(offsets, latestTop - 4, viewportHeight).end).toBe(ids.length)
    expect(articleListScrollChanged(5000, 4000, viewportHeight, scrollHeight)).toBe(true)
  })

  it('allows internal height clamping without treating it as a later scroll', () => {
    expect(articleListScrollChanged(9000, 8500, 600, 9100)).toBe(false)
    expect(articleListScrollChanged(9000, 8500.5, 600, 9100)).toBe(false)
    expect(articleListScrollChanged(9000, 8500, 600, 10000)).toBe(true)
    expect(articleListScrollChanged(4000, 4000, 600, 20000)).toBe(false)
    expect(articleListScrollChanged(200, 0, 600, 500)).toBe(false)
  })
})
