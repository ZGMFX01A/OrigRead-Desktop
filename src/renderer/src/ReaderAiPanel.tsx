import { SlidersHorizontal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiSummaryPlacement } from '../../shared/settings'
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
  /** High-frequency local preview; must not persist through IPC on every range input event. */
  onPanelSizePreview(size: number): void
  /** Persist only after the user finishes one resize interaction. */
  onPanelSizeCommit(size: number): void
  onClose(): void
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
  const [sizeEditorOpen, setSizeEditorOpen] = useState(false)
  const surface = readerAiPanelSurface({ view, detailView })

  return (
    <aside
      className={`reader-ai-panel ai-summary-panel docked placement-${placement}`}
      data-reader-ai-view={view}
      data-reader-ai-surface={surface}
      data-reader-ai-detail={detailView ?? ''}
    >
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
            onChange={(event) => {
              setSizeEditorOpen(false)
              onPlacementChange(event.target.value as AiSummaryPlacement)
            }}
          >
            <option value="left">{t('summaryPlacementLeft')}</option>
            <option value="right">{t('summaryPlacementRight')}</option>
          </select>
          <div className="ai-summary-size-control">
            <button
              type="button"
              className={`icon-button ${sizeEditorOpen ? 'active' : ''}`}
              title={t('summaryPanelSize')}
              aria-label={t('summaryPanelSize')}
              aria-expanded={sizeEditorOpen}
              onClick={() => setSizeEditorOpen((open) => !open)}
            >
              <SlidersHorizontal size={15}/>
            </button>
            {sizeEditorOpen && (
              <div className="ai-summary-size-popover">
                <div><span>{t('summaryPanelWidth')}</span><strong>{panelSize}px</strong></div>
                <input
                  aria-label={t('summaryPanelWidth')}
                  type="range"
                  min="220"
                  max="640"
                  step="10"
                  value={panelSize}
                  onChange={(event) => onPanelSizePreview(Number(event.target.value))}
                  onPointerUp={(event) => onPanelSizeCommit(Number(event.currentTarget.value))}
                  onKeyUp={(event) => onPanelSizeCommit(Number(event.currentTarget.value))}
                  onBlur={(event) => onPanelSizeCommit(Number(event.currentTarget.value))}
                />
              </div>
            )}
          </div>
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
