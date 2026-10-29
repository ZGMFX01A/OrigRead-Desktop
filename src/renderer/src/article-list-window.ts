/** Estimates the existing two-line card geometry; measured row heights always replace it.
 * Fixed 32px: wrapper padding (4), card padding (17), borders (2), preview gap (4), metadata gap (5).
 * Windows baseline at 100/150%: metadata is about 12.7/18.7px; 13px × scale leaves a small allowance.
 * The 80×60 thumbnail shares the preview row and does not change the full-width title.
 */
export function articleListEstimatedRowHeight(fontScale: number, thumbnail: boolean): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale / 100 : 1
  const title = Math.max(24, 2 * 12.5 * 1.4 * scale)
  const preview = Math.max(2 * 10.5 * 1.45 * scale, thumbnail ? 60 : 0)
  return Math.ceil(32 + title + preview + 13 * scale)
}

/** Prefix offsets allow scroll handling to find rows without reading DOM geometry. */
export function articleListOffsets(
  ids: readonly string[], heights: ReadonlyMap<string, number>, estimate: number | ((index: number) => number) = 118,
  invalidIds?: ReadonlySet<string>
): number[] {
  const offsets = [0]
  ids.forEach((id, index) => {
    let height = invalidIds?.has(id) ? undefined : heights.get(id)
    if (height === undefined) {
      const value = typeof estimate === 'function' ? estimate(index) : estimate
      height = Number.isFinite(value) && value > 0 ? value : 118
    }
    offsets.push(offsets[offsets.length - 1]! + height)
  })
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

export interface ArticleListOverscan { before: number; after: number }

/** Pixel coverage grows with the viewport and recent motion, then the row budget below limits DOM work. */
export function articleListOverscan(viewportHeight: number, velocity = 0): ArticleListOverscan {
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 600
  const speed = Number.isFinite(velocity) ? velocity : 0
  // New rows can be shorter than their estimates before their measurements commit.
  // Keep two viewports of baseline coverage so a discrete wheel step does not use
  // up the entire physical buffer while the average-velocity estimate is smaller.
  const base = height * 2
  const ahead = Math.min(height * 3, Math.max(base, Math.abs(speed) * 48))
  return { before: speed < 0 ? ahead : base, after: speed > 0 ? ahead : base }
}

/** Keep all visible rows; share one extra-row budget between both directions. */
export function articleListWindow(
  offsets: readonly number[], scrollTop: number, viewportHeight: number,
  overscan: ArticleListOverscan = articleListOverscan(viewportHeight)
) {
  const count = offsets.length - 1
  if (count <= 0) return { first: 0, start: 0, end: 0 }
  const first = articleAtOffset(offsets, scrollTop)
  const visibleEnd = Math.min(count, articleAtOffset(offsets, scrollTop + viewportHeight) + 1)
  const beforePixels = Math.max(0, overscan.before)
  const afterPixels = Math.max(0, overscan.after)
  const requestedBefore = first - articleAtOffset(offsets, Math.max(0, scrollTop - beforePixels))
  const requestedAfter = Math.min(count, articleAtOffset(offsets, scrollTop + viewportHeight + afterPixels) + 1) - visibleEnd
  // Common viewports stay below 40 mounted rows. A huge viewport still mounts every visible row.
  const budget = Math.max(0, Math.min(30, 39 - (visibleEnd - first)))
  if (requestedBefore + requestedAfter <= budget) {
    return { first, start: first - requestedBefore, end: visibleEnd + requestedAfter }
  }
  const basePixels = Math.min(beforePixels, afterPixels)
  let before = first - articleAtOffset(offsets, Math.max(0, scrollTop - basePixels))
  let after = Math.min(count, articleAtOffset(offsets, scrollTop + viewportHeight + basePixels) + 1) - visibleEnd
  if (before + after > budget) {
    const total = before + after
    before = Math.min(before, Math.floor(budget * before / total))
    after = Math.min(after, budget - before)
  }
  let remaining = budget - before - after
  if (afterPixels >= beforePixels) {
    const extra = Math.min(requestedAfter - after, remaining)
    after += extra
    remaining -= extra
    before += Math.min(requestedBefore - before, remaining)
  } else {
    const extra = Math.min(requestedBefore - before, remaining)
    before += extra
    remaining -= extra
    after += Math.min(requestedAfter - after, remaining)
  }
  return { first, start: first - before, end: visibleEnd + after }
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
