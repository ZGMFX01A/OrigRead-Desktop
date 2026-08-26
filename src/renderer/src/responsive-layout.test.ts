import { describe, expect, it } from 'vitest'
import {
  COMPACT_LAYOUT_BREAKPOINT,
  THREE_PANE_BREAKPOINT,
  resolveResponsivePaneLayout
} from './responsive-layout'

describe('resolveResponsivePaneLayout', () => {
  it('uses exact 1200 / 1199 source adaptive boundary without mutating article width', () => {
    expect(resolveResponsivePaneLayout(THREE_PANE_BREAKPOINT, 480)).toEqual({
      adaptiveSourceHidden: false,
      compactLayout: false,
      articlePaneWidth: 480
    })
    expect(resolveResponsivePaneLayout(THREE_PANE_BREAKPOINT - 1, 480)).toEqual({
      adaptiveSourceHidden: true,
      compactLayout: false,
      articlePaneWidth: 480
    })
  })

  it('uses exact 960 / 959 compact boundary', () => {
    expect(resolveResponsivePaneLayout(COMPACT_LAYOUT_BREAKPOINT, 480)).toMatchObject({
      adaptiveSourceHidden: true,
      compactLayout: false,
      articlePaneWidth: 480
    })
    expect(resolveResponsivePaneLayout(COMPACT_LAYOUT_BREAKPOINT - 1, 480)).toMatchObject({
      adaptiveSourceHidden: true,
      compactLayout: true,
      articlePaneWidth: 480
    })
  })

  it('temporarily narrows the article pane only when Reader needs protected space', () => {
    expect(resolveResponsivePaneLayout(900, 480)).toEqual({
      adaptiveSourceHidden: true,
      compactLayout: true,
      articlePaneWidth: 445
    })
  })
})
