export interface OriginalViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export type OriginalNavigationAction = 'back' | 'forward' | 'reload'

export interface OriginalArticleViewState {
  open: boolean
  url: string | null
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

