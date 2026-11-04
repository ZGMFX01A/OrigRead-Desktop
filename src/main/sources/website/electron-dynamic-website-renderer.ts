import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  isAllowedDynamicNavigation,
  requiresInteractiveVerification,
  type DynamicWebsiteRenderer,
  type DynamicWebsiteRenderResult
} from './dynamic-website-render-policy'
import { DESKTOP_BROWSER_USER_AGENT } from '../../network/user-agent-policy'

const DOM_SETTLE_DELAY_MS = 1_200
const RENDER_TIMEOUT_MS = 15_000
const MAX_MAIN_FRAME_NAVIGATIONS = 8
const MAX_RENDERED_HTML_CHARS = 750_000
const VIEWPORT_WIDTH = 1080
const VIEWPORT_HEIGHT = 1920

/** 全局最多允许 1 个活动的隐藏渲染窗口 */
export const MAX_ACTIVE_DYNAMIC_WINDOWS = 1
/** 动态渲染等待队列最大容量，超出直接熔断报错，避免无限积压 Chromium 实例 */
export const MAX_DYNAMIC_RENDER_QUEUE_SIZE = 8

export class DynamicWebsiteRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DynamicWebsiteRenderError'
  }
}

interface QueuedRenderTask {
  url: string
  signal?: AbortSignal
  resolve: (value: DynamicWebsiteRenderResult) => void
  reject: (reason?: unknown) => void
  detachSignalListener?: () => void
}

/**
 * Electron 平台适配：隐藏 Chromium 只负责执行页面自身 JS 并返回最终 DOM。
 * 全局统一限制最多 1 个活动窗口，通过排队与取消机制严格约束隐藏实例与内存开销。
 */
export class ElectronDynamicWebsiteRenderer implements DynamicWebsiteRenderer {
  private activeCount = 0
  private readonly queue: QueuedRenderTask[] = []

  get activeWindowsCount(): number {
    return this.activeCount
  }

  get waitingQueueSize(): number {
    return this.queue.length
  }

  async render(url: string, signal?: AbortSignal): Promise<DynamicWebsiteRenderResult> {
    validateInitialUrl(url)
    if (signal?.aborted) throw new DynamicWebsiteRenderError('动态页面渲染已取消')
    if (this.queue.length >= MAX_DYNAMIC_RENDER_QUEUE_SIZE) {
      throw new DynamicWebsiteRenderError(`动态页面渲染队列已满（最多等待 ${MAX_DYNAMIC_RENDER_QUEUE_SIZE} 个任务），请稍后重试`)
    }

    return new Promise<DynamicWebsiteRenderResult>((resolve, reject) => {
      let task: QueuedRenderTask

      const onAbort = (): void => {
        const index = this.queue.indexOf(task)
        if (index !== -1) {
          this.queue.splice(index, 1)
          task.detachSignalListener?.()
          reject(new DynamicWebsiteRenderError('动态页面渲染已取消'))
        }
      }

      task = {
        url,
        signal,
        resolve,
        reject,
        detachSignalListener: () => {
          if (signal) signal.removeEventListener('abort', onAbort)
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      this.queue.push(task)
      this.processNext()
    })
  }

  private processNext(): void {
    if (this.activeCount >= MAX_ACTIVE_DYNAMIC_WINDOWS || this.queue.length === 0) {
      return
    }

    const task = this.queue.shift()!
    task.detachSignalListener?.()

    if (task.signal?.aborted) {
      task.reject(new DynamicWebsiteRenderError('动态页面渲染已取消'))
      this.processNext()
      return
    }

    this.activeCount += 1
    this.executeRender(task.url, task.signal)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.activeCount -= 1
        this.processNext()
      })
  }

  private async executeRender(url: string, signal?: AbortSignal): Promise<DynamicWebsiteRenderResult> {
    if (signal?.aborted) throw new DynamicWebsiteRenderError('动态页面渲染已取消')
    return new Promise<DynamicWebsiteRenderResult>((resolve, reject) => {
      let completed = false
      let settleTimer: NodeJS.Timeout | null = null
      let navigationCount = 0
      let abortHandler: (() => void) | null = null

      const window = new BrowserWindow({
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          devTools: false,
          partition: `origread-dynamic-website-${randomUUID()}`
        }
      })
      window.webContents.setAudioMuted(true)
      window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const cleanup = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
        if (abortHandler && signal) signal.removeEventListener('abort', abortHandler)
        abortHandler = null
        if (!window.isDestroyed()) window.destroy()
      }
      const fail = (message: string): void => {
        if (completed) return
        completed = true
        clearTimeout(timeoutTimer)
        cleanup()
        reject(new DynamicWebsiteRenderError(message))
      }
      const finish = async (finalUrl: string): Promise<void> => {
        if (completed) return
        try {
          const html = await window.webContents.executeJavaScript(CAPTURE_DOM_SCRIPT, true) as unknown
          if (completed) return
          if (typeof html !== 'string' || !html.trim()) {
            fail('动态页面未返回有效 DOM')
            return
          }
          completed = true
          clearTimeout(timeoutTimer)
          cleanup()
          resolve({ finalUrl, html })
        } catch {
          fail('动态页面 DOM 读取失败')
        }
      }
      const validateNavigation = (targetUrl: string): boolean => {
        if (requiresInteractiveVerification(targetUrl)) {
          fail('动态页面需要用户完成安全验证')
          return false
        }
        if (!isAllowedDynamicNavigation(url, targetUrl)) {
          fail('动态页面跳转到了其他站点')
          return false
        }
        return true
      }

      const timeoutTimer = setTimeout(() => fail('动态页面渲染超时'), RENDER_TIMEOUT_MS)
      if (signal) {
        abortHandler = () => fail('动态页面渲染已取消')
        signal.addEventListener('abort', abortHandler, { once: true })
        if (signal.aborted) abortHandler()
      }

      window.webContents.on('will-navigate', (event, targetUrl) => {
        if (!validateNavigation(targetUrl)) event.preventDefault()
      })
      window.webContents.on('will-redirect', (event, targetUrl) => {
        if (!validateNavigation(targetUrl)) event.preventDefault()
      })
      window.webContents.on('did-start-navigation', (_event, targetUrl, _isInPlace, isMainFrame) => {
        if (!isMainFrame || completed) return
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
        if (!validateNavigation(targetUrl)) return
        navigationCount += 1
        if (navigationCount > MAX_MAIN_FRAME_NAVIGATIONS) fail('动态页面重定向次数过多')
      })
      window.webContents.on('did-navigate', (_event, targetUrl, httpResponseCode) => {
        if (completed) return
        if (!validateNavigation(targetUrl)) return
        if (httpResponseCode >= 400) fail(`动态页面请求失败：HTTP ${httpResponseCode}`)
      })
      window.webContents.on('did-fail-load', (_event, _errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame) fail(`动态页面加载失败：${errorDescription || '未知错误'}`)
      })
      window.webContents.on('render-process-gone', () => fail('动态页面渲染进程异常退出'))
      window.webContents.on('did-finish-load', () => {
        if (completed) return
        const finalUrl = window.webContents.getURL() || url
        if (!validateNavigation(finalUrl)) return
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => void finish(finalUrl), DOM_SETTLE_DELAY_MS)
      })

      void window.loadURL(url, { userAgent: DESKTOP_BROWSER_USER_AGENT }).catch((error) => {
        if (!completed) fail(`动态页面加载失败：${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }
}

function validateInitialUrl(value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
  } catch {
    throw new DynamicWebsiteRenderError('动态页面只允许 HTTP(S) 地址')
  }
}

const CAPTURE_DOM_SCRIPT = `
(() => {
  const wechatContent = document.querySelector('#js_content');
  if (wechatContent) return '<html><body>' + wechatContent.outerHTML + '</body></html>';
  const root = document.documentElement;
  if (!root) return '';
  const html = root.outerHTML || '';
  return html.length > ${MAX_RENDERED_HTML_CHARS} ? html.substring(0, ${MAX_RENDERED_HTML_CHARS}) : html;
})()
`
