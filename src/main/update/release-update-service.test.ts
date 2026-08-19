import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFallbackReleaseAsset,
  compareVersions,
  localizedReleaseNotes,
  releaseTagFromPageUrl,
  releaseDownloadCandidates,
  ReleaseUpdateService,
  resolveLatestReleasePageUrl,
  selectReleaseAsset,
  shouldPreferMainlandReleaseMirror
} from './release-update-service'

describe('release update service', () => {
  it('compares stable and prerelease versions', () => {
    expect(compareVersions('v1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0-beta.2', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.2.0-beta.9')).toBe(1)
  })

  it('uses invisible language markers and keeps old heading compatibility', () => {
    const hidden = '<!-- lang:zh -->\n- 中文日志\n\n<!-- lang:en -->\n- English notes'
    expect(localizedReleaseNotes(hidden, 'zh')).toBe('- 中文日志')
    expect(localizedReleaseNotes(hidden, 'en')).toBe('- English notes')
    const legacy = '## 中文\n旧中文\n\n## English\nOld English'
    expect(localizedReleaseNotes(legacy, 'en')).toBe('Old English')
  })

  it('selects current platform installer asset', () => {
    const base = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/'
    const assets = [
      { id: 1, name: 'OrigRead-1.0.0-x64.exe', size: 10, browser_download_url: `${base}OrigRead-1.0.0-x64.exe` },
      { id: 2, name: 'OrigRead-1.0.0-arm64.dmg', size: 11, browser_download_url: `${base}OrigRead-1.0.0-arm64.dmg` },
      { id: 3, name: 'OrigRead-1.0.0-x64.AppImage', size: 12, browser_download_url: `${base}OrigRead-1.0.0-x64.AppImage` },
      { id: 4, name: 'OrigRead-1.0.0-x64.deb', size: 13, browser_download_url: `${base}OrigRead-1.0.0-x64.deb` }
    ]
    expect(selectReleaseAsset(assets, 'win32', 'x64')?.id).toBe(1)
    expect(selectReleaseAsset(assets, 'darwin', 'arm64')?.id).toBe(2)
    expect(selectReleaseAsset(assets, 'linux', 'x64')?.id).toBe(3)
  })

  it('keeps old platform-labelled release assets compatible', () => {
    const base = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v0.1.0/'
    const assets = [
      { id: 11, name: 'OrigRead-0.1.0-Windows-x64.exe', size: 10, browser_download_url: `${base}OrigRead-0.1.0-Windows-x64.exe` },
      { id: 12, name: 'OrigRead-0.1.0-macOS-arm64.dmg', size: 11, browser_download_url: `${base}OrigRead-0.1.0-macOS-arm64.dmg` }
    ]
    expect(selectReleaseAsset(assets, 'win32', 'x64')?.id).toBe(11)
    expect(selectReleaseAsset(assets, 'darwin', 'arm64')?.id).toBe(12)
  })

  it('only prepends mainland proxy for trusted release assets', () => {
    const url = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/OrigRead.exe'
    expect(releaseDownloadCandidates(url, 'zh-CN')).toEqual([`https://gh-proxy.com/${url}`, url])
    expect(releaseDownloadCandidates(url, 'en-CN')).toEqual([`https://gh-proxy.com/${url}`, url])
    expect(releaseDownloadCandidates(url, 'zh-Hans-CN')).toEqual([`https://gh-proxy.com/${url}`, url])
    expect(releaseDownloadCandidates(url, 'en-US')).toEqual([url])
    expect(releaseDownloadCandidates('https://api.github.com/repos/x/y', 'zh-CN')).toEqual(['https://api.github.com/repos/x/y'])
    expect(shouldPreferMainlandReleaseMirror('zh_CN')).toBe(true)
    expect(shouldPreferMainlandReleaseMirror('zh-SG')).toBe(false)
  })

  it('falls back to official GitHub asset when mainland proxy download fails', async () => {
    const official = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/OrigRead-1.0.0-x64.exe'
    const calls: string[] = []
    const service = new ReleaseUpdateService(async (input) => {
      calls.push(input)
      if (input.startsWith('https://gh-proxy.com/')) return new Response('proxy failed', { status: 502 })
      return new Response('installer-bytes', { status: 200 })
    })
    const dir = mkdtempSync(join(tmpdir(), 'origread-update-'))
    const destination = join(dir, 'OrigRead.exe')
    try {
      await service.downloadAsset({ id: 1, name: 'OrigRead.exe', size: 15, downloadUrl: official }, destination, 'zh-CN')
      expect(calls).toEqual([`https://gh-proxy.com/${official}`, official])
      expect(readFileSync(destination, 'utf8')).toBe('installer-bytes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies private repository 404 separately from latest-version state', async () => {
    const service = new ReleaseUpdateService(async () => new Response('{}', { status: 404 }))
    const result = await service.check('0.1.0', 'win32', 'x64', 'zh')
    expect(result.status).toBe('unavailable')
    expect(result.errorCode).toBe('REPOSITORY_UNAVAILABLE')
  })

  it('falls back to public releases/latest when anonymous GitHub API is rate limited', async () => {
    const calls: string[] = []
    const service = new ReleaseUpdateService(async (input, init) => {
      calls.push(input)
      if (input.startsWith('https://api.github.com/')) {
        return new Response('{}', { status: 429 })
      }
      expect(init?.redirect).toBe('manual')
      return new Response('', {
        status: 302,
        headers: { location: '/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.2.3' }
      })
    })
    const result = await service.check('0.1.0', 'win32', 'x64', 'zh')
    expect(result.status).toBe('available')
    expect(result.errorCode).toBeNull()
    expect(result.release?.version).toBe('1.2.3')
    expect(result.release?.asset?.name).toBe('OrigRead-1.2.3-x64.exe')
    expect(result.release?.asset?.downloadUrl).toBe(
      'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.2.3/OrigRead-1.2.3-x64.exe'
    )
    expect(calls).toEqual([
      'https://api.github.com/repos/ZGMFX01A/OrigRead-Desktop/releases/latest',
      'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/latest'
    ])
  })

  it('uses public releases/latest fallback after GitHub API network failure', async () => {
    let call = 0
    const service = new ReleaseUpdateService(async () => {
      call += 1
      if (call === 1) throw new Error('api blocked')
      return new Response('', {
        status: 302,
        headers: { location: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v0.1.0' }
      })
    })
    const result = await service.check('0.1.0', 'win32', 'x64', 'zh')
    expect(result.status).toBe('latest')
    expect(result.errorCode).toBeNull()
    expect(result.release?.version).toBe('0.1.0')
  })

  it('parses only trusted latest-release redirects and builds deterministic fallback assets', () => {
    const response = new Response('', {
      status: 302,
      headers: { location: '/ZGMFX01A/OrigRead-Desktop/releases/tag/v2.0.0' }
    })
    expect(resolveLatestReleasePageUrl(response)).toBe(
      'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v2.0.0'
    )
    expect(releaseTagFromPageUrl('https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v2.0.0')).toBe('v2.0.0')
    expect(releaseTagFromPageUrl('https://example.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v2.0.0')).toBeNull()
    expect(buildFallbackReleaseAsset('v2.0.0', 'darwin', 'arm64')?.name).toBe('OrigRead-2.0.0-arm64.dmg')
    expect(buildFallbackReleaseAsset('v2.0.0', 'linux', 'x64')?.name).toBe('OrigRead-2.0.0-x64.AppImage')
  })

  it('parses release, localizes notes, selects asset and reports update', async () => {
    const service = new ReleaseUpdateService(async () => new Response(JSON.stringify({
      tag_name: 'v1.0.0',
      name: 'OrigRead Desktop 1.0.0',
      body: '<!-- lang:zh -->\n- 新版本\n\n<!-- lang:en -->\n- New release',
      published_at: '2026-08-17T01:02:03Z',
      html_url: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.0.0',
      assets: [{
        id: 8,
        name: 'OrigRead-1.0.0-x64.exe',
        size: 123,
        browser_download_url: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/OrigRead-1.0.0-x64.exe'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await service.check('0.1.0', 'win32', 'x64', 'zh')
    expect(result.status).toBe('available')
    expect(result.release?.version).toBe('1.0.0')
    expect(result.release?.publishedDate).toBe('2026-08-17')
    expect(result.release?.notes).toBe('- 新版本')
    expect(result.release?.asset?.id).toBe(8)
  })
})

