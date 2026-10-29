import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import type { ThemePreference } from '../shared/settings'

// The Windows controls share the existing Reader toolbar; no extra title row is added.
export const WINDOW_CONTROLS_OVERLAY_HEIGHT = 56

interface ChromeWindow {
  isDestroyed(): boolean
  setTitleBarOverlay(options: Parameters<BrowserWindow['setTitleBarOverlay']>[0]): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}
interface ThemeSource {
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}
type ChromeOptions = Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'>

export interface MainWindowChrome {
  refresh(): void
  dispose(): void
}

export function mainWindowChromeOptions(
  platform: NodeJS.Platform,
  theme: ThemePreference,
  systemDark: boolean
): ChromeOptions {
  // Other platforms retain their existing native decorations until their layouts are verified.
  if (platform !== 'win32') return {}
  return { titleBarStyle: 'hidden', titleBarOverlay: overlayForTheme(theme, systemDark) }
}

export function bindMainWindowChrome(
  window: ChromeWindow,
  themeSource: ThemeSource,
  readTheme: () => ThemePreference,
  platform: NodeJS.Platform
): MainWindowChrome {
  if (platform !== 'win32') return { refresh: () => undefined, dispose: () => undefined }

  let disposed = false
  const refresh = (): void => {
    if (disposed || window.isDestroyed()) return
    // Read the persisted preference on every update, including configuration restores.
    // Do not change nativeTheme.themeSource: remote original pages keep their OS preference.
    window.setTitleBarOverlay(overlayForTheme(readTheme(), themeSource.shouldUseDarkColors))
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    themeSource.removeListener('updated', refresh)
    window.removeListener('closed', dispose)
  }
  themeSource.on('updated', refresh)
  window.once('closed', dispose)
  return { refresh, dispose }
}

function overlayForTheme(theme: ThemePreference, systemDark: boolean): Parameters<BrowserWindow['setTitleBarOverlay']>[0] {
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  return {
    height: WINDOW_CONTROLS_OVERLAY_HEIGHT,
    // A muted surface distinguishes the native window controls from app actions.
    color: dark ? '#262830' : '#f8f8fa',
    symbolColor: dark ? '#eceef4' : '#202126'
  }
}
