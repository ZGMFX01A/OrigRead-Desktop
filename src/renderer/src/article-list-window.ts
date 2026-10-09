/** Prefix offsets allow scroll handling to find rows without reading DOM geometry. */
export function articleListOffsets(ids: readonly string[], heights: ReadonlyMap<string, number>, estimate = 118): number[] {
  const offsets = [0]
  for (const id of ids) offsets.push(offsets[offsets.length - 1]! + (heights.get(id) ?? estimate))
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
