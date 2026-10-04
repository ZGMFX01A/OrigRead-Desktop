import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SyncSettingsPanel } from '../SyncSettingsPanel'

/** 控制状态轮询不读取业务图，所有安装终态仍以持久围栏是否解除为准。 */
const VISIBILITY_POLL_MS = 250

interface Props { children: ReactNode; onVisible(): void }

/** 围栏期间停止业务交互，保留同步设置；解除后重新加载真实数据。 */
export function SnapshotInstallVisibility(props: Props): ReactNode {
  const { i18n } = useTranslation()
  const [installing, setInstalling] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [showingRecovery, setShowingRecovery] = useState(false)
  const onVisible = useRef(props.onVisible)
  onVisible.current = props.onVisible
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, previous: boolean | undefined
    // 每次状态请求结束后再调度下一次，主进程繁忙时不累计并发请求。
    const update = async (): Promise<void> => {
      try {
        const status = await window.origread.getSyncStatus()
        if (stopped) return
        const current = status.snapshotInstalling === true
        setInstalling(current); setFailure(null)
        if (previous === true && !current) onVisible.current()
        previous = current
      } catch (error) {
        // 控制面不可用必须明确阻止业务显示，不用旧完成状态掩盖未知围栏。
        if (stopped) return
        setFailure(error instanceof Error ? error.message : String(error)); setInstalling(true)
      }
      if (!stopped) timer = setTimeout(() => { void update() }, VISIBILITY_POLL_MS)
    }
    void update()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [])
  const chinese = i18n.language.startsWith('zh')
  const blocked = installing
  return <>
    <div inert={blocked ? true : undefined}>{props.children}</div>
    {blocked && <section role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, zIndex: 10000,
      background: 'var(--color-background, #fff)', display: 'grid', placeContent: 'center', textAlign: 'center', gap: 16 }}>
      <p>{failure ?? (chinese ? '正在安装同步数据，完成后恢复显示' : 'Installing synchronized data. Display resumes when complete.')}</p>
      {showingRecovery ? <div style={{ maxHeight: '90vh', overflow: 'auto', textAlign: 'left' }}><SyncSettingsPanel /></div>
        : <button onClick={() => setShowingRecovery(true)}>{chinese ? '同步状态与恢复' : 'Sync status and recovery'}</button>}
    </section>}
  </>
}
