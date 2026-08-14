import type { DesktopSettings } from '../../shared/settings'
import type { SourceSyncBatchResult } from '../../shared/source-sync'
import type { SyncRuntimeState, SyncTrigger } from '../../shared/sync-runtime'

interface SettingsProvider {
  current(): DesktopSettings
}

interface SyncRunner {
  refreshAllSources(fetchedAt?: number): Promise<SourceSyncBatchResult>
}

/**
 * 桌面端周期同步调度器。
 * 使用递归 setTimeout 而不是 setInterval，确保上一轮同步结束后才安排下一轮，避免慢网络时重叠执行。
 */
export class PeriodicSyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeRun: Promise<SourceSyncBatchResult> | null = null
  private stopped = true
  private state: SyncRuntimeState = {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    nextRunAt: null,
    lastTrigger: null,
    lastResult: null
  }

  constructor(
    private readonly settings: SettingsProvider,
    private readonly syncRunner: SyncRunner,
    private readonly onStateChanged: (state: SyncRuntimeState) => void = () => undefined
  ) {}

  start(): void {
    this.stopped = false
    this.clearTimer()
    if (this.settings.current().syncOnStart) {
      void this.runNow('startup').catch(() => undefined)
    } else {
      this.scheduleNext()
    }
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    this.patchState({ nextRunAt: null })
  }

  reconfigure(): void {
    this.clearTimer()
    if (!this.stopped && !this.activeRun) this.scheduleNext()
  }

  currentState(): SyncRuntimeState {
    return { ...this.state }
  }

  runNow(trigger: SyncTrigger = 'manual'): Promise<SourceSyncBatchResult> {
    if (this.activeRun) return this.activeRun
    this.clearTimer()
    const startedAt = Date.now()
    this.patchState({
      running: true,
      lastStartedAt: startedAt,
      nextRunAt: null,
      lastTrigger: trigger
    })

    this.activeRun = this.syncRunner.refreshAllSources(startedAt)
      .then((result) => {
        this.patchState({
          running: false,
          lastFinishedAt: Date.now(),
          lastResult: result
        })
        return result
      })
      .catch((error) => {
        this.patchState({ running: false, lastFinishedAt: Date.now() })
        throw error
      })
      .finally(() => {
        this.activeRun = null
        if (!this.stopped) this.scheduleNext()
      })
    return this.activeRun
  }

  private scheduleNext(): void {
    const interval = this.settings.current().syncIntervalMinutes
    if (this.stopped || interval <= 0) {
      this.patchState({ nextRunAt: null })
      return
    }
    const delay = interval * 60_000
    const nextRunAt = Date.now() + delay
    this.patchState({ nextRunAt })
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runNow('periodic').catch(() => undefined)
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private patchState(patch: Partial<SyncRuntimeState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChanged(this.currentState())
  }
}

