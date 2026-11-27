import { createReadStream, createWriteStream } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  DesktopReleaseAsset,
  DesktopReleaseInfo,
  UpdateCheckResult,
  UpdateErrorCode
} from '../../shared/update'

export const ORIGREAD_DESKTOP_REPOSITORY = 'ZGMFX01A/OrigRead-Desktop'
const OFFICIAL_RELEASE_DOWNLOAD_PREFIX = `https://github.com/${ORIGREAD_DESKTOP_REPOSITORY}/releases/download/`
const OFFICIAL_LATEST_RELEASE_URL = `https://github.com/${ORIGREAD_DESKTOP_REPOSITORY}/releases/latest`
const REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'])
const CHECKSUM_MAX_BYTES = 1024 * 1024

export interface ReleaseUpdateOptions {
  metadataTimeoutMs?: number
  downloadTimeoutMs?: number
  maxAssetBytes?: number
}

export type UpdateFetch = (input: string, init?: RequestInit) => Promise<Response>

interface GitHubReleaseAssetPayload {
  id?: unknown
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
  digest?: unknown
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
    private readonly apiBase = 'https://api.github.com',
    private readonly options: ReleaseUpdateOptions = {}
  ) {}

  private get metadataTimeoutMs(): number { return this.options.metadataTimeoutMs ?? 15_000 }

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
        const response = await this.fetchWithRedirects(candidate, {
          signal: AbortSignal.timeout(this.metadataTimeoutMs),
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

        const assets = Array.isArray(payload.assets) ? payload.assets as GitHubReleaseAssetPayload[] : []
        if (release.asset && assets.some((value) => {
          const asset = parseAsset(value)
          return asset && (asset.name === 'SHA256SUMS' || asset.name === 'SHA256SUMS.txt')
            && new URL(asset.downloadUrl).pathname.split('/')[5] === encodeURIComponent(release.tagName)
        })) {
          const checksum = await this.officialChecksum(release.asset)
          if (!release.asset.sha256 && checksum) release.asset.sha256 = checksum
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
        redirect: 'manual',
        signal: AbortSignal.timeout(this.metadataTimeoutMs)
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

  private async fetchWithRedirects(input: string, init: RequestInit): Promise<Response> {
    let current = input
    for (let hops = 0; ; hops += 1) {
      const response = await this.fetcher(current, { ...init, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (hops >= 5 || !location) throw new Error('更新请求重定向过多或缺少目标')
      const next = new URL(location, current)
      if (next.protocol !== 'https:' || next.username || next.password || !REDIRECT_HOSTS.has(next.hostname)) {
        throw new Error('拒绝不受信任的更新重定向')
      }
      current = next.href
    }
  }

  private async officialChecksum(asset: DesktopReleaseAsset): Promise<string | null> {
    const url = new URL(asset.downloadUrl)
    const base = url.href.slice(0, url.href.lastIndexOf('/') + 1)
    for (const name of ['SHA256SUMS', 'SHA256SUMS.txt']) {
      try {
        const signal = AbortSignal.timeout(this.metadataTimeoutMs)
        const response = await this.fetchWithRedirects(`${base}${name}`, {
          signal, headers: { 'User-Agent': 'OrigRead-Desktop-Updater' }
        })
        if (response.status === 404) { await response.body?.cancel(); continue }
        if (!response.ok || !response.body) throw new Error(`SHA256SUMS HTTP ${response.status}`)
        const declared = response.headers.get('content-length')
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CHECKSUM_MAX_BYTES)) {
          await response.body.cancel()
          throw new Error('SHA256SUMS 超出 1 MiB 上限')
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0], { signal })) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > CHECKSUM_MAX_BYTES) throw new Error('SHA256SUMS 超出 1 MiB 上限')
          chunks.push(bytes)
        }
        const sums = parseSha256Sums(Buffer.concat(chunks).toString('utf8'))
        const digest = sums.get(asset.name) ?? sums.get(fileBasename(asset.name))
        if (digest) return digest
      } catch (error) {
        console.warn(`官方 ${name} 校验摘要获取失败：${errorText(error)}`)
      }
    }
    return null
  }

  async downloadAsset(asset: DesktopReleaseAsset, destination: string, _locale: string): Promise<{ sha256: string; size: number }> {
    if (!isTrustedReleaseDownloadUrl(asset.downloadUrl)) throw new Error('拒绝下载非 OrigRead Desktop Release 资产')
    const temporary = `${destination}.part`
    await rm(temporary, { force: true })
    const expectedSha256 = normalizeSha256(asset.sha256) ?? await this.officialChecksum(asset)
    if (!expectedSha256) throw new Error('缺少官方 SHA-256 校验摘要，请前往 GitHub Release 页面手动核验下载')
    const maxBytes = this.options.maxAssetBytes ?? 512 * 1024 * 1024
    try {
      const signal = AbortSignal.timeout(this.options.downloadTimeoutMs ?? 300_000)
      const response = await this.fetchWithRedirects(asset.downloadUrl, {
        headers: { 'User-Agent': 'OrigRead-Desktop-Updater' }, signal
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes
        || (asset.size > 0 && Number(declared) !== asset.size))) {
        await response.body.cancel()
        throw new Error('更新安装包声明体积不匹配或超出上限')
      }
      const hash = createHash('sha256')
      let size = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > maxBytes || (asset.size > 0 && size > asset.size)) {
            callback(new Error('更新安装包体积不匹配或超出上限'))
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter, createWriteStream(temporary), { signal }
      )
      if (asset.size > 0 && size !== asset.size) throw new Error('更新安装包体积不匹配')
      const sha256 = hash.digest('hex')
      assertMatchingSha256(sha256, expectedSha256)
      await rename(temporary, destination)
      return { sha256, size }
    } catch (error) {
      await rm(temporary, { force: true })
      throw new Error(`更新安装包下载失败：${errorText(error)}`, { cause: error })
    }
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

export function releaseDownloadCandidates(url: string, _locale: string): string[] {
  return [url]
}

export function releaseCheckCandidates(url: string, _locale: string): string[] {
  return [url]
}

export function shouldPreferMainlandReleaseMirror(locale: string): boolean {
  const normalized = locale.trim().replaceAll('_', '-').toLowerCase()
  return /(?:^|-)cn(?:-|$)/.test(normalized)
}

export function isTrustedReleaseDownloadUrl(value: string): boolean {
  return isTrustedReleaseUrl(value, 'download', 6)
}

export function resolveLatestReleasePageUrl(response: Response): string | null {
  const location = response.headers.get('location')?.trim() ?? ''
  if (location) {
    if (unsafeReleasePath(location)) return null
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
  if (!isTrustedReleasePageUrl(value)) return null
  try { return decodeURIComponent(new URL(value).pathname.split('/').filter(Boolean)[4]!) } catch { return null }
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

export function isTrustedReleasePageUrl(value: string): boolean {
  return isTrustedReleaseUrl(value, 'tag', 5)
}

function unsafeReleasePath(value: string): boolean {
  return /\\|%2e|%2f|%5c/i.test(value) || value.split('/').some((part) => part === '.' || part === '..')
}

function isTrustedReleaseUrl(value: string, action: string, count: number): boolean {
  try {
    // 必须先查原文；URL 构造会消去点路径，不能拿规范化结果代替输入检查。
    if (unsafeReleasePath(value)) return false
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== 'https://github.com' || url.username || url.password
      || url.search || url.hash || unsafeReleasePath(url.pathname)) return false
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.length === count && parts[0] === 'ZGMFX01A' && parts[1] === 'OrigRead-Desktop'
      && parts[2] === 'releases' && parts[3] === action
  } catch {
    return false
  }
}

function fileBasename(name: string): string {
  return name.replaceAll('\\', '/').split('/').pop() ?? name
}

export function parseSha256Sums(content: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line)
    if (!match) continue
    const name = match[2]!
    const digest = match[1]!.toLowerCase()
    result.set(name, digest)
    result.set(fileBasename(name), digest)
  }
  return result
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
}

function assertMatchingSha256(actual: string, expected: string): void {
  const normalized = normalizeSha256(expected)
  if (!normalized || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(normalized, 'hex'))) {
    throw new Error('更新安装包 SHA-256 校验失败')
  }
}

export async function verifyDownloadedFileIntegrity(filePath: string, expectedSha256: string, expectedSize: number): Promise<void> {
  const info = await stat(filePath)
  if (!info.isFile() || info.size !== expectedSize) throw new Error('更新安装包体积不匹配')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(filePath)) { hash.update(chunk); size += chunk.length }
  if (size !== expectedSize) throw new Error('更新安装包体积不匹配')
  assertMatchingSha256(hash.digest('hex'), expectedSha256)
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
  const digest = typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value.digest)
    ? value.digest.slice(7).toLowerCase() : null
  return id !== null && name && isTrustedReleaseDownloadUrl(downloadUrl) ? { id, name, size, downloadUrl, sha256: digest } : null
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

