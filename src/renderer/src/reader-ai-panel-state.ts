export type ReaderAiPanelView = 'home' | 'summary' | 'chat'

export type ReaderAiPanelSurface = ReaderAiPanelView | 'detail'

export type ReaderAiPanelDetailView =
  | 'conversation-history'
  | 'chat-search'
  | 'context'
  | 'sources'
  | 'web-search'
  | 'tool'

export interface ReaderAiPanelState {
  open: boolean
  view: ReaderAiPanelView
  conversationId: string | null
  detailView: ReaderAiPanelDetailView | null
  detailTargetId: string | null
}

export const INITIAL_READER_AI_PANEL_STATE: ReaderAiPanelState = {
  open: false,
  view: 'home',
  conversationId: null,
  detailView: null,
  detailTargetId: null
}

export function openReaderAiPanel(
  current: ReaderAiPanelState,
  view: ReaderAiPanelView = current.view
): ReaderAiPanelState {
  return {
    ...current,
    open: true,
    view,
    detailView: null,
    detailTargetId: null
  }
}

export function closeReaderAiPanel(current: ReaderAiPanelState): ReaderAiPanelState {
  if (!current.open && current.detailView === null && current.detailTargetId === null) return current
  return {
    ...current,
    open: false,
    detailView: null,
    detailTargetId: null
  }
}

export function openReaderAiPanelDetail(
  current: ReaderAiPanelState,
  detailView: ReaderAiPanelDetailView,
  detailTargetId: string | null = null
): ReaderAiPanelState {
  return {
    ...current,
    open: true,
    detailView,
    detailTargetId
  }
}

export function closeReaderAiPanelDetail(current: ReaderAiPanelState): ReaderAiPanelState {
  if (current.detailView === null && current.detailTargetId === null) return current
  return {
    ...current,
    detailView: null,
    detailTargetId: null
  }
}

export function readerAiPanelSurface(current: Pick<ReaderAiPanelState, 'view' | 'detailView'>): ReaderAiPanelSurface {
  return current.detailView ? 'detail' : current.view
}

export function resetReaderAiPanel(): ReaderAiPanelState {
  return { ...INITIAL_READER_AI_PANEL_STATE }
}
