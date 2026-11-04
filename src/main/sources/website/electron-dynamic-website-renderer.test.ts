import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  ElectronDynamicWebsiteRenderer,
  DynamicWebsiteRenderError,
  MAX_ACTIVE_DYNAMIC_WINDOWS,
  MAX_DYNAMIC_RENDER_QUEUE_SIZE
} from './electron-dynamic-website-renderer'

const { mockCreatedWindows, MockBrowserWindow } = vi.hoisted(() => {
  const mockCreatedWindows: any[] = []

  class MockBrowserWindow {
    url = ''
    isDestroyedFlag = false
    listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    webContents = {
      setAudioMuted: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn() },
      setWindowOpenHandler: vi.fn(),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (!this.listeners.has(event)) this.listeners.set(event, [])
        this.listeners.get(event)!.push(handler)
      },
      executeJavaScript: vi.fn().mockImplementation(async () => {
        if (this.url.includes('js-error')) {
          throw new Error('Script execution context destroyed')
        }
        return '<html><head><title>Rendered</title></head><body><article><h1>Rendered</h1><p>Dynamic Content</p></article></body></html>'
      }),
      getURL: vi.fn().mockImplementation(() => this.url || 'https://example.com/test')
    }

    constructor() {
      mockCreatedWindows.push(this)
    }

    isDestroyed(): boolean {
      return this.isDestroyedFlag
    }

    destroy(): void {
      this.isDestroyedFlag = true
    }

    async loadURL(targetUrl: string): Promise<void> {
      this.url = targetUrl
      if (targetUrl.includes('hang')) {
        return new Promise<void>(() => {
          // 挂起不返回，模拟请求超时
        })
      }
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!this.isDestroyedFlag) {
            for (const handler of this.listeners.get('did-finish-load') ?? []) {
              handler()
            }
          }
          resolve()
        }, 10)
      })
    }
  }

  return { mockCreatedWindows, MockBrowserWindow }
})

vi.mock('electron', () => {
  return { BrowserWindow: MockBrowserWindow }
})

describe('ElectronDynamicWebsiteRenderer', () => {
  beforeEach(() => {
    mockCreatedWindows.length = 0
  })

  it('strictly limits active hidden window to 1 and enforces queue capacity', async () => {
    const renderer = new ElectronDynamicWebsiteRenderer()
    expect(MAX_ACTIVE_DYNAMIC_WINDOWS).toBe(1)
    expect(MAX_DYNAMIC_RENDER_QUEUE_SIZE).toBe(8)

    const abortControllers: AbortController[] = []
    const promises: Array<Promise<unknown>> = []
    for (let i = 0; i < 9; i++) {
      const ac = new AbortController()
      abortControllers.push(ac)
      promises.push(renderer.render(`https://example.com/page/${i}`, ac.signal).catch((err) => err))
    }

    expect(renderer.activeWindowsCount).toBe(1)
    expect(renderer.waitingQueueSize).toBe(8)

    // 第 10 个任务超出队列容量，必须立即抛错拒绝
    await expect(renderer.render('https://example.com/overflow')).rejects.toThrow(DynamicWebsiteRenderError)

    // 清理任务
    for (const ac of abortControllers) {
      ac.abort()
    }
    await Promise.all(promises)

    expect(renderer.activeWindowsCount).toBe(0)
    expect(renderer.waitingQueueSize).toBe(0)
  })

  it('immediately cancels queued tasks on abort signal and frees queue slot without creating window', async () => {
    const renderer = new ElectronDynamicWebsiteRenderer()
    const ac1 = new AbortController()
    const task1 = renderer.render('https://example.com/slow1', ac1.signal).catch((err) => err)

    const controller2 = new AbortController()
    const task2 = renderer.render('https://example.com/queued2', controller2.signal)

    expect(renderer.waitingQueueSize).toBe(1)
    expect(mockCreatedWindows.length).toBe(1)

    // 在排队期间取消 task2
    controller2.abort()

    await expect(task2).rejects.toThrow('动态页面渲染已取消')
    expect(renderer.waitingQueueSize).toBe(0)

    ac1.abort()
    await task1
    expect(renderer.activeWindowsCount).toBe(0)
    expect(mockCreatedWindows.length).toBe(1)
    expect(mockCreatedWindows[0]?.isDestroyed()).toBe(true)
  })

  it('destroys window on 15s timeout and allows subsequent queued task to complete successfully', { timeout: 25_000 }, async () => {
    vi.useFakeTimers()
    try {
      const renderer = new ElectronDynamicWebsiteRenderer()

      let task1Error: unknown = null
      const promise1 = renderer.render('https://example.com/hang')
      promise1.catch((err) => { task1Error = err })

      expect(mockCreatedWindows.length).toBe(1)
      const window1 = mockCreatedWindows[0]!

      // 任务 2 排队
      const promise2 = renderer.render('https://example.com/normal-after-timeout')
      expect(renderer.waitingQueueSize).toBe(1)

      // 推进 15 秒触发任务 1 超时
      await vi.advanceTimersByTimeAsync(15_000)
      expect(task1Error).toMatchObject({ message: '动态页面渲染超时' })

      // 断言 window1 已被真实销毁
      expect(window1.isDestroyed()).toBe(true)

      // 任务 2 自动进入活动窗口调度
      expect(mockCreatedWindows.length).toBe(2)
      const window2 = mockCreatedWindows[1]!

      // 推进时间完成任务 2 的 loadURL 和 settleTimer
      await vi.advanceTimersByTimeAsync(2000)
      const result2 = await promise2

      expect(result2.html).toContain('Rendered')
      expect(window2.isDestroyed()).toBe(true)
      expect(renderer.activeWindowsCount).toBe(0)
      expect(renderer.waitingQueueSize).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up and destroys window on in-flight runtime failure and unblocks subsequent queue', async () => {
    const renderer = new ElectronDynamicWebsiteRenderer()

    // 任务 1：DOM 读取抛错失败
    const task1 = renderer.render('https://example.com/js-error')
    expect(mockCreatedWindows.length).toBe(1)
    const window1 = mockCreatedWindows[0]!

    await expect(task1).rejects.toThrow('动态页面 DOM 读取失败')
    expect(window1.isDestroyed()).toBe(true)

    // 任务 2：后续正常任务不受影响
    const task2 = await renderer.render('https://example.com/success-after-failure')
    expect(task2.html).toContain('Rendered')
    expect(mockCreatedWindows.length).toBe(2)
    expect(mockCreatedWindows[1]?.isDestroyed()).toBe(true)
    expect(renderer.activeWindowsCount).toBe(0)
    expect(renderer.waitingQueueSize).toBe(0)
  })
})
