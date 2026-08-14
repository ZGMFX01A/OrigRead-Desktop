import { describe, expect, it } from 'vitest'
import { validateOriginalViewBounds } from './original-article-view-controller'

describe('validateOriginalViewBounds', () => {
  it('rounds finite renderer CSS-pixel bounds', () => {
    expect(validateOriginalViewBounds({ x: 420.4, y: 56.2, width: 900.6, height: 700.3 })).toEqual({
      x: 420,
      y: 56,
      width: 901,
      height: 700
    })
  })

  it('rejects malformed IPC bounds', () => {
    expect(() => validateOriginalViewBounds({ x: 0, y: 0, width: '900', height: 700 })).toThrow(TypeError)
  })
})

