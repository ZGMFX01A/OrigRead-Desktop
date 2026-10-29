import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ThemePreference } from '../shared/settings'
import { bindMainWindowChrome, mainWindowChromeOptions } from './window-chrome'

function fixture(preference: ThemePreference = 'system', platform: NodeJS.Platform = 'win32') {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    setTitleBarOverlay: vi.fn()
  })
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  let currentPreference = preference
  const chrome = bindMainWindowChrome(window, theme, () => currentPreference, platform)
  return { window, theme, chrome, setPreference: (next: ThemePreference) => { currentPreference = next } }
}

describe('main window chrome', () => {
  it('keeps native window controls on Windows and leaves other platforms unchanged', () => {
    expect(mainWindowChromeOptions('win32', 'system', true)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 56, color: '#262830', symbolColor: '#eceef4' }
    })
    for (const platform of ['darwin', 'linux'] as const) {
      expect(mainWindowChromeOptions(platform, 'dark', true)).toEqual({})
      const { window, theme, chrome } = fixture('dark', platform)
      chrome.refresh()
      theme.emit('updated')
      expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
      expect(theme.listenerCount('updated')).toBe(0)
      chrome.dispose()
    }
  })

  it('updates native controls when the operating system theme changes', () => {
    const { window, theme, chrome } = fixture()
    theme.emit('updated')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#f8f8fa', symbolColor: '#202126' })
    theme.shouldUseDarkColors = true
    theme.emit('updated')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#262830', symbolColor: '#eceef4' })
    chrome.dispose()
  })

  it('honors explicit preferences and rereads restored settings without changing the system theme', () => {
    const { window, theme, chrome, setPreference } = fixture('dark')
    chrome.refresh()
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#262830', symbolColor: '#eceef4' })
    expect(theme.shouldUseDarkColors).toBe(false)

    theme.shouldUseDarkColors = true
    setPreference('light')
    chrome.refresh()
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#f8f8fa', symbolColor: '#202126' })
    theme.emit('updated')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#f8f8fa', symbolColor: '#202126' })

    setPreference('system')
    chrome.refresh()
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ height: 56, color: '#262830', symbolColor: '#eceef4' })
    chrome.dispose()
  })

  it('does not update destroyed windows and removes the theme listener on close', () => {
    const { window, theme, chrome } = fixture()
    expect(theme.listenerCount('updated')).toBe(1)
    window.isDestroyed.mockReturnValue(true)
    theme.emit('updated')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    window.emit('closed')
    expect(theme.listenerCount('updated')).toBe(0)
    expect(window.listenerCount('closed')).toBe(0)
    window.isDestroyed.mockReturnValue(false)
    theme.emit('updated')
    chrome.refresh()
    chrome.dispose()
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
  })
})
