import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, expect, test as base, type Page } from '@playwright/test'

const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const root = join(process.cwd(), 'test-results')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'desktop-thumbnail-network-'))
    try { await use(directory) } finally { await rm(directory, { recursive: true }) }
  }
})

async function withDesktop(userDataDir: string, inspect: (page: Page) => Promise<void>): Promise<void> {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const app = await _electron.launch({
    args: [process.cwd()], cwd: process.cwd(),
    env: { ...inheritedEnv, ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1', ORIGREAD_DISABLE_PERIODIC_SYNC: '1' }
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.setViewportSize({ width: 1920, height: 1080 })
    await inspect(page)
    expect(errors).toEqual([])
  } finally { await app.close() }
}

/** Deliberately rejects invented Referer values; no public image host is contacted. */
async function networkFixture(mode: 'referrer' | 'many' | 'refresh') {
  let baseUrl = ''
  let failFeed = false
  const count = mode === 'many' ? 360 : 1
  const publishedAt = Date.now()
  const hits = new Map<string, number>()
  const referrers: Array<{ path: string; value: string | null; status: number }> = []
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#7868d8"/></svg>'
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', baseUrl)
    if (url.pathname === '/feed') {
      if (failFeed) { response.writeHead(503, { 'Cache-Control': 'no-store' }).end('Temporary fixture failure'); return }
      const items = Array.from({ length: count }, (_, index) => {
        const number = String(index).padStart(4, '0')
        const imageUrl = mode === 'referrer' ? baseUrl + '/no-referrer.svg?thumbnail'
          : mode === 'many' && index === count - 1 ? baseUrl + '/good.svg' : baseUrl + '/broken/' + number + '.svg'
        const body = mode === 'referrer' ? '<p>Reader image</p><img src="' + baseUrl + '/no-referrer.svg?body">' : '<p>Cached body</p>'
        return '<item><guid>thumbnail-' + number + '</guid><title>Thumbnail ' + number + '</title>' +
          '<link>' + baseUrl + '/article/' + number + '</link><pubDate>' +
          new Date(publishedAt - index * 1000).toUTCString() + '</pubDate><description>Image network fixture</description>' +
          '<content:encoded><![CDATA[' + body + ']]></content:encoded>' +
          '<enclosure url="' + imageUrl + '" type="image/svg+xml" length="100"/></item>'
      }).join('')
      response.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Cache-Control': 'no-store' }).end(
        '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>' +
        '<title>Thumbnail network fixture</title><link>' + baseUrl + '</link><description>Local fixture</description>' +
        items + '</channel></rss>')
      return
    }
    hits.set(url.pathname + url.search, (hits.get(url.pathname + url.search) ?? 0) + 1)
    if (url.pathname.startsWith('/article/')) {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'strict-origin-when-cross-origin' }).end(
        '<!doctype html><html><body><h1>Original article</h1><img src="' + baseUrl + '/original.svg"></body></html>')
      return
    }
    if (url.pathname === '/no-referrer.svg' || url.pathname === '/original.svg') {
      const value = request.headers.referer ?? null
      const accepted = url.pathname === '/no-referrer.svg' ? value === null : value === baseUrl + '/article/0000'
      referrers.push({ path: url.pathname + url.search, value, status: accepted ? 200 : 403 })
      response.writeHead(accepted ? 200 : 403, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' })
        .end(accepted ? image : 'Rejected Referer')
      return
    }
    if (url.pathname === '/good.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(image)
      return
    }
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local fixture port')
  baseUrl = 'http://127.0.0.1:' + address.port
  return {
    baseUrl, count, hits, referrers,
    failFeed: () => { failFeed = true },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

async function seed(page: Page, baseUrl: string): Promise<string[]> {
  const ids = await page.evaluate(async baseUrl => {
    await window.origread.updateSettings({ language: 'en', showArticleThumbnails: false })
    const source = await window.origread.addRssSource(baseUrl + '/feed')
    return (await window.origread.listArticlesByFeed(source.feedId)).map(article => article.id)
  }, baseUrl)
  await page.reload()
  await page.locator('.source-item[title="Thumbnail network fixture"]').click()
  await expect(page.locator('.article-item').first()).toContainText('Thumbnail 0000')
  // Enable only after selecting the source, so request counts start in one stable scope.
  await page.locator('.settings-button').click()
  await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
  await page.locator('.settings-back-button').click()
  return ids
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function settleVisibleImages(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.article-list').evaluate(element => {
    const viewport = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLImageElement>('.article-thumbnail img')].every(image => {
      const bounds = image.getBoundingClientRect()
      return bounds.bottom <= viewport.top || bounds.top >= viewport.bottom || image.complete
    })
  })).toBe(true)
  await frames(page)
}

async function sweepToEnd(page: Page): Promise<void> {
  const list = page.locator('.article-list')
  await list.evaluate(element => { element.scrollTop = 0 })
  await frames(page)
  for (let step = 0; step < 180; step++) {
    await settleVisibleImages(page)
    if (await list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)) return
    await list.evaluate(element => { element.scrollTop += Math.max(1, element.clientHeight * 0.75) })
    await frames(page)
  }
  throw new Error('Thumbnail fixture did not reach the list end')
}

test('Reader与缩略图不伪造Referer，独立原文页保留正常来源', async ({ userDataDir }) => {
  const fixture = await networkFixture('referrer')
  try {
    await withDesktop(userDataDir, async page => {
      const ids = await seed(page, fixture.baseUrl)
      const row = page.locator('[data-article-id="' + ids[0] + '"]')
      await expect.poll(() => fixture.referrers.find(item => item.path === '/no-referrer.svg?thumbnail'))
        .toEqual({ path: '/no-referrer.svg?thumbnail', value: null, status: 200 })
      await expect(row.locator('.article-thumbnail img')).toHaveAttribute('referrerpolicy', 'no-referrer')
      await expect.poll(() => row.locator('.article-thumbnail img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await row.click()
      await expect.poll(() => page.locator('.article-body img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
      await page.locator('.original-button').click()
      await expect.poll(() => fixture.referrers.find(item => item.path === '/original.svg')?.status).toBe(200)
      expect(fixture.referrers.filter(item => item.path.startsWith('/no-referrer.svg'))).toEqual(
        expect.arrayContaining([
          { path: '/no-referrer.svg?thumbnail', value: null, status: 200 },
          { path: '/no-referrer.svg?body', value: null, status: 200 }
        ]))
      expect(fixture.referrers.every(item => item.status === 200)).toBe(true)
    })
  } finally { await fixture.close() }
})

test('超过200张失败缩略图往返滚动和筛选不重复请求，健康图仍可加载', async ({ userDataDir }) => {
  test.setTimeout(120_000)
  const fixture = await networkFixture('many')
  try {
    await withDesktop(userDataDir, async page => {
      await seed(page, fixture.baseUrl)
      await sweepToEnd(page)
      const broken = () => [...fixture.hits].filter(([path]) => path.startsWith('/broken/'))
      expect(broken()).toHaveLength(fixture.count - 1)
      expect(broken().every(([, count]) => count === 1)).toBe(true)
      await expect.poll(() => page.locator('.article-thumbnail img[src$="/good.svg"]')
        .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

      const search = page.locator('.article-pane .search-field input')
      await search.fill('Thumbnail 0000')
      await expect(page.locator('.article-item')).toHaveCount(1)
      await expect(page.locator('.article-thumbnail-failed')).toHaveCount(1)
      await search.fill('')
      await expect(page.locator('.article-item').first()).toContainText('Thumbnail 0000')
      await sweepToEnd(page)
      expect(broken()).toHaveLength(fixture.count - 1)
      expect(broken().every(([, count]) => count === 1)).toBe(true)
    })
  } finally { await fixture.close() }
})

test('一次刷新只重试失败图一次，包括订阅立即失败的刷新', async ({ userDataDir }) => {
  const fixture = await networkFixture('refresh')
  try {
    await withDesktop(userDataDir, async page => {
      await seed(page, fixture.baseUrl)
      const failed = page.locator('.article-thumbnail-failed')
      const refresh = page.locator('.article-pane .refresh-all-button')
      await expect(failed).toHaveCount(1)
      expect(fixture.hits.get('/broken/0000.svg')).toBe(1)
      await refresh.click()
      await expect.poll(() => fixture.hits.get('/broken/0000.svg')).toBe(2)
      await expect(refresh).toBeEnabled()
      await expect(failed).toHaveCount(1)
      await frames(page)
      expect(fixture.hits.get('/broken/0000.svg')).toBe(2)

      fixture.failFeed()
      await refresh.click()
      await expect.poll(() => fixture.hits.get('/broken/0000.svg')).toBe(3)
      await expect(refresh).toBeEnabled()
      await expect(failed).toHaveCount(1)
      await frames(page)
      expect(fixture.hits.get('/broken/0000.svg')).toBe(3)
    })
  } finally { await fixture.close() }
})
