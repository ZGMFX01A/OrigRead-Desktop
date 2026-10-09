import { describe, expect, it } from 'vitest'
import { articleAtOffset, articleListOffsets, articleListWindow } from './article-list-window'

describe('variable height article window', () => {
  it('uses actual row heights and includes rows that intersect viewport edges', () => {
    const offsets = articleListOffsets(['a', 'b', 'c', 'd'], new Map([['a', 60], ['b', 200], ['c', 90], ['d', 50]]))
    expect(offsets).toEqual([0, 60, 260, 350, 400])
    expect(articleAtOffset(offsets, 59)).toBe(0)
    expect(articleAtOffset(offsets, 60)).toBe(1)
    expect(articleListWindow(offsets, 70, 200, 0)).toEqual({ first: 1, start: 1, end: 3 })
    expect(articleListWindow(offsets, 399, 600, 0)).toEqual({ first: 3, start: 3, end: 4 })
  })

  it('bounds work at the middle and end of a 10,000 article list', () => {
    const offsets = articleListOffsets(Array.from({ length: 10_000 }, (_, index) => String(index)), new Map())
    for (const top of [0, 590_000, 1_179_500]) {
      const window = articleListWindow(offsets, top, 600)
      expect(window.end - window.start).toBeLessThan(18)
      expect(offsets[window.first + 1]).toBeGreaterThan(top)
    }
    expect(articleListWindow([0], 0, 600)).toEqual({ first: 0, start: 0, end: 0 })
  })
})
