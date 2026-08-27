import { X } from 'lucide-react'
import type { ReactNode, RefObject } from 'react'

interface SourceManagerOverlayProps {
  title: string
  closeLabel: string
  closeButtonRef?: RefObject<HTMLButtonElement | null>
  children: ReactNode
  onClose: () => void
}

/**
 * 双栏模式下的低频来源管理视图。
 *
 * 与高频 Source Switcher 分离：该 Overlay 只在用户主动进入“管理来源”时覆盖 Workspace，
 * Reader 仍保持当前文章，不承担快速切换来源职责。
 */
export function SourceManagerOverlay({
  title,
  closeLabel,
  closeButtonRef,
  children,
  onClose
}: SourceManagerOverlayProps): React.JSX.Element {
  return (
    <section
      className="source-manager-overlay"
      role="dialog"
      aria-label={title}
      aria-modal="false"
    >
      <header className="source-manager-overlay-header">
        <strong>{title}</strong>
        <button
          ref={closeButtonRef}
          type="button"
          className="icon-button source-manager-close"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <X size={16}/>
        </button>
      </header>
      <div className="source-manager-overlay-body">{children}</div>
    </section>
  )
}
