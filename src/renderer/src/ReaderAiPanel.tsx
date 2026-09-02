import { X } from 'lucide-react'
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  READER_AI_PANEL_WIDTH_MAX,
  READER_AI_PANEL_WIDTH_MIN,
  type AiSummaryPlacement
} from '../../shared/settings'
import {
  readerAiPanelSurface,
  type ReaderAiPanelDetailView,
  type ReaderAiPanelView
} from './reader-ai-panel-state'

export interface ReaderAiPanelShellProps {
  view: ReaderAiPanelView
  detailView: ReaderAiPanelDetailView | null
  placement: AiSummaryPlacement
  panelSize: number
  leading?: ReactNode
  title: string
  subtitle?: string | null
  badge?: ReactNode
  actions?: ReactNode
  children: ReactNode
  onPlacementChange(placement: AiSummaryPlacement): void
  /** High-frequency local preview; must not persist through IPC on every pointermove event. */
  onPanelSizePreview(size: number): void
  /** Persist only after the user finishes one resize interaction. */
  onPanelSizeCommit(size: number): void
  onClose(): void
}

interface PanelResizeDragState {
  pointerId: number
  startX: number
  startWidth: number
  lastWidth: number
  moved: boolean
}

/**
 * Reader 内唯一的 AI 容器外壳。
 *
 * Summary / Chat / Home / Detail 共享同一套位置、尺寸、关闭与 Header 布局；
 * 各能力只负责自己的 body / actions，避免后续再复制第二套 Panel。
 */
export function ReaderAiPanelShell({
  view,
  detailView,
  placement,
  panelSize,
  leading,
  title,
  subtitle,
  badge,
  actions,
  children,
  onPlacementChange,
  onPanelSizePreview,
  onPanelSizeCommit,
  onClose
}: ReaderAiPanelShellProps): React.JSX.Element {
  const { t } = useTranslation()
  const dragRef = useRef<PanelResizeDragState | null>(null)
  const [dragging, setDragging] = useState(false)
  const surface = readerAiPanelSurface({ view, detailView })

  const clampPanelWidth = (value: number): number => Math.max(
    READER_AI_PANEL_WIDTH_MIN,
    Math.min(READER_AI_PANEL_WIDTH_MAX, Math.round(value))
  )

  const widthForPointer = (event: PointerEvent<HTMLDivElement>, drag: PanelResizeDragState): number => {
    const delta = placement === 'left'
      ? event.clientX - drag.startX
      : drag.startX - event.clientX
    return clampPanelWidth(drag.startWidth + delta)
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>, useLastWidth = false): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = useLastWidth ? drag.lastWidth : widthForPointer(event, drag)
    dragRef.current = null
    setDragging(false)
    if (drag.moved) {
      onPanelSizePreview(next)
      onPanelSizeCommit(next)
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 16
    let next: number | null = null
    if (event.key === 'Home') next = READER_AI_PANEL_WIDTH_MIN
    if (event.key === 'End') next = READER_AI_PANEL_WIDTH_MAX
    if (event.key === 'ArrowLeft') next = clampPanelWidth(panelSize + (placement === 'right' ? step : -step))
    if (event.key === 'ArrowRight') next = clampPanelWidth(panelSize + (placement === 'left' ? step : -step))
    if (next === null || next === panelSize) return
    event.preventDefault()
    onPanelSizePreview(next)
    onPanelSizeCommit(next)
  }

  return (
    <aside
      className={`reader-ai-panel ai-summary-panel docked placement-${placement}`}
      data-reader-ai-view={view}
      data-reader-ai-surface={surface}
      data-reader-ai-detail={detailView ?? ''}
    >
      <div
        className={`reader-ai-panel-resize-handle ${dragging ? 'dragging' : ''}`}
        role="separator"
        tabIndex={0}
        aria-label={t('summaryPanelResize')}
        aria-orientation="vertical"
        aria-valuemin={READER_AI_PANEL_WIDTH_MIN}
        aria-valuemax={READER_AI_PANEL_WIDTH_MAX}
        aria-valuenow={Math.round(panelSize)}
        title={t('summaryPanelResize')}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: panelSize,
            lastWidth: panelSize,
            moved: false
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const next = widthForPointer(event, drag)
          if (next === drag.lastWidth) return
          drag.lastWidth = next
          drag.moved = true
          onPanelSizePreview(next)
        }}
        onPointerUp={finishResize}
        onPointerCancel={(event) => finishResize(event, true)}
      />
      <header className="reader-ai-panel-header ai-summary-panel-header">
        <div className="reader-ai-panel-identity ai-summary-panel-identity">
          {leading}
          <div>
            <strong>{title}</strong>
            {subtitle ? <span>{subtitle}</span> : null}
          </div>
          {badge}
        </div>
        <div className="reader-ai-panel-actions ai-summary-panel-actions">
          <select
            value={placement}
            aria-label={t('summaryPlacement')}
            title={t('summaryPlacement')}
            onChange={(event) => onPlacementChange(event.target.value as AiSummaryPlacement)}
          >
            <option value="left">{t('summaryPlacementLeft')}</option>
            <option value="right">{t('summaryPlacementRight')}</option>
          </select>
          {actions}
          <button type="button" className="icon-button" title={t('close')} aria-label={t('close')} onClick={onClose}>
            <X size={15}/>
          </button>
        </div>
      </header>
      <div className="reader-ai-panel-body ai-summary-panel-body">{children}</div>
    </aside>
  )
}
