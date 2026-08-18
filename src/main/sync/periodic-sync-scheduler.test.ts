import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from '../../shared/settings'
import type { SourceSyncBatchResult } from '../../shared/source-sync'
import { PeriodicSyncScheduler } from './periodic-sync-scheduler'

const BASE_TIME = new Date('2026-08-14T08:00:00.000Z')

describe('PeriodicSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_TIME)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at the configured Android-compatible interval without overlap', async () => {
    const settings = { value: createSettings({ syncIntervalMinutes: 15 }) }
    const refresh = vi.fn(async () => result())
    const scheduler = new PeriodicSyncScheduler({ current: () => settings.value }, { refreshAllSources: refresh })

    scheduler.start()
    expect(scheduler.currentState().nextRunAt).toBe(BASE_TIME.getTime() + 15 * 60_000)
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.runAllTicks()
    expect(scheduler.currentState().lastTrigger).toBe('periodic')
  })

  it('syncs once on startup when enabled and then schedules the next interval', async () => {
    const settings = createSettings({ syncOnStart: true, syncIntervalMinutes: 30 })
    const refresh = vi.fn(async () => result())
    const scheduler = new PeriodicSyncScheduler({ current: () => settings }, { refreshAllSources: refresh })

    scheduler.start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(scheduler.currentState().lastTrigger).toBe('startup')
    expect(scheduler.currentState().nextRunAt).toBe(BASE_TIME.getTime() + 30 * 60_000)
  })

  it('manual mode disables the timer and reconfigure applies changes immediately', () => {
    const settings = { value: createSettings({ syncIntervalMinutes: 30 }) }
    const scheduler = new PeriodicSyncScheduler(
      { current: () => settings.value },
      { refreshAllSources: async () => result() }
    )
    scheduler.start()
    expect(scheduler.currentState().nextRunAt).not.toBeNull()

    settings.value = createSettings({ syncIntervalMinutes: 0 })
    scheduler.reconfigure()
    expect(scheduler.currentState().nextRunAt).toBeNull()
  })

  it('deduplicates overlapping all-source runs', async () => {
    let finish!: (value: SourceSyncBatchResult) => void
    const refresh = vi.fn(() => new Promise<SourceSyncBatchResult>((resolve) => { finish = resolve }))
    const scheduler = new PeriodicSyncScheduler(
      { current: () => createSettings({ syncIntervalMinutes: 15 }) },
      { refreshAllSources: refresh }
    )
    scheduler.start()

    const first = scheduler.runNow('manual')
    const second = scheduler.runNow('periodic')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    finish(result())
    await first
  })

  it('applies charging constraints only to periodic runs and retries after the constraint becomes available', async () => {
    const settings = createSettings({ syncOnStart: true, syncIntervalMinutes: 15 })
    const refresh = vi.fn(async () => result())
    let charging = false
    const scheduler = new PeriodicSyncScheduler(
      { current: () => settings },
      { refreshAllSources: refresh },
      () => undefined,
      () => charging
    )

    scheduler.start()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1) // startup is intentionally unconstrained, matching Android one-time sync

    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(scheduler.currentState().nextRunAt).toBe(Date.now() + 60_000)

    charging = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(scheduler.currentState().lastTrigger).toBe('periodic')

    await scheduler.runNow('manual')
    expect(refresh).toHaveBeenCalledTimes(3)
  })
})

function createSettings(overrides: Partial<DesktopSettings> = {}): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    ...overrides
  }
}

function result(): SourceSyncBatchResult {
  const now = Date.now()
  return {
    startedAt: now,
    finishedAt: now,
    sourceCount: 0,
    successCount: 0,
    failedCount: 0,
    fetchedArticles: 0,
    insertedArticles: 0,
    deletedArticles: 0,
    retryRecommended: false,
    results: []
  }
}

