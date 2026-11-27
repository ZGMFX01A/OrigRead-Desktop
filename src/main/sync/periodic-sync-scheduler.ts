import type { SourceSyncBatchResult } from '../../shared/source-sync'
import type { SyncRuntimeState, SyncTrigger } from '../../shared/sync-runtime'

interface SettingsProvider {
  current(): { syncIntervalMinutes:number; syncOnStart:boolean; syncOnlyWhenCharging?:boolean }
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
  private readonly activeRuns = new Map<number, Promise<SourceSyncBatchResult>>()
  private readonly states = new Map<number, SyncRuntimeState>()
  private timerAccountId: number | null = null
  private stopped = true


  constructor(
    private readonly settings: SettingsProvider,
    private readonly syncRunner: SyncRunner,
    private readonly onStateChanged: (state: SyncRuntimeState) => void = () => undefined,
    private readonly periodicConstraintsSatisfied: () => boolean = () => true,
    private readonly getCurrentAccountId: () => number = () => 1
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
    if (!this.stopped && !this.activeRuns.has(this.getCurrentAccountId())) this.scheduleNext()
    else this.onStateChanged(this.currentState())
  }

  currentState(): SyncRuntimeState {
    return { ...this.stateFor(this.getCurrentAccountId()) }
  }

  runNow(trigger: SyncTrigger = 'manual'): Promise<SourceSyncBatchResult> {
    const accountId = this.getCurrentAccountId()
    const existing = this.activeRuns.get(accountId)
    if (existing) return existing
    this.clearTimer()
    const startedAt = Date.now()
    this.patchState({
      running: true,
      lastStartedAt: startedAt,
      nextRunAt: null,
      lastTrigger: trigger
    }, accountId)

    const run = this.syncRunner.refreshAllSources(startedAt)
      .then((result) => {
        this.patchState({
          running: false,
          lastFinishedAt: Date.now(),
          lastResult: result
        }, accountId)
        return result
      })
      .catch((error) => {
        this.patchState({ running: false, lastFinishedAt: Date.now() }, accountId)
        throw error
      })
      .finally(() => {
        this.activeRuns.delete(accountId)
        if (!this.stopped && this.getCurrentAccountId() === accountId) this.scheduleNext()
      })
    this.activeRuns.set(accountId, run)
    return run
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
    const accountId = this.getCurrentAccountId()
    this.timerAccountId = accountId
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerAccountId = null
      if (this.stopped || this.getCurrentAccountId() !== accountId) return
      if (!this.periodicConstraintsSatisfied()) {
        this.scheduleConstraintRetry()
        return
      }
      void this.runNow('periodic').catch(() => undefined)
    }, delay)
  }

  private scheduleConstraintRetry(): void {
    if (this.stopped) return
    const delay = 60_000
    this.patchState({ nextRunAt: Date.now() + delay })
    const accountId = this.getCurrentAccountId()
    this.timerAccountId = accountId
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerAccountId = null
      if (this.stopped || this.getCurrentAccountId() !== accountId) return
      if (!this.periodicConstraintsSatisfied()) {
        this.scheduleConstraintRetry()
        return
      }
      void this.runNow('periodic').catch(() => undefined)
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.timerAccountId !== null) this.patchState({ nextRunAt: null }, this.timerAccountId)
    this.timerAccountId = null
  }

  private stateFor(accountId: number): SyncRuntimeState {
    let state = this.states.get(accountId)
    if (!state) {
      state = { running: false, lastStartedAt: null, lastFinishedAt: null, nextRunAt: null, lastTrigger: null, lastResult: null }
      this.states.set(accountId, state)
    }
    return state
  }

  private patchState(patch: Partial<SyncRuntimeState>, accountId = this.getCurrentAccountId()): void {
    this.states.set(accountId, { ...this.stateFor(accountId), ...patch })
    if (accountId === this.getCurrentAccountId()) this.onStateChanged(this.currentState())
  }
}
