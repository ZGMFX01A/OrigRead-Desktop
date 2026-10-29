import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ArticleRecord } from '../../shared/library'
import { ArticleListMeasurements } from './article-list-measurements'
import { articleListAtEnd, articleListEndScrollTop, articleListOffsets, articleListScrollChanged, articleListWindow, articleSelectionScrollTop, captureArticleListAnchor, restoreArticleListAnchor, type ArticleListAnchor } from './article-list-window'

// Matches .list-content padding-top; offsets describe the rows inside that padding.
const LIST_PADDING_TOP = 4
const EMPTY_HEIGHTS: ReadonlyMap<string, number> = new Map()
const EMPTY_IDS: ReadonlySet<string> = new Set()

export interface ArticleListWindowLayout {
  key: string
  estimatedRowHeight?: number
}

interface PendingAnchor {
  scope: string
  generation: number
  anchor: ArticleListAnchor
  scrollTop: number
  atEnd?: boolean
  endLayout?: { key: string; width: number; estimatedRowHeight: number }
}

export function useArticleListWindow(
  articles: ArticleRecord[], scope: string, listRef: RefObject<HTMLDivElement | null>, selectedId: string | null,
  layout?: ArticleListWindowLayout
) {
  const key = layout?.key ?? ''
  const requestedEstimate = layout?.estimatedRowHeight ?? 118
  const estimatedRowHeight = Number.isFinite(requestedEstimate) && requestedEstimate > 0 ? requestedEstimate : 118
  const [width, setWidth] = useState(0)
  const currentLayout = { scope, key, width, estimatedRowHeight }
  const [measurements] = useState(() => new ArticleListMeasurements(currentLayout))
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const viewportRef = useRef(viewport)
  const widthRef = useRef(0)
  const mounted = useRef(true)
  const frame = useRef<number | null>(null)
  const pendingAnchor = useRef<PendingAnchor | null>(null)
  const previousSelection = useRef<string | null>(null)
  const pendingSelection = useRef<string | null>(null)
  const ids = useMemo(() => articles.map(article => article.id), [articles])
  const idSet = useMemo(() => new Set(ids), [ids])
  const committed = useRef({ scope, ids: [] as readonly string[], idSet: EMPTY_IDS, offsets: [0] as readonly number[] })
  const previousArticles = useRef<{ articles: ArticleRecord[] | null; byId: ReadonlyMap<string, ArticleRecord> }>({ articles: null, byId: new Map() })

  // Ordinary source refreshes can change offscreen content without changing its ID.
  // This comparison runs only when the article array changes, never for translation progress.
  const invalidIds: ReadonlySet<string> = previousArticles.current.articles === articles ? EMPTY_IDS : new Set(
    articles.filter(article => {
      const previous = previousArticles.current.byId.get(article.id)
      return previous && (previous.title !== article.title || previous.description !== article.description
        || previous.imageUrl !== article.imageUrl || previous.isUnread !== article.isUnread)
    }).map(article => article.id)
  )
  const change = measurements.changeFor(currentLayout)
  const orderChanged = ids !== committed.current.ids
    && (ids.length !== committed.current.ids.length || ids.some((id, index) => id !== committed.current.ids[index]))
  const offsets = useMemo(
    () => articleListOffsets(ids, change ? EMPTY_HEIGHTS : measurements.heights, estimatedRowHeight, invalidIds),
    [ids, revision, scope, key, width, estimatedRowHeight, invalidIds, change, measurements]
  )
  const pending = pendingAnchor.current
  const anchorScrollTop = pending?.scope === scope && pending.generation === measurements.generation
    ? pending.scrollTop : viewportRef.current.top
  const continuesEndResize = pending?.endLayout?.key === key && pending.endLayout.width === width
    && pending.endLayout.estimatedRowHeight === estimatedRowHeight
  const atEnd = change !== 'scope' && pending?.scope === scope && pending.generation === measurements.generation
    && pending.atEnd === true && (change === null || continuesEndResize)
  const anchor = change === 'scope' ? null
    : pending?.scope === scope && pending.generation === measurements.generation ? pending.anchor
      : (change === 'layout' || invalidIds.size > 0 || orderChanged) && committed.current.scope === scope
        ? captureArticleListAnchor(committed.current.ids, committed.current.offsets, viewportRef.current.top, LIST_PADDING_TOP)
        : null
  // Render the correct window before committing new spacers, not a window at obsolete pixels.
  const top = change === 'scope' ? 0 : atEnd ? articleListEndScrollTop(offsets, viewport.height, LIST_PADDING_TOP)
    : anchor ? restoreArticleListAnchor(ids, offsets, anchor, LIST_PADDING_TOP) : viewport.top

  const cancelMeasurementFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])
  const updateViewport = useCallback(() => {
    const element = listRef.current
    if (!element) return
    const next = { top: element.scrollTop, height: element.clientHeight }
    viewportRef.current = next
    setViewport(current => current.top === next.top && current.height === next.height ? current : next)
  }, [listRef])
  const invalidateMeasurements = useCallback((changedIds?: readonly string[]) => {
    const current = committed.current
    const previous = pendingAnchor.current
    const reuse = previous?.scope === current.scope && previous.generation === measurements.generation
    const keepEnd = reuse && previous.atEnd
    const endLayout = keepEnd ? previous.endLayout : undefined
    const scrollTop = reuse ? previous.scrollTop : viewportRef.current.top
    const saved = reuse ? previous.anchor
      : captureArticleListAnchor(current.ids, current.offsets, viewportRef.current.top, LIST_PADDING_TOP)
    if (!measurements.invalidate(changedIds)) return
    cancelMeasurementFrame()
    pendingAnchor.current = saved ? { scope: current.scope, generation: measurements.generation, anchor: saved, scrollTop, atEnd: keepEnd, endLayout } : null
    setRevision(value => value + 1)
  }, [measurements, cancelMeasurementFrame])

  const generation = measurements.generation
  const measure = useCallback((id: string, height: number) => {
    if (!mounted.current || !committed.current.idSet.has(id) || !measurements.record(id, height, generation)) return
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (!mounted.current || generation !== measurements.generation) return
      const element = listRef.current
      const current = committed.current
      const scrollTop = element?.scrollTop ?? 0
      // One adjustment covers the complete ResizeObserver batch, after DOM offsets commit.
      const saved = element ? captureArticleListAnchor(current.ids, current.offsets, scrollTop, LIST_PADDING_TOP) : null
      // At the tail the browser may have clamped scrollTop using the new DOM heights.
      // Interpreting that smaller value with old offsets would move the reader away from the end.
      const keepEnd = element ? articleListAtEnd(scrollTop, element.clientHeight, element.scrollHeight) : false
      pendingAnchor.current = saved ? { scope: current.scope, generation, anchor: saved, scrollTop, atEnd: keepEnd } : null
      setRevision(value => value + 1)
    })
  }, [measurements, generation, listRef])

  useLayoutEffect(() => {
    const element = listRef.current
    const actualWidth = element ? Math.round(element.clientWidth) : 0
    const widthChanged = actualWidth > 0 && actualWidth !== width
    // scrollTop can be written after the measurement rAF but before its React commit,
    // even before the browser dispatches a scroll event. Never replay that older intent.
    const scrollChanged = Boolean(element && anchor
      && articleListScrollChanged(anchorScrollTop, element.scrollTop, element.clientHeight, element.scrollHeight))
    const beforeResize = widthChanged && change !== 'scope' && !scrollChanged
      ? anchor ?? captureArticleListAnchor(committed.current.ids, committed.current.offsets, viewportRef.current.top, LIST_PADDING_TOP)
      : null
    const before = measurements.generation
    const configured = measurements.configure(currentLayout)
    if (!configured && invalidIds.size) measurements.invalidate([...invalidIds])
    if (before !== measurements.generation) {
      cancelMeasurementFrame()
      // Give mounted rows a callback belonging to the new measurement generation.
      setRevision(value => value + 1)
    }
    measurements.retain(idSet)
    if (previousArticles.current.articles !== articles) {
      previousArticles.current = { articles, byId: new Map(articles.map(article => [article.id, article])) }
    }
    committed.current = { scope, ids, idSet, offsets }

    if (configured === 'scope') {
      pendingSelection.current = null
      pendingAnchor.current = null
      if (element) element.scrollTop = 0
    } else if (!scrollChanged && atEnd && element) {
      element.scrollTop = element.scrollHeight
    } else if (!scrollChanged && anchor && element) {
      element.scrollTop = restoreArticleListAnchor(ids, offsets, anchor, LIST_PADDING_TOP)
    }
    pendingAnchor.current = null

    // A scope reset must not scroll back to an unchanged Reader selection.
    if (scrollChanged) pendingSelection.current = null
    if (previousSelection.current !== selectedId) {
      previousSelection.current = selectedId
      pendingSelection.current = selectedId
    }
    const selectedIndex = ids.indexOf(pendingSelection.current ?? '')
    if (element && selectedIndex >= 0) {
      element.scrollTop = articleSelectionScrollTop(offsets, selectedIndex, element.scrollTop, element.clientHeight, LIST_PADDING_TOP)
      // An estimated keyboard target needs one final correction after its actual row is measured.
      if (measurements.heights.has(ids[selectedIndex]!)) pendingSelection.current = null
    }
    if (widthChanged) {
      // Parent CSS can resize the pane before its ResizeObserver has delivered a callback.
      widthRef.current = actualWidth
      setWidth(actualWidth)
      const saved = (selectedIndex >= 0 || scrollChanged) && element
        ? captureArticleListAnchor(ids, offsets, element.scrollTop, LIST_PADDING_TOP) : beforeResize
      // The old pixel anchor is unreliable after a tail clamp. Carry end intent only
      // into this exact pending width layout; the following commit consumes the tag.
      const keepEnd = !scrollChanged && selectedIndex < 0 && atEnd
      const endLayout = keepEnd ? { key, width: actualWidth, estimatedRowHeight } : undefined
      pendingAnchor.current = saved ? { scope, generation: measurements.generation, anchor: saved,
        scrollTop: element?.scrollTop ?? viewportRef.current.top, atEnd: keepEnd, endLayout } : null
    }
    updateViewport()
  })

  useLayoutEffect(() => {
    const element = listRef.current
    if (!element) return
    let scrollFrame: number | null = null
    const resize = () => {
      const nextWidth = Math.round(element.clientWidth)
      if (nextWidth > 0 && nextWidth !== widthRef.current) {
        widthRef.current = nextWidth
        // Keep the previous top until layout restoration; the browser may already have clamped it.
        viewportRef.current = { ...viewportRef.current, height: element.clientHeight }
        setWidth(nextWidth)
        setViewport(current => current.height === element.clientHeight ? current : { ...current, height: element.clientHeight })
      } else updateViewport()
    }
    const scrolled = () => {
      // A later user scroll away from the tail wins over a queued measurement correction.
      if (pendingAnchor.current?.atEnd && !articleListAtEnd(element.scrollTop, element.clientHeight, element.scrollHeight)) pendingAnchor.current = null
      if (element.clientWidth > 0 && Math.round(element.clientWidth) !== widthRef.current) { resize(); return }
      viewportRef.current = { top: element.scrollTop, height: element.clientHeight }
      if (scrollFrame === null) scrollFrame = requestAnimationFrame(() => { scrollFrame = null; updateViewport() })
    }
    const cancelPendingSelection = () => {
      pendingSelection.current = null
      pendingAnchor.current = null
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    element.addEventListener('scroll', scrolled, { passive: true })
    element.addEventListener('wheel', cancelPendingSelection, { passive: true })
    element.addEventListener('touchstart', cancelPendingSelection, { passive: true })
    element.addEventListener('pointerdown', cancelPendingSelection, { passive: true })
    resize()
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', scrolled)
      element.removeEventListener('wheel', cancelPendingSelection)
      element.removeEventListener('touchstart', cancelPendingSelection)
      element.removeEventListener('pointerdown', cancelPendingSelection)
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
    }
  }, [listRef, articles.length > 0, updateViewport])
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cancelMeasurementFrame() }
  }, [cancelMeasurementFrame])

  return { ...articleListWindow(offsets, Math.max(0, top - LIST_PADDING_TOP), viewport.height), offsets, measure, invalidateMeasurements }
}
