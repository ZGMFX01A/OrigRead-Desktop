import { describe, expect, it } from 'vitest'
import { desktopBrowserUserAgent } from './user-agent-policy'

describe('Desktop browser User-Agent policy', () => {
  it('uses the bundled Chromium version without Electron/App/Mobile markers', () => {
    const ua = desktopBrowserUserAgent('151.0.7777.88', 'win32')
    expect(ua).toContain('Windows NT 10.0; Win64; x64')
    expect(ua).toContain('Chrome/151.0.7777.88')
    expect(ua).not.toMatch(/Electron|OrigRead|Mobile|\bwv\b/i)
  })

  it('uses a desktop platform token on macOS and Linux', () => {
    expect(desktopBrowserUserAgent('150.0.0.0', 'darwin')).toContain('Macintosh; Intel Mac OS X')
    expect(desktopBrowserUserAgent('150.0.0.0', 'linux')).toContain('X11; Linux x86_64')
  })
})
