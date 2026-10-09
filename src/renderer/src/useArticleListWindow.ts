import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ArticleRecord } from '../../shared/library'
import { articleAtOffset, articleListOffsets, articleListWindow } from './article-list-window'

// Matches .list-content padding-top; offsets describe the rows inside that padding.
const LIST_PADDING_TOP = 4

export function useArticleListWindow(articles: ArticleRecord[], scope: string, listRef: RefObject<HTMLDivElement | null>, selectedId: string | null) {
  const heights = useRef(new Map<string, number>())
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const frame = useRef<number | null>(null)
  const ids = useMemo(() => articles.map(article => article.id), [articles])
  const offsets = useMemo(() => articleListOffsets(ids, heights.current), [ids, revision])
  const offsetsRef = useRef(offsets)
  const pendingAnchor = useRef<number | null>(null)
  const previousSelection = useRef<string | null>(null)
  const pendingSelection = useRef<string | null>(null)
  useLayoutEffect(() => {
    offsetsRef.current = offsets
    if (pendingAnchor.current !== null && listRef.current) {
      listRef.current.scrollTop = pendingAnchor.current
      setViewport(current => ({ ...current, top: listRef.current!.scrollTop }))
      pendingAnchor.current = null
    }
  }, [offsets, listRef])
  useLayoutEffect(() => {
    const retained = new Set(ids)
    for (const id of heights.current.keys()) if (!retained.has(id)) heights.current.delete(id)
  }, [ids])
  const measure = useCallback((id: string, height: number) => {
    if (height <= 0 || heights.current.get(id) === height) return
    const element = listRef.current
    heights.current.set(id, height)
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null
      // Apply one anchor adjustment for the complete ResizeObserver batch, after DOM offsets commit.
      if (element) {
        const anchor = articleAtOffset(offsetsRef.current, Math.max(0, element.scrollTop - LIST_PADDING_TOP))
        const nextOffsets = articleListOffsets(ids, heights.current)
        pendingAnchor.current = element.scrollTop + nextOffsets[anchor]! - offsetsRef.current[anchor]!
      }
      setRevision(value => value + 1)
    })
  }, [ids, listRef])
  useLayoutEffect(() => {
    const element = listRef.current
    if (!element) return
    let scrollFrame: number | null = null
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    const scrolled = () => {
      if (scrollFrame === null) scrollFrame = requestAnimationFrame(() => { scrollFrame = null; update() })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.addEventListener('scroll', scrolled, { passive: true })
    update()
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', scrolled)
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
    }
  }, [listRef, articles.length > 0])
  useLayoutEffect(() => {
    pendingSelection.current = null
    pendingAnchor.current = null
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
      setRevision(value => value + 1)
    }
    if (listRef.current) listRef.current.scrollTop = 0
    setViewport(current => ({ ...current, top: 0 }))
  }, [scope, listRef])
  useLayoutEffect(() => {
    // A filter/scope reset must not scroll back to an unchanged Reader selection.
    // Keep a new selection pending until its asynchronous source list has loaded.
    if (previousSelection.current !== selectedId) {
      previousSelection.current = selectedId
      pendingSelection.current = selectedId
    }
    const element = listRef.current
    const index = ids.indexOf(pendingSelection.current ?? '')
    if (!element || index < 0) return
    pendingSelection.current = null
    const top = offsetsRef.current[index]! + LIST_PADDING_TOP
    const bottom = offsetsRef.current[index + 1]! + LIST_PADDING_TOP
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, bottom - element.clientHeight)
    setViewport(current => ({ ...current, top: element.scrollTop }))
  }, [selectedId, ids, listRef])
  useLayoutEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])
  return { ...articleListWindow(offsets, Math.max(0, viewport.top - LIST_PADDING_TOP), viewport.height), offsets, measure }
}
