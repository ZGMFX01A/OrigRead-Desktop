import { useLayoutEffect, useState, type RefObject } from 'react'

export type ReaderToolbarDensity = 'wide' | 'compact' | 'tight'

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
}

/**
 * Keep native caption controls in the existing toolbar. Geometry stays in CSS
 * viewport coordinates; never add an OS title-bar offset to reader view bounds.
 */
export function useWindowChrome(
  platform: string | undefined,
  toolbarRef: RefObject<HTMLElement | null>
): ReaderToolbarDensity {
  const [density, setDensity] = useState<ReaderToolbarDensity>('compact')

  useLayoutEffect(() => {
    const root = document.documentElement
    const previousMode = root.dataset.windowChrome
    const previousVisible = root.dataset.windowControlsVisible
    const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
    root.dataset.windowChrome = platform === 'win32' ? 'overlay' : 'native'
    const updateVisibility = (): void => {
      root.dataset.windowControlsVisible = String(platform === 'win32' && (overlay?.visible ?? true))
    }
    updateVisibility()
    overlay?.addEventListener('geometrychange', updateVisibility)
    return () => {
      overlay?.removeEventListener('geometrychange', updateVisibility)
      if (previousMode === undefined) delete root.dataset.windowChrome
      else root.dataset.windowChrome = previousMode
      if (previousVisible === undefined) delete root.dataset.windowControlsVisible
      else root.dataset.windowControlsVisible = previousVisible
    }
  }, [platform])

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const update = (width: number): void => {
      // ResizeObserver's content box excludes caption-control padding. Using
      // the whole reader pane here would hide actions behind the native buttons.
      setDensity(width >= 650 ? 'wide' : width >= 330 ? 'compact' : 'tight')
    }
    const measure = (): void => {
      const style = getComputedStyle(toolbar)
      update(toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))
    }
    measure()
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [platform, toolbarRef])

  return density
}
