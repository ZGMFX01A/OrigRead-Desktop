import { describe, expect, it } from 'vitest'
import {
  ORIGREAD_DESKTOP_RELEASE_FEED_URL,
  isOrigReadDesktopReleaseFeed,
  toOrigReadDesktopReleaseLinks
} from './origread-release'

describe('OrigRead Desktop release links', () => {
  it('maps a release article to the installer for the current platform', () => {
    const article = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.2.3'
    expect(toOrigReadDesktopReleaseLinks(article, 'win32', 'x64')).toMatchObject({
      tagName: 'v1.2.3',
      version: '1.2.3',
      assetName: 'OrigRead-1.2.3-x64.exe',
      downloadUrl: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.2.3/OrigRead-1.2.3-x64.exe'
    })
    expect(toOrigReadDesktopReleaseLinks(article, 'darwin', 'arm64')?.assetName).toBe('OrigRead-1.2.3-arm64.dmg')
    expect(toOrigReadDesktopReleaseLinks(article, 'linux', 'x64')?.assetName).toBe('OrigRead-1.2.3-x64.AppImage')
  })

  it('keeps the Release page available when the current architecture has no published installer', () => {
    expect(toOrigReadDesktopReleaseLinks(
      'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.0.0',
      'darwin',
      'x64'
    )).toMatchObject({
      releasePageUrl: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.0.0',
      assetName: null,
      downloadUrl: null
    })
  })

  it('rejects foreign repositories and non-release pages', () => {
    expect(toOrigReadDesktopReleaseLinks('https://github.com/ZGMFX01A/OrigRead/releases/tag/v1.0.0', 'win32', 'x64')).toBeNull()
    expect(toOrigReadDesktopReleaseLinks('https://example.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.0.0', 'win32', 'x64')).toBeNull()
    expect(toOrigReadDesktopReleaseLinks('https://github.com/ZGMFX01A/OrigRead-Desktop/releases', 'win32', 'x64')).toBeNull()
  })

  it('recognizes only the built-in Desktop Release feed URL', () => {
    expect(isOrigReadDesktopReleaseFeed(ORIGREAD_DESKTOP_RELEASE_FEED_URL)).toBe(true)
    expect(isOrigReadDesktopReleaseFeed('https://github.com/ZGMFX01A/OrigRead/releases.atom')).toBe(false)
  })
})
