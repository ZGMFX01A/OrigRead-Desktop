import { describe, expect, it } from 'vitest'
import { isAllowedRendererUrl, isTrustedIpcSender, resolveRuntimeOverrides } from './renderer-trust'

describe('isAllowedRendererUrl', () => {
  it('trusts only the configured development origin, not prefix/userinfo tricks', () => {
    const policy = { developmentUrl: 'http://localhost:5173/', productionUrl: 'file:///app/renderer/index.html' }
    expect(isAllowedRendererUrl('http://localhost:5173/', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173/settings', policy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173.evil.example/', policy)).toBe(false)
    expect(isAllowedRendererUrl('http://localhost:5173@evil.example/', policy)).toBe(false)
    expect(isAllowedRendererUrl('http://localhost:5174/', policy)).toBe(false)
  })

  it('trusts only the exact packaged renderer file in production', () => {
    const policy = { developmentUrl: null, productionUrl: 'file:///app/renderer/index.html' }
    expect(isAllowedRendererUrl('file:///app/renderer/index.html', policy)).toBe(true)
    expect(isAllowedRendererUrl('file:///app/renderer/index.html?x=1#reader', policy)).toBe(true)
    expect(isAllowedRendererUrl('file:///app/renderer/other.html', policy)).toBe(false)
    expect(isAllowedRendererUrl('file:///tmp/index.html', policy)).toBe(false)
    expect(isAllowedRendererUrl('https://example.com/', policy)).toBe(false)
  })
})


describe('runtime and frame boundaries', () => {
  const defaults = { isDevelopment: false, rendererUrl: null, e2eUserDataDir: null, e2eDownloadDir: null, updateApiBase: 'https://api.github.com', disableAutoUpdateCheck: false, disablePeriodicSync: false }
  const env = { ELECTRON_RENDERER_URL: 'http://localhost:5173', ORIGREAD_E2E_USER_DATA_DIR: ' data ', ORIGREAD_E2E_DOWNLOAD_DIR: ' downloads ', ORIGREAD_UPDATE_API_BASE: 'http://localhost:8080', ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1', ORIGREAD_DISABLE_PERIODIC_SYNC: '1' }
  it('ignores all overrides in packaged builds', () => {
    expect(resolveRuntimeOverrides(true, env)).toEqual(defaults)
    expect(resolveRuntimeOverrides(false, env)).toEqual({ ...defaults, isDevelopment: true, rendererUrl: env.ELECTRON_RENDERER_URL, e2eUserDataDir: 'data', e2eDownloadDir: 'downloads', updateApiBase: env.ORIGREAD_UPDATE_API_BASE, disableAutoUpdateCheck: true, disablePeriodicSync: true })
    for (const value of ['file:///tmp/ui', 'javascript:alert(1)', 'invalid']) {
      expect(resolveRuntimeOverrides(false, { ELECTRON_RENDERER_URL: value, ORIGREAD_UPDATE_API_BASE: value })).toEqual(defaults)
    }
  })
  it('compares Windows files without case sensitivity and rejects traversal before URL normalization', () => {
    const policy = { productionUrl: 'file:///C:/App/index.html' }
    expect(isAllowedRendererUrl('file:///c:/app/index.html', policy, 'win32')).toBe(true)
    for (const platform of ['linux', 'darwin'] as const) expect(isAllowedRendererUrl('file:///c:/app/index.html', policy, platform)).toBe(false)
    for (const value of ['file:///C:/App/../App/index.html', 'file:///C:/App/%2e/index.html', 'file:///C:/App/%2findex.html']) expect(isAllowedRendererUrl(value, policy, 'win32')).toBe(false)
  })
  it('binds IPC to the live main window and its exact main frame', () => {
    const mainFrame = { url: 'file:///app/index.html' }
    const wc = { isDestroyed: () => false, mainFrame }
    const policy = { productionUrl: mainFrame.url }
    expect(isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, wc, policy)).toBe(true)
    expect(isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, wc, policy)).toBe(false)
    expect(isTrustedIpcSender({ sender: wc, senderFrame: { ...mainFrame } }, wc, policy)).toBe(false)
    expect(isTrustedIpcSender({ sender: wc }, wc, policy)).toBe(false)
    expect(isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, null, policy)).toBe(false)
    wc.isDestroyed = () => true
    expect(isTrustedIpcSender({ sender: wc, senderFrame: mainFrame }, wc, policy)).toBe(false)
  })
})
