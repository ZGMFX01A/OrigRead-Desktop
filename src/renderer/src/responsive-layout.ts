import { ARTICLE_PANE_WIDTH_MIN } from '../../shared/settings'

export const THREE_PANE_BREAKPOINT = 1200
export const COMPACT_LAYOUT_BREAKPOINT = 960
export const READER_MIN_RESPONSIVE_WIDTH = 420
export const COLLAPSED_RAIL_WIDTH = 30
export const DIVIDER_TRACK_WIDTH = 5

export interface ResponsivePaneLayout {
  adaptiveSourceHidden: boolean
  compactLayout: boolean
  articlePaneWidth: number
}

/**
 * 只根据当前 CSS viewport 计算临时响应式布局。
 *
 * 返回值绝不能写回 DesktopSettings：手动 Pane 宽度/折叠偏好与 adaptive hidden 必须保持独立。
 */
export function resolveResponsivePaneLayout(
  viewportWidth: number,
  persistedArticlePaneWidth: number
): ResponsivePaneLayout {
  const adaptiveSourceHidden = viewportWidth < THREE_PANE_BREAKPOINT
  const compactLayout = viewportWidth < COMPACT_LAYOUT_BREAKPOINT
  if (!compactLayout) {
    return { adaptiveSourceHidden, compactLayout, articlePaneWidth: persistedArticlePaneWidth }
  }

  const compactArticlePaneMax = Math.max(
    ARTICLE_PANE_WIDTH_MIN,
    viewportWidth - COLLAPSED_RAIL_WIDTH - DIVIDER_TRACK_WIDTH - READER_MIN_RESPONSIVE_WIDTH
  )
  return {
    adaptiveSourceHidden,
    compactLayout,
    articlePaneWidth: Math.min(persistedArticlePaneWidth, compactArticlePaneMax)
  }
}
