import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface TwoPaneSourcePickerOverlayProps {
  title: string
  closeLabel: string
  children: ReactNode
  onClose: () => void
}

/**
 * 双栏 Workspace 内部的来源选择浮层。
 *
 * 浮层只覆盖左侧 Workspace 内容区，不遮挡 Reader，也不持有来源范围或搜索状态。
 */
export function TwoPaneSourcePickerOverlay({
  title,
  closeLabel,
  children,
  onClose
}: TwoPaneSourcePickerOverlayProps): React.JSX.Element {
  return (
    <section
      className="two-pane-source-picker-overlay"
      role="dialog"
      aria-label={title}
      aria-modal="false"
    >
      <header className="two-pane-source-picker-overlay-header">
        <strong>{title}</strong>
        <button
          type="button"
          className="icon-button two-pane-source-picker-close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <X size={16}/>
        </button>
      </header>
      <div className="two-pane-source-picker-overlay-body">{children}</div>
    </section>
  )
}
