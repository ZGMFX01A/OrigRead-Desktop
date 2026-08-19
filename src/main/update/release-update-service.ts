import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  DesktopReleaseAsset,
  DesktopReleaseInfo,
  UpdateCheckResult,
  UpdateErrorCode
} from '../../shared/update'

export const ORIGREAD_DESKTOP_REPOSITORY = 'ZGMFX01A/OrigRead-Desktop'
const OFFICIAL_RELEASE_DOWNLOAD_PREFIX = `https://github.com/${ORIGREAD_DESKTOP_REPOSITORY}/releases/download/`
const OFFICIAL_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${ORIGREAD_DESKTOP_REPOSITORY}/releases/latest`
const OFFICIAL_LATEST_RELEASE_URL = `https://github.com/${ORIGREAD_DESKTOP_REPOSITORY}/releases/latest`
const MAINLAND_RELEASE_PROXY = 'https://gh-proxy.com/'

export type UpdateFetch = (input: string, init?: RequestInit) => Promise<Response>

interface GitHubReleaseAssetPayload {
  id?: unknown
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
}

interface GitHubReleasePayload {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  created_at?: unknown
  html_url?: unknown
  assets?: unknown
}

export class ReleaseUpdateService {
  constructor(
    private readonly fetcher: UpdateFetch,
    private readonly apiBase = 'https://api.github.com'
  ) {}

  async check(
    currentVersion: string,
    platform: NodeJS.Platform,
    arch: string,
    language: string,
    locale = language
  ): Promise<UpdateCheckResult> {
    const checkedAt = Date.now()
    const apiUrl = `${this.apiBase.replace(/\/$/, '')}/repos/${ORIGREAD_DESKTOP_REPOSITORY}/releases/latest`
    const candidates = releaseCheckCandidates(apiUrl, locale)
    let lastResponse: Response | null = null
    let lastNetworkError: unknown = null

    for (const [index, candidate] of candidates.entries()) {
      try {
        const response = await this.fetcher(candidate, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `OrigRead-Desktop/${currentVersion}`,
            'X-GitHub-Api-Version': '2022-11-28'
          }
        })
        lastResponse = response

        if (response.status === 401 || response.status === 404) {
          if (index < candidates.length - 1) continue
          return failure(
            currentVersion,
            checkedAt,
            'REPOSITORY_UNAVAILABLE',
            'GitHub Release 当前不可访问；仓库可能仍为私有仓库，或尚未创建公开 Release。'
          )
        }
        if (response.status === 403 || response.status === 429) {
          if (index < candidates.length - 1) continue
          return await this.checkViaPublicLatestRelease(
            currentVersion,
            platform,
            arch,
            checkedAt,
            'RATE_LIMITED',
            'GitHub API 请求受限，请稍后重试。'
          )
        }
        if (!response.ok) {
          if (index < candidates.length - 1) continue
          return failure(currentVersion, checkedAt, 'NETWORK', `GitHub API HTTP ${response.status}`)
        }

        let payload: GitHubReleasePayload
        try {
          payload = await response.json() as GitHubReleasePayload
        } catch (error) {
          if (index < candidates.length - 1) continue
          return failure(currentVersion, checkedAt, 'INVALID_RESPONSE', errorText(error))
        }

        const release = parseRelease(payload, platform, arch, language)
        if (!release) {
          if (index < candidates.length - 1) continue
          return failure(currentVersion, checkedAt, 'INVALID_RESPONSE', 'GitHub Release 返回的数据不完整。')
        }

        return {
          status: compareVersions(release.version, currentVersion) > 0 ? 'available' : 'latest',
          currentVersion,
          checkedAt,
          release,
          errorCode: null,
          errorMessage: null
        }
      } catch (error) {
        lastNetworkError = error
      }
    }

    return await this.checkViaPublicLatestRelease(
      currentVersion,
      platform,
      arch,
      checkedAt,
      'NETWORK',
      errorText(lastNetworkError ?? lastResponse?.status ?? 'Unknown network error')
    )
  }

  private async checkViaPublicLatestRelease(
    currentVersion: string,
    platform: NodeJS.Platform,
    arch: string,
    checkedAt: number,
    fallbackErrorCode: UpdateErrorCode,
    fallbackErrorMessage: string
  ): Promise<UpdateCheckResult> {
    let response: Response
    try {
      response = await this.fetcher(OFFICIAL_LATEST_RELEASE_URL, {
        headers: { 'User-Agent': `OrigRead-Desktop/${currentVersion}` },
        redirect: 'manual'
      })
    } catch {
      return failure(currentVersion, checkedAt, fallbackErrorCode, fallbackErrorMessage)
    }

    if (response.status === 404) {
      return failure(
        currentVersion,
        checkedAt,
        'REPOSITORY_UNAVAILABLE',
        'OrigRead Desktop 仓库已可访问，但当前还没有可用的公开 Release。'
      )
    }

    const releasePageUrl = resolveLatestReleasePageUrl(response)
    if (!releasePageUrl) {
      return failure(currentVersion, checkedAt, fallbackErrorCode, fallbackErrorMessage)
    }

    const tagName = releaseTagFromPageUrl(releasePageUrl)
    if (!tagName) {
      return failure(currentVersion, checkedAt, 'INVALID_RESPONSE', 'GitHub 最新版本链接未返回有效版本号。')
    }
    const version = normalizeVersion(tagName)
    const release: DesktopReleaseInfo = {
      tagName,
      version,
      title: `OrigRead ${tagName}`,
      notes: '',
      publishedDate: '',
      releasePageUrl,
      asset: buildFallbackReleaseAsset(tagName, platform, arch)
    }
    return {
      status: compareVersions(version, currentVersion) > 0 ? 'available' : 'latest',
      currentVersion,
      checkedAt,
      release,
      errorCode: null,
      errorMessage: null
    }
  }

  async downloadAsset(asset: DesktopReleaseAsset, destination: string, locale: string): Promise<void> {
    if (!isTrustedReleaseDownloadUrl(asset.downloadUrl)) throw new Error('拒绝下载非 OrigRead Desktop Release 资产')
    const temporary = `${destination}.part`
    await rm(temporary, { force: true })
    let lastError: unknown = null
    for (const candidate of releaseDownloadCandidates(asset.downloadUrl, locale)) {
      try {
        const response = await this.fetcher(candidate, {
          headers: { 'User-Agent': 'OrigRead-Desktop-Updater' },
          redirect: 'follow'
        })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(temporary)
        )
        await rm(destination, { force: true })
        await rename(temporary, destination)
        return
      } catch (error) {
        lastError = error
        await rm(temporary, { force: true })
      }
    }
    throw new Error(`更新安装包下载失败：${errorText(lastError)}`)
  }
}

function failure(currentVersion: string, checkedAt: number, errorCode: UpdateErrorCode, errorMessage: string): UpdateCheckResult {
  return {
    status: errorCode === 'REPOSITORY_UNAVAILABLE' || errorCode === 'DISABLED' ? 'unavailable' : 'error',
    currentVersion,
    checkedAt,
    release: null,
    errorCode,
    errorMessage
  }
}

export function localizedReleaseNotes(body: string, language: string): string {
  const value = body.trim()
  if (!value) return ''

  const hidden = [...value.matchAll(/^\s*<!--\s*(?:origread:)?lang\s*[:=]\s*([a-zA-Z-]+)\s*-->\s*$/gim)]
  if (hidden.length > 0) {
    const wantChinese = language.trim().toLowerCase().startsWith('zh')
    const selectedIndex = hidden.findIndex((match) => (match[1]?.toLowerCase().startsWith('zh') ?? false) === wantChinese)
    if (selectedIndex >= 0) {
      const selected = hidden[selectedIndex]!
      const next = hidden[selectedIndex + 1]
      const start = (selected.index ?? 0) + selected[0].length
      const end = next?.index ?? value.length
      return stripGeneratedFullChangelog(value.slice(start, end).trim())
    }
  }

  // 兼容此前已经约定过的可见语言标题，后续 Release 推荐只用隐藏注释。
  const headings = [...value.matchAll(/^#{1,6}\s*(中文|简体中文|繁體中文|繁体中文|Chinese|English|英文)\s*$/gim)]
  if (headings.length > 0) {
    const wantChinese = language.trim().toLowerCase().startsWith('zh')
    const selectedIndex = headings.findIndex((match) => {
      const label = match[1]?.toLowerCase() ?? ''
      const chinese = label !== 'english' && label !== '英文'
      return chinese === wantChinese
    })
    if (selectedIndex >= 0) {
      const selected = headings[selectedIndex]!
      const next = headings[selectedIndex + 1]
      const start = (selected.index ?? 0) + selected[0].length
      const end = next?.index ?? value.length
      return stripGeneratedFullChangelog(value.slice(start, end).trim())
    }
  }
  return stripGeneratedFullChangelog(value)
}

export function stripGeneratedFullChangelog(body: string): string {
  const markers = ['**Full Changelog**:', '**Full Changelog**', 'Full Changelog:']
  const indexes = markers.map((marker) => body.toLowerCase().indexOf(marker.toLowerCase())).filter((index) => index >= 0)
  const cut = indexes.length ? Math.min(...indexes) : -1
  return (cut >= 0 ? body.slice(0, cut) : body).trim()
}

export function formatReleaseDate(value: string): string {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? ''
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  if (a.pre.length === 0 && b.pre.length > 0) return 1
  if (a.pre.length > 0 && b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const leftPart = a.pre[index]
    const rightPart = b.pre[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== null && rightNumber === null) return -1
    if (leftNumber === null && rightNumber !== null) return 1
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function selectReleaseAsset(assets: GitHubReleaseAssetPayload[], platform: NodeJS.Platform, arch: string): DesktopReleaseAsset | null {
  const parsed = assets.map(parseAsset).filter((asset): asset is DesktopReleaseAsset => asset !== null)
  const supported = parsed.filter((asset) => {
    const name = asset.name.toLowerCase()
    if (platform === 'win32') return name.endsWith('.exe')
    if (platform === 'darwin') return name.endsWith('.dmg')
    if (platform === 'linux') return name.endsWith('.appimage') || name.endsWith('.deb')
    return false
  })
  if (!supported.length) return null
  return supported.sort((left, right) => assetScore(right, platform, arch) - assetScore(left, platform, arch))[0] ?? null
}

export function releaseDownloadCandidates(url: string, locale: string): string[] {
  if (!isTrustedReleaseDownloadUrl(url)) return [url]
  return shouldPreferMainlandReleaseMirror(locale) ? [`${MAINLAND_RELEASE_PROXY}${url}`, url] : [url]
}

export function releaseCheckCandidates(url: string, locale: string): string[] {
  if (url !== OFFICIAL_LATEST_RELEASE_API_URL) return [url]
  return shouldPreferMainlandReleaseMirror(locale) ? [`${MAINLAND_RELEASE_PROXY}${url}`, url] : [url]
}

export function shouldPreferMainlandReleaseMirror(locale: string): boolean {
  const normalized = locale.trim().replaceAll('_', '-').toLowerCase()
  return /(?:^|-)cn(?:-|$)/.test(normalized)
}

export function isTrustedReleaseDownloadUrl(value: string): boolean {
  return value.startsWith(OFFICIAL_RELEASE_DOWNLOAD_PREFIX)
}

export function resolveLatestReleasePageUrl(response: Response): string | null {
  const location = response.headers.get('location')?.trim() ?? ''
  if (location) {
    try {
      const resolved = new URL(location, OFFICIAL_LATEST_RELEASE_URL).toString()
      return isTrustedReleasePageUrl(resolved) ? resolved : null
    } catch {
      return null
    }
  }
  const responseUrl = response.url.trim()
  return isTrustedReleasePageUrl(responseUrl) ? responseUrl : null
}

export function releaseTagFromPageUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.origin !== 'https://github.com') return null
    const prefix = `/${ORIGREAD_DESKTOP_REPOSITORY}/releases/tag/`
    if (!url.pathname.startsWith(prefix)) return null
    const tag = decodeURIComponent(url.pathname.slice(prefix.length)).trim()
    return tag && !tag.includes('/') ? tag : null
  } catch {
    return null
  }
}

export function buildFallbackReleaseAsset(
  tagName: string,
  platform: NodeJS.Platform,
  arch: string
): DesktopReleaseAsset | null {
  const version = normalizeVersion(tagName)
  const normalizedArch = arch.toLowerCase()
  let fileName = ''
  if (platform === 'win32' && normalizedArch === 'x64') fileName = `OrigRead-${version}-x64.exe`
  if (platform === 'darwin' && normalizedArch === 'arm64') fileName = `OrigRead-${version}-arm64.dmg`
  if (platform === 'linux' && normalizedArch === 'x64') fileName = `OrigRead-${version}-x64.AppImage`
  if (!fileName) return null
  return {
    id: 0,
    name: fileName,
    size: 0,
    downloadUrl: `${OFFICIAL_RELEASE_DOWNLOAD_PREFIX}${encodeURIComponent(tagName)}/${fileName}`
  }
}

function isTrustedReleasePageUrl(value: string): boolean {
  return value.startsWith(`https://github.com/${ORIGREAD_DESKTOP_REPOSITORY}/releases/tag/`)
}

function parseRelease(payload: GitHubReleasePayload, platform: NodeJS.Platform, arch: string, language: string): DesktopReleaseInfo | null {
  const tagName = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : ''
  const releasePageUrl = typeof payload.html_url === 'string' ? payload.html_url.trim() : ''
  if (!tagName || releaseTagFromPageUrl(releasePageUrl) !== tagName) return null
  const assets = Array.isArray(payload.assets) ? payload.assets as GitHubReleaseAssetPayload[] : []
  return {
    tagName,
    version: normalizeVersion(tagName),
    title: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : tagName,
    notes: localizedReleaseNotes(typeof payload.body === 'string' ? payload.body : '', language),
    publishedDate: formatReleaseDate(
      typeof payload.published_at === 'string'
        ? payload.published_at
        : typeof payload.created_at === 'string' ? payload.created_at : ''
    ),
    releasePageUrl,
    asset: selectReleaseAsset(assets, platform, arch)
  }
}

function parseAsset(value: GitHubReleaseAssetPayload): DesktopReleaseAsset | null {
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : null
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const size = typeof value.size === 'number' && Number.isFinite(value.size) ? Math.max(0, value.size) : 0
  const downloadUrl = typeof value.browser_download_url === 'string' ? value.browser_download_url.trim() : ''
  return id !== null && name && isTrustedReleaseDownloadUrl(downloadUrl) ? { id, name, size, downloadUrl } : null
}

function assetScore(asset: DesktopReleaseAsset, platform: NodeJS.Platform, arch: string): number {
  const name = asset.name.toLowerCase()
  let score = 0
  // 平台已经由扩展名筛选，不再依赖 Windows/macOS/Linux 出现在文件名中。
  // 这样新产物可以统一使用 OrigRead-{version}-{arch}.{ext}，同时旧 Release 仍可兼容。
  if (platform === 'linux' && name.endsWith('.appimage')) score += 30
  if (arch === 'x64' && (name.includes('x64') || name.includes('amd64'))) score += 20
  if (arch === 'arm64' && (name.includes('arm64') || name.includes('aarch64'))) score += 20
  if (name.includes('blockmap') || name.endsWith('.yml') || name.endsWith('.yaml')) score -= 100
  return score
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').split('+')[0] ?? value.trim()
}

function parseVersion(value: string): { core: number[]; pre: string[] } {
  const normalized = normalizeVersion(value)
  const [coreValue = '0', preValue = ''] = normalized.split('-', 2)
  return {
    core: coreValue.split('.').map((part) => Number.parseInt(part.replace(/\D.*$/, ''), 10)).map((part) => Number.isFinite(part) ? part : 0),
    pre: preValue ? preValue.split('.') : []
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error')
}

