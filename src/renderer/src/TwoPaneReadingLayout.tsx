import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { PaneDivider } from './PaneDivider'
import { TwoPaneWorkspace } from './TwoPaneWorkspace'

interface TwoPaneReadingLayoutProps {
  workspaceHeader: ReactNode
  workspaceContent: ReactNode
  workspaceOverlay?: ReactNode
  workspaceAriaLabel: string
  width: number
  minWidth: number
  maxWidth: number
  collapsed: boolean
  focusReading: boolean
  resizeLabel: string
  collapseLabel: string
  expandLabel: string
  exitFocusLabel: string
  onResize: (width: number) => void
  onResizeEnd: (width: number) => void
  onToggleCollapsed: () => void
}

/**
 * 双栏模式的纯布局层：Workspace + Divider + 折叠恢复入口。
 *
 * Reader 仍由 App 统一渲染；这里不保存宽度、折叠、来源或文章状态，避免形成第二套业务状态机。
 */
export function TwoPaneReadingLayout({
  workspaceHeader,
  workspaceContent,
  workspaceOverlay,
  workspaceAriaLabel,
  width,
  minWidth,
  maxWidth,
  collapsed,
  focusReading,
  resizeLabel,
  collapseLabel,
  expandLabel,
  exitFocusLabel,
  onResize,
  onResizeEnd,
  onToggleCollapsed
}: TwoPaneReadingLayoutProps): React.JSX.Element {
  return (
    <>
      {!collapsed && (
        <TwoPaneWorkspace
          header={workspaceHeader}
          content={workspaceContent}
          overlay={workspaceOverlay}
          ariaLabel={workspaceAriaLabel}
        />
      )}

      <PaneDivider
        kind="workspace"
        width={width}
        minWidth={minWidth}
        maxWidth={maxWidth}
        ariaLabel={resizeLabel}
        resizable={!collapsed}
        collapsed={collapsed}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      >
        {!collapsed && (
          <button
            className="collapse-handle workspace-collapse-handle"
            type="button"
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={onToggleCollapsed}
          >
            <ChevronLeft size={15}/>
          </button>
        )}
      </PaneDivider>

      {collapsed && (
        <button
          className="collapsed-pane-restore restore-at-start workspace-restore"
          type="button"
          data-hidden-count="1"
          aria-label={focusReading ? exitFocusLabel : expandLabel}
          title={focusReading ? exitFocusLabel : expandLabel}
          onClick={onToggleCollapsed}
        >
          <ChevronRight size={14}/>
        </button>
      )}
    </>
  )
}
