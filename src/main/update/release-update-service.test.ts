import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isTrustedReleaseDownloadUrl,
  isTrustedReleasePageUrl,
  parseSha256Sums,
  verifyDownloadedFileIntegrity,
  buildFallbackReleaseAsset,
  compareVersions,
  localizedReleaseNotes,
  releaseTagFromPageUrl,
  releaseDownloadCandidates,
  ReleaseUpdateService,
  releaseCheckCandidates,
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

  it('uses direct official downloads in every locale', () => {
    const url = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/OrigRead.exe'
    expect(releaseDownloadCandidates(url, 'zh-CN')).toEqual([url])
    expect(releaseDownloadCandidates(url, 'en-CN')).toEqual([url])
    expect(releaseDownloadCandidates(url, 'zh-Hans-CN')).toEqual([url])
    expect(releaseDownloadCandidates(url, 'en-US')).toEqual([url])
    expect(releaseDownloadCandidates('https://api.github.com/repos/x/y', 'zh-CN')).toEqual(['https://api.github.com/repos/x/y'])
    expect(shouldPreferMainlandReleaseMirror('zh_CN')).toBe(true)
    expect(shouldPreferMainlandReleaseMirror('zh-SG')).toBe(false)
  })

  it('checks release metadata directly in mainland locales', async () => {
    const official = 'https://api.github.com/repos/ZGMFX01A/OrigRead-Desktop/releases/latest'
    const calls: string[] = []
    const service = new ReleaseUpdateService(async (input) => {
      calls.push(input)
      return new Response(JSON.stringify({
        tag_name: 'v1.2.3',
        html_url: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.2.3',
        assets: []
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await service.check('0.1.0', 'win32', 'x64', 'zh', 'zh-CN')

    expect(releaseCheckCandidates(official, 'zh-CN')).toEqual([official])
    expect(calls).toEqual([official])
    expect(result.status).toBe('available')
    expect(result.release?.version).toBe('1.2.3')
  })

  it('verifies the digest and downloads the official asset directly', async () => {
    const official = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/OrigRead-1.0.0-x64.exe'
    const calls: string[] = []
    const service = new ReleaseUpdateService(async (input) => {
      calls.push(input)
      return new Response('installer-bytes', { status: 200 })
    })
    const dir = mkdtempSync(join(process.cwd(), '.origread-update-'))
    const destination = join(dir, 'OrigRead.exe')
    try {
      await service.downloadAsset({ id: 1, name: 'OrigRead.exe', size: 15, downloadUrl: official, sha256: createHash('sha256').update('installer-bytes').digest('hex') }, destination, 'zh-CN')
      expect(calls).toEqual([official])
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

  it('rejects release metadata whose tag does not match its official page URL', async () => {
    const service = new ReleaseUpdateService(async () => new Response(JSON.stringify({
      tag_name: 'v1.2.0',
      html_url: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.1.0',
      assets: []
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await service.check('0.1.0', 'win32', 'x64', 'en')

    expect(result.status).toBe('error')
    expect(result.errorCode).toBe('INVALID_RESPONSE')
  })
})



const base = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v1.0.0/'
const payload = 'verified installer'
const sha256 = createHash('sha256').update(payload).digest('hex')
const asset = { id: 1, name: 'OrigRead.exe', size: Buffer.byteLength(payload), downloadUrl: `${base}OrigRead.exe`, sha256 }

async function withDestination(run: (destination: string) => Promise<void>): Promise<void> {
  // 每个用例只删除自己刚创建的目录。
  const directory = mkdtempSync(join(process.cwd(), '.origread-p0-update-'))
  try { await run(join(directory, 'OrigRead.exe')) } finally { rmSync(directory, { recursive: true, force: true }) }
}

function expectNoFiles(destination: string): void {
  expect(existsSync(destination)).toBe(false)
  expect(existsSync(`${destination}.part`)).toBe(false)
}

describe('release URL and integrity boundaries', () => {
  it('never returns the removed public proxy for any locale', () => {
    for (const locale of ['zh-CN', 'en-CN', 'zh_Hans_CN', 'en-US', '']) {
      for (const candidates of [releaseCheckCandidates('https://api.github.com/repos/ZGMFX01A/OrigRead-Desktop/releases/latest', locale), releaseDownloadCandidates(asset.downloadUrl, locale)]) {
        expect(candidates).toHaveLength(1)
        expect(candidates.join()).not.toContain('gh-proxy.com')
      }
    }
  })
  it.each([
    '/v/../v/file.exe', '/v/%2e%2e/file.exe', '/v/a%2fb.exe', '/v/a%5Cb.exe', '/v/extra/file.exe',
    '/v/file.exe?x=1', '/v/file.exe#hash', '/v/./file.exe'
  ])('rejects unsafe download paths %s', (suffix) => {
    expect(isTrustedReleaseDownloadUrl(`https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download${suffix}`)).toBe(false)
  })
  it('rejects untrusted protocol, credentials, repository and page traversal', () => {
    const page = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1'
    expect(isTrustedReleasePageUrl(page)).toBe(true)
    expect(isTrustedReleaseDownloadUrl(asset.downloadUrl)).toBe(true)
    for (const value of [page, asset.downloadUrl]) {
      const validate = value === page ? isTrustedReleasePageUrl : isTrustedReleaseDownloadUrl
      for (const invalid of [value.replace('https:', 'http:'), value.replace('github.com', 'user@github.com'), value.replace('ZGMFX01A', 'other'), `${value}?x=1`, `${value}#hash`, `${value}/extra`, value.replace('/releases/', '/./releases/'), value.replace('/releases/', '/%2E%2E/releases/'), value.replace('/releases/', '/releases%2f/'), value.replace('/releases/', '/releases\\')]) expect(validate(invalid)).toBe(false)
    }
  })
  it('parses standard text and binary sum formats with basename matching', () => {
    const result = parseSha256Sums(`${sha256.toUpperCase()}  builds/OrigRead.exe\n${sha256} *Other.exe\nbad  Invalid.exe`)
    expect(result.get('OrigRead.exe')).toBe(sha256)
    expect(result.get('builds/OrigRead.exe')).toBe(sha256)
    expect(result.get('Other.exe')).toBe(sha256)
    expect(result.has('Invalid.exe')).toBe(false)
  })
  it('normalizes valid API digests and discards malformed digests', () => {
    const raw = { id: 1, name: asset.name, size: asset.size, browser_download_url: asset.downloadUrl }
    expect(selectReleaseAsset([{ ...raw, digest: `sha256:${sha256.toUpperCase()}` }], 'win32', 'x64')?.sha256).toBe(sha256)
    expect(selectReleaseAsset([{ ...raw, digest: 'sha256:bad' }], 'win32', 'x64')?.sha256).toBeNull()
  })
  it('fails closed before requesting an installer without an official checksum', async () => {
    await withDestination(async (destination) => {
      const calls: string[] = []
      const service = new ReleaseUpdateService(async (url) => { calls.push(url); return new Response('', { status: 404 }) })
      await expect(service.downloadAsset({ ...asset, sha256: null }, destination, '')).rejects.toThrow('缺少官方 SHA-256')
      expect(calls).toEqual([`${base}SHA256SUMS`, `${base}SHA256SUMS.txt`])
      expectNoFiles(destination)
    })
  })
  it('downloads and verifies the official sums fallback, including .txt', async () => {
    await withDestination(async (destination) => {
      const service = new ReleaseUpdateService(async (url, init) => {
        expect(init?.redirect).toBe('manual')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        if (url.endsWith('/SHA256SUMS')) return new Response('', { status: 404 })
        return new Response(url.endsWith('/SHA256SUMS.txt') ? `${sha256} *build/OrigRead.exe` : payload)
      })
      await expect(service.downloadAsset({ ...asset, sha256: null }, destination, '')).resolves.toEqual({ sha256, size: asset.size })
      expect(readFileSync(destination, 'utf8')).toBe(payload)
      expect(existsSync(`${destination}.part`)).toBe(false)
      await expect(verifyDownloadedFileIntegrity(destination, sha256, asset.size)).resolves.toBeUndefined()
      writeFileSync(destination, 'x'.repeat(asset.size))
      await expect(verifyDownloadedFileIntegrity(destination, sha256, asset.size)).rejects.toThrow('SHA-256')
      writeFileSync(destination, 'short')
      await expect(verifyDownloadedFileIntegrity(destination, sha256, asset.size)).rejects.toThrow('体积')
      rmSync(destination)
      await expect(verifyDownloadedFileIntegrity(destination, sha256, asset.size)).rejects.toThrow()
    })
  })
  it('hydrates a selected API asset from a trusted SHA256SUMS asset', async () => {
    const service = new ReleaseUpdateService(async (url) => url.endsWith('/SHA256SUMS')
      ? new Response(`${sha256}  OrigRead.exe`)
      : new Response(JSON.stringify({ tag_name: 'v1.0.0', html_url: 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.0.0', assets: [
          { id: 1, name: asset.name, size: asset.size, browser_download_url: asset.downloadUrl },
          { id: 2, name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` }
        ] })))
    expect((await service.check('0.1.0', 'win32', 'x64', 'en')).release?.asset?.sha256).toBe(sha256)
  })
  it('preserves an existing destination and removes partial bytes on digest mismatch', async () => {
    await withDestination(async (destination) => {
      writeFileSync(destination, 'existing')
      const service = new ReleaseUpdateService(async () => new Response('x'.repeat(asset.size)))
      await expect(service.downloadAsset(asset, destination, '')).rejects.toThrow('SHA-256')
      expect(readFileSync(destination, 'utf8')).toBe('existing')
      expect(existsSync(`${destination}.part`)).toBe(false)
    })
  })
  it.each([
    { limit: 4, declaredSize: 0, length: null, body: payload },
    { limit: 100, declaredSize: 4, length: null, body: payload },
    { limit: 100, declaredSize: 100, length: null, body: payload },
    { limit: 4, declaredSize: 0, length: '18', body: payload },
    { limit: 100, declaredSize: 20, length: '18', body: payload }
  ])('cleans partial files on size violations %j', async ({ limit, declaredSize, length, body }) => {
    await withDestination(async (destination) => {
      const service = new ReleaseUpdateService(async () => new Response(body, { headers: length ? { 'Content-Length': length } : {} }), undefined, { maxAssetBytes: limit })
      await expect(service.downloadAsset({ ...asset, size: declaredSize }, destination, '')).rejects.toThrow('体积')
      expectNoFiles(destination)
    })
  })
  it.each(['https://evil.example/file', 'http://github.com/file', 'https://user@github.com/file', 'https://github.com.evil.example/file'])('refuses malicious redirects %s', async (location) => {
    await withDestination(async (destination) => {
      const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { location } }))
      await expect(new ReleaseUpdateService(fetcher).downloadAsset(asset, destination, '')).rejects.toThrow('重定向')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expectNoFiles(destination)
    })
  })
  it('follows allowed redirects and stops after five hops', async () => {
    await withDestination(async (destination) => {
      let calls = 0
      const service = new ReleaseUpdateService(async () => ++calls <= 5
        ? new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } })
        : new Response(payload))
      await expect(service.downloadAsset(asset, destination, '')).resolves.toEqual({ sha256, size: asset.size })
      expect(calls).toBe(6)
      rmSync(destination)
      const looping = new ReleaseUpdateService(async () => new Response('', { status: 302, headers: { location: 'https://objects.githubusercontent.com/file' } }))
      await expect(looping.downloadAsset(asset, destination, '')).rejects.toThrow('重定向过多')
      expectNoFiles(destination)
    })
  })
  it('limits checksum bodies to 1 MiB before downloading any installer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await withDestination(async (destination) => {
        const calls: string[] = []
        const service = new ReleaseUpdateService(async (url) => { calls.push(url); return new Response('x'.repeat(1024 * 1024 + 1)) })
        await expect(service.downloadAsset({ ...asset, sha256: null }, destination, '')).rejects.toThrow('缺少官方 SHA-256')
        expect(calls).toEqual([`${base}SHA256SUMS`, `${base}SHA256SUMS.txt`])
        expect(warn).toHaveBeenCalledTimes(2)
        expectNoFiles(destination)
      })
    } finally { warn.mockRestore() }
  })
  it('applies configured metadata and download deadlines', async () => {
    await withDestination(async (destination) => {
      const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      }))
      const service = new ReleaseUpdateService(fetcher, undefined, { metadataTimeoutMs: 10, downloadTimeoutMs: 10 })
      await expect(service.downloadAsset(asset, destination, '')).rejects.toThrow('aborted')
      expectNoFiles(destination)
      const result = await service.check('0.1.0', 'win32', 'x64', 'en')
      expect(result.errorCode).toBe('NETWORK')
      expect(fetcher).toHaveBeenCalledTimes(3)
    })
  })
})


describe('installer response body interruption', () => {
  it.each(['limit', 'timeout'] as const)('cancels the source and removes partial output on body %s', async (reason) => {
    await withDestination(async (destination) => {
      const cancel = vi.fn()
      let sent = false
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(payload)) }
          // 首块之后保持挂起，让下载期限在读取响应体时触发。
        },
        cancel
      })
      const service = new ReleaseUpdateService(async () => new Response(stream), undefined, {
        maxAssetBytes: reason === 'limit' ? 4 : 1024,
        downloadTimeoutMs: 30
      })
      await expect(service.downloadAsset(asset, destination, '')).rejects.toThrow(reason === 'limit' ? '体积' : 'aborted')
      expect(cancel).toHaveBeenCalledTimes(1)
      expectNoFiles(destination)
    })
  })
})
