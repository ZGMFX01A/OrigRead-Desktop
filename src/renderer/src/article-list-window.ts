/** Prefix offsets allow scroll handling to find rows without reading DOM geometry. */
export function articleListOffsets(ids: readonly string[], heights: ReadonlyMap<string, number>, estimate = 118, invalidIds?: ReadonlySet<string>): number[] {
  const offsets = [0]
  for (const id of ids) offsets.push(offsets[offsets.length - 1]! + (invalidIds?.has(id) ? estimate : heights.get(id) ?? estimate))
  return offsets
}

export function articleAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0
  let high = Math.max(0, offsets.length - 2)
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle + 1]! <= offset) low = middle + 1
    else high = middle
  }
  return low
}

export function articleListWindow(offsets: readonly number[], scrollTop: number, viewportHeight: number, overscan = 5) {
  const count = offsets.length - 1
  const first = articleAtOffset(offsets, scrollTop)
  return { first, start: Math.max(0, first - overscan), end: Math.min(count, articleAtOffset(offsets, scrollTop + viewportHeight) + overscan + 1) }
}

/** DOM scroll metrics can already be clamped after newly measured rows shrink. */
export function articleListAtEnd(scrollTop: number, viewportHeight: number, scrollHeight: number): boolean {
  return viewportHeight > 0 && scrollTop > 0 && scrollTop + viewportHeight >= scrollHeight - 1
}

/** Mount the tail before committing its actual DOM scrollHeight (which also includes bottom padding). */
export function articleListEndScrollTop(offsets: readonly number[], viewportHeight: number, paddingTop = 4): number {
  return Math.max(0, offsets[offsets.length - 1]! + paddingTop - viewportHeight)
}

/** A height change can clamp a captured top, but must not hide a later user/script scroll. */
export function articleListScrollChanged(capturedTop: number, scrollTop: number, viewportHeight: number, scrollHeight: number): boolean {
  const clampedTop = Math.min(capturedTop, Math.max(0, scrollHeight - viewportHeight))
  return Math.abs(scrollTop - clampedTop) > 1
}

export interface ArticleListAnchor {
  id: string
  index: number
  offsetWithinRow: number
}

/** Keep the visible article, rather than a pixel position based on obsolete row heights. */
export function captureArticleListAnchor(ids: readonly string[], offsets: readonly number[], scrollTop: number, paddingTop = 4): ArticleListAnchor | null {
  if (!ids.length) return null
  const index = Math.min(ids.length - 1, articleAtOffset(offsets, Math.max(0, scrollTop - paddingTop)))
  return { id: ids[index]!, index, offsetWithinRow: scrollTop - offsets[index]! - paddingTop }
}

export function restoreArticleListAnchor(ids: readonly string[], offsets: readonly number[], anchor: ArticleListAnchor | null, paddingTop = 4): number {
  if (!anchor || !ids.length) return 0
  const matchingIndex = ids.indexOf(anchor.id)
  // If a refresh removed the anchor, use its next neighbour (or the new final row).
  const index = matchingIndex < 0 ? Math.min(anchor.index, ids.length - 1) : matchingIndex
  const height = offsets[index + 1]! - offsets[index]!
  const within = Math.max(index === 0 ? -paddingTop : 0, Math.min(anchor.offsetWithinRow, Math.max(0, height - 1)))
  return Math.max(0, offsets[index]! + paddingTop + within)
}

export function articleSelectionScrollTop(offsets: readonly number[], index: number, scrollTop: number, viewportHeight: number, paddingTop = 4): number {
  const top = offsets[index]! + paddingTop
  const bottom = offsets[index + 1]! + paddingTop
  if (top < scrollTop || bottom - top > viewportHeight) return top
  return bottom > scrollTop + viewportHeight ? Math.max(0, bottom - viewportHeight) : scrollTop
}
