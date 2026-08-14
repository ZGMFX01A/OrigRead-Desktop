import { shell, WebContentsView, type BrowserWindow } from 'electron'
import type {
  OriginalArticleViewState,
  OriginalNavigationAction,
  OriginalViewBounds
} from '../../shared/original-view'

const ORIGINAL_PARTITION = 'persist:origread-original'

/**
 * 将远程原文作为原生 WebContentsView 叠加到 Reader 正文区域。
 * Renderer 只负责提供几何位置和控制动作，远程页面永远拿不到 OrigRead preload。
 */
export class OriginalArticleViewController {
  private view: WebContentsView | null = null
  private remoteCleanup: (() => void) | null = null
  private state: OriginalArticleViewState = closedState()

  constructor(
    private readonly window: BrowserWindow,
    private readonly onStateChanged: (state: OriginalArticleViewState) => void = () => undefined
  ) {}

  open(urlValue: string, bounds: OriginalViewBounds): OriginalArticleViewState {
    const url = validateHttpUrl(urlValue)
    this.close()

    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: false,
        partition: ORIGINAL_PARTITION
      }
    })
    this.view = view
    this.configureRemoteView(view)
    this.window.contentView.addChildView(view)
    view.setBounds(this.normalizeBounds(bounds))
    this.patchState({
      open: true,
      url,
      title: null,
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
    void view.webContents.loadURL(url).catch(() => {
      if (this.view === view) this.patchFromView(false)
    })
    return this.currentState()
  }

  updateBounds(bounds: OriginalViewBounds): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.setBounds(this.normalizeBounds(bounds))
  }

  navigate(action: OriginalNavigationAction): OriginalArticleViewState {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return this.currentState()
    const history = view.webContents.navigationHistory
    switch (action) {
      case 'back':
        if (history.canGoBack()) history.goBack()
        break
      case 'forward':
        if (history.canGoForward()) history.goForward()
        break
      case 'reload':
        view.webContents.reload()
        break
    }
    this.patchFromView(view.webContents.isLoading())
    return this.currentState()
  }

  currentState(): OriginalArticleViewState {
    return { ...this.state }
  }

  close(): void {
    const view = this.view
    this.view = null
    this.remoteCleanup?.()
    this.remoteCleanup = null
    if (view) {
      this.window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    this.state = closedState()
    this.onStateChanged(this.currentState())
  }

  dispose(): void {
    this.close()
  }

  private configureRemoteView(view: WebContentsView): void {
    const contents = view.webContents
    contents.setAudioMuted(true)
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void contents.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!isHttpUrl(url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => this.patchFromView(true))
    contents.on('did-stop-loading', () => this.patchFromView(false))
    contents.on('did-navigate', () => this.patchFromView(contents.isLoading()))
    contents.on('did-navigate-in-page', () => this.patchFromView(contents.isLoading()))
    contents.on('page-title-updated', () => this.patchFromView(contents.isLoading()))
    contents.on('render-process-gone', () => this.close())
    contents.on('destroyed', () => {
      if (this.view !== view) return
      this.view = null
      this.remoteCleanup?.()
      this.remoteCleanup = null
      this.state = closedState()
      this.onStateChanged(this.currentState())
    })
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    contents.on('before-input-event', (_event, input) => {
      // 禁止远程页面用常见快捷键打开 DevTools；OrigRead 自身不向该 WebContents 暴露 DevTools。
      if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i') {
        _event.preventDefault()
      }
    })
    const downloadHandler = (event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents): void => {
      if (webContents === contents) {
        event.preventDefault()
        const url = item.getURL()
        if (isHttpUrl(url)) void shell.openExternal(url).catch(() => undefined)
      }
    }
    contents.session.on('will-download', downloadHandler)
    this.remoteCleanup = () => contents.session.removeListener('will-download', downloadHandler)
  }

  private patchFromView(loading: boolean): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return
    const contents = view.webContents
    this.patchState({
      open: true,
      url: contents.getURL() || this.state.url,
      title: contents.getTitle() || null,
      loading,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward()
    })
  }

  private patchState(patch: Partial<OriginalArticleViewState>): void {
    this.state = { ...this.state, ...patch }
    this.onStateChanged(this.currentState())
  }

  private normalizeBounds(bounds: OriginalViewBounds): OriginalViewBounds {
    const contentSize = this.window.getContentSize()
    const windowWidth = contentSize[0] ?? 1
    const windowHeight = contentSize[1] ?? 1
    const x = clampInteger(bounds.x, 0, Math.max(0, windowWidth - 1))
    const y = clampInteger(bounds.y, 0, Math.max(0, windowHeight - 1))
    const width = clampInteger(bounds.width, 1, Math.max(1, windowWidth - x))
    const height = clampInteger(bounds.height, 1, Math.max(1, windowHeight - y))
    return { x, y, width, height }
  }
}

export function validateOriginalViewBounds(value: unknown): OriginalViewBounds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Original view bounds must be an object')
  }
  const input = value as Record<string, unknown>
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
      throw new TypeError(`Original view bounds ${key} must be a finite number`)
    }
  }
  return {
    x: Math.round(input.x as number),
    y: Math.round(input.y as number),
    width: Math.round(input.width as number),
    height: Math.round(input.height as number)
  }
}

function validateHttpUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Original article only supports HTTP(S)')
  return url.toString()
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function clampInteger(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.round(value) : min
  return Math.min(Math.max(normalized, min), max)
}

function closedState(): OriginalArticleViewState {
  return {
    open: false,
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false
  }
}

