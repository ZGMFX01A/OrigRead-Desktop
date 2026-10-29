import { describe, expect, it } from 'vitest'
import { ArticleListMeasurements, type ArticleListMeasurementLayout } from './article-list-measurements'
import { articleListOffsets, captureArticleListAnchor, restoreArticleListAnchor } from './article-list-window'

const layout: ArticleListMeasurementLayout = { scope: 'account:feed', key: '100:false', width: 380, estimatedRowHeight: 118 }

describe('article list measurement generations', () => {
  it.each([
    { key: '125:false', estimatedRowHeight: 148 },
    { key: '100:true' },
    { width: 300 }
  ])('invalidates offscreen heights for geometry changes: %j', patch => {
    const cache = new ArticleListMeasurements(layout)
    const generation = cache.generation
    cache.record('offscreen', 72, generation)
    cache.record('visible', 120, generation)
    expect(cache.changeFor({ ...layout, ...patch })).toBe('layout')
    expect(cache.configure({ ...layout, ...patch })).toBe('layout')
    expect(cache.heights.size).toBe(0)
    expect(cache.record('offscreen', 72, generation)).toBe(false)
    expect(cache.record('visible', 150, cache.generation)).toBe(true)
  })

  it('keeps unrelated heights but rejects queued measurements after a single row changes', () => {
    const cache = new ArticleListMeasurements(layout)
    cache.record('a', 70, cache.generation)
    cache.record('b', 200, cache.generation)
    const oldGeneration = cache.generation
    cache.invalidate(['b'])
    expect([...cache.heights]).toEqual([['a', 70]])
    expect(cache.record('b', 200, oldGeneration)).toBe(false)
    expect(cache.record('b', 95, cache.generation)).toBe(true)
    cache.invalidate(['not-measured-yet'])
    expect(cache.record('not-measured-yet', 80, oldGeneration + 1)).toBe(false)
  })

  it('distinguishes scope reset from layout preservation and discards stale callbacks in both', () => {
    const cache = new ArticleListMeasurements(layout)
    const oldGeneration = cache.generation
    cache.record('a', 90, oldGeneration)
    expect(cache.configure({ ...layout, scope: 'other-account:feed' })).toBe('scope')
    expect(cache.heights.size).toBe(0)
    expect(cache.record('a', 90, oldGeneration)).toBe(false)
  })

  it('ignores temporary zero width and invalid measurements, and prunes removed articles', () => {
    const cache = new ArticleListMeasurements(layout)
    cache.record('a', 70, cache.generation)
    cache.record('b', 120, cache.generation)
    expect(cache.configure({ ...layout, width: 0 })).toBeNull()
    for (const value of [0, -1, NaN, Infinity]) expect(cache.record('a', value, cache.generation)).toBe(false)
    expect(cache.invalidate([])).toBe(false)
    cache.retain(new Set(['a']))
    expect([...cache.heights]).toEqual([['a', 70]])
  })

  it('preserves a deep-list article and its intra-row position through invalidation and measurement batches', () => {
    const cache = new ArticleListMeasurements(layout)
    const ids = Array.from({ length: 10_000 }, (_, index) => String(index))
    ids.forEach(id => cache.record(id, 100, cache.generation))
    const oldOffsets = articleListOffsets(ids, cache.heights)
    const anchor = captureArticleListAnchor(ids, oldOffsets, 500_034)
    expect(anchor).toEqual({ id: '5000', index: 5000, offsetWithinRow: 30 })
    cache.configure({ ...layout, key: '150:true', estimatedRowHeight: 177 })
    let offsets = articleListOffsets(ids, cache.heights, 177)
    let top = restoreArticleListAnchor(ids, offsets, anchor)
    expect(top).toBe(885_034)
    for (let index = 4995; index < 5010; index++) cache.record(String(index), 200, cache.generation)
    const measuredAnchor = captureArticleListAnchor(ids, offsets, top)
    offsets = articleListOffsets(ids, cache.heights, 177)
    top = restoreArticleListAnchor(ids, offsets, measuredAnchor)
    expect(captureArticleListAnchor(ids, offsets, top)).toEqual(anchor)
  })
})
