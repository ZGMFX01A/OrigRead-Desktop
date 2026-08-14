import { BrowserWindow } from 'electron'
import {
  isAllowedDynamicNavigation,
  requiresInteractiveVerification,
  type DynamicWebsiteRenderer,
  type DynamicWebsiteRenderResult
} from './dynamic-website-render-policy'

const DOM_SETTLE_DELAY_MS = 1_200
const RENDER_TIMEOUT_MS = 15_000
const MAX_MAIN_FRAME_NAVIGATIONS = 8
const MAX_RENDERED_HTML_CHARS = 750_000
const VIEWPORT_WIDTH = 1080
const VIEWPORT_HEIGHT = 1920

export class DynamicWebsiteRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DynamicWebsiteRenderError'
  }
}

/**
 * Electron 平台适配：隐藏 Chromium 只负责执行页面自身 JS 并返回最终 DOM。
 * DOM 返回后仍交给 WebsiteSourceService 的同一 WebsiteRule / 自动 DOM / 健康评分链。
 */
export class ElectronDynamicWebsiteRenderer implements DynamicWebsiteRenderer {
  async render(url: string): Promise<DynamicWebsiteRenderResult> {
    validateInitialUrl(url)
    return new Promise<DynamicWebsiteRenderResult>((resolve, reject) => {
      let completed = false
      let settleTimer: NodeJS.Timeout | null = null
      let navigationCount = 0
      const window = new BrowserWindow({
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          devTools: false
        }
      })
      window.webContents.setAudioMuted(true)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

      const cleanup = (): void => {
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = null
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

      void window.loadURL(url, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      }).catch((error) => {
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

