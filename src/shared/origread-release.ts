export const ORIGREAD_DESKTOP_RELEASE_FEED_URL = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases.atom'
export const ORIGREAD_DESKTOP_RELEASES_URL = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases'
export const ORIGREAD_DESKTOP_RELEASE_FEED_NAME = 'OrigRead Desktop Releases'
export const ORIGREAD_DESKTOP_RELEASE_FEED_ICON = 'https://github.com/ZGMFX01A.png'

const RELEASE_TAG_PATH_PREFIX = '/ZGMFX01A/OrigRead-Desktop/releases/tag/'
const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?(?:\+[0-9A-Za-z._-]+)?$/

export interface OrigReadDesktopReleaseLinks {
  tagName: string
  version: string
  releasePageUrl: string
  assetName: string | null
  downloadUrl: string | null
}

export function toOrigReadDesktopReleaseLinks(
  articleUrl: string | null | undefined,
  platform: string | null | undefined,
  arch: string | null | undefined
): OrigReadDesktopReleaseLinks | null {
  const parsed = parseReleasePage(articleUrl)
  if (!parsed) return null
  const assetName = platformAssetName(parsed.version, platform, arch)
  return {
    ...parsed,
    assetName,
    downloadUrl: assetName
      ? `${ORIGREAD_DESKTOP_RELEASES_URL}/download/${encodeURIComponent(parsed.tagName)}/${assetName}`
      : null
  }
}

export function isOrigReadDesktopReleaseFeed(url: string | null | undefined): boolean {
  return url?.trim() === ORIGREAD_DESKTOP_RELEASE_FEED_URL
}

function parseReleasePage(articleUrl: string | null | undefined): Omit<OrigReadDesktopReleaseLinks, 'assetName' | 'downloadUrl'> | null {
  if (!articleUrl) return null
  try {
    const url = new URL(articleUrl)
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(RELEASE_TAG_PATH_PREFIX)) return null
    const rawTag = url.pathname.slice(RELEASE_TAG_PATH_PREFIX.length)
    if (!rawTag || rawTag.includes('/')) return null
    const tagName = decodeURIComponent(rawTag).trim()
    if (!RELEASE_TAG_PATTERN.test(tagName)) return null
    const version = tagName.replace(/^v/i, '').split('+')[0] ?? tagName.replace(/^v/i, '')
    return {
      tagName,
      version,
      releasePageUrl: `${ORIGREAD_DESKTOP_RELEASES_URL}/tag/${encodeURIComponent(tagName)}`
    }
  } catch {
    return null
  }
}

function platformAssetName(version: string, platform: string | null | undefined, arch: string | null | undefined): string | null {
  const normalizedPlatform = platform?.trim().toLowerCase()
  const normalizedArch = arch?.trim().toLowerCase()
  if (normalizedPlatform === 'win32' && normalizedArch === 'x64') return `OrigRead-${version}-x64.exe`
  if (normalizedPlatform === 'darwin' && normalizedArch === 'arm64') return `OrigRead-${version}-arm64.dmg`
  if (normalizedPlatform === 'linux' && normalizedArch === 'x64') return `OrigRead-${version}-x64.AppImage`
  return null
}
