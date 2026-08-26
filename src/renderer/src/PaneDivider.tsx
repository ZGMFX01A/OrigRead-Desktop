import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

interface PaneDividerProps {
  kind: 'workspace' | 'source' | 'article'
  width: number
  minWidth: number
  maxWidth: number
  ariaLabel: string
  resizable?: boolean
  collapsed?: boolean
  children?: ReactNode
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
}

interface DragState {
  pointerId: number
  startX: number
  startWidth: number
  lastWidth: number
}

/**
 * Desktop 阅读布局共用的纵向分隔条。
 *
 * pointermove 只更新 Renderer 本地宽度，pointerup / pointercancel 才通知父层持久化，
 * 避免拖动过程中持续触发 Settings IPC 与磁盘写入。
 */
export function PaneDivider({
  kind,
  width,
  minWidth,
  maxWidth,
  ariaLabel,
  resizable = true,
  collapsed = false,
  children,
  onResize,
  onResizeEnd
}: PaneDividerProps): React.JSX.Element {
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)

  const clampWidth = (value: number): number => Math.max(minWidth, Math.min(maxWidth, Math.round(value)))

  const widthForPointer = (event: PointerEvent<HTMLDivElement>, drag: DragState): number =>
    clampWidth(drag.startWidth + event.clientX - drag.startX)

  /** 键盘调整与鼠标拖拽共用同一套宽度约束，并在一次按键后立即持久化。 */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!resizable) return
    const step = event.shiftKey ? 32 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = clampWidth(width - step)
    if (event.key === 'ArrowRight') next = clampWidth(width + step)
    if (event.key === 'Home') next = minWidth
    if (event.key === 'End') next = maxWidth
    if (next === null) return
    event.preventDefault()
    onResize(next)
    onResizeEnd(next)
  }

  const finishDrag = (event: PointerEvent<HTMLDivElement>, useLastWidth = false): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = useLastWidth ? drag.lastWidth : widthForPointer(event, drag)
    dragRef.current = null
    setDragging(false)
    onResize(next)
    onResizeEnd(next)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className={`pane-divider pane-divider-${kind} ${dragging ? 'dragging' : ''} ${resizable ? 'resizable' : ''} ${collapsed ? 'collapsed' : ''}`}
      data-pane={kind}
      data-collapsed={collapsed ? 'true' : 'false'}
      role={resizable ? 'separator' : undefined}
      tabIndex={resizable ? 0 : undefined}
      aria-label={resizable ? ariaLabel : undefined}
      aria-orientation={resizable ? 'vertical' : undefined}
      aria-valuemin={resizable ? minWidth : undefined}
      aria-valuemax={resizable ? maxWidth : undefined}
      aria-valuenow={resizable ? width : undefined}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (!resizable || event.button !== 0 || event.target !== event.currentTarget) return
        event.preventDefault()
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          lastWidth: width
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
        onResize(next)
      }}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      {children}
    </div>
  )
}
