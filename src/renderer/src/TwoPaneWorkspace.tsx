import type { ReactNode } from 'react'

interface TwoPaneWorkspaceProps {
  header: ReactNode
  content: ReactNode
  overlay?: ReactNode
  ariaLabel: string
}

/**
 * 双栏模式的左侧 Workspace 外壳。
 *
 * 组件只组合品牌操作区和当前 Article / Source 内容，不持有任何来源、文章或 Reader 业务状态。
 */
export function TwoPaneWorkspace({ header, content, overlay, ariaLabel }: TwoPaneWorkspaceProps): React.JSX.Element {
  return (
    <section className="workspace-pane two-pane-workspace" aria-label={ariaLabel}>
      {header}
      <div className="two-pane-workspace-content">
        <div className="two-pane-workspace-base">
          {content}
        </div>
        {overlay}
      </div>
    </section>
  )
}
