import { useRef, useState, type PointerEvent, type ReactNode } from 'react'

interface PaneDividerProps {
  kind: 'source' | 'article'
  width: number
  minWidth: number
  maxWidth: number
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
 * 三栏阅读器的纵向分隔条。
 *
 * pointermove 只更新 Renderer 本地宽度，pointerup / pointercancel 才通知父层持久化，
 * 避免拖动过程中持续触发 Settings IPC 与磁盘写入。
 */
export function PaneDivider({
  kind,
  width,
  minWidth,
  maxWidth,
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
      aria-orientation={resizable ? 'vertical' : undefined}
      aria-valuemin={resizable ? minWidth : undefined}
      aria-valuemax={resizable ? maxWidth : undefined}
      aria-valuenow={resizable ? width : undefined}
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
