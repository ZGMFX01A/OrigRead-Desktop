import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, expect, test as base, type Locator, type Page } from '@playwright/test'

const WHEEL_DELTAS = [250, 500, 900, 1200, 900, 1200, 1200, 900, 700, 500, -1200, -1000, -900, -700, -500]
const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    await mkdir('test-results', { recursive: true })
    const directory = await mkdtemp(join(process.cwd(), 'test-results', 'desktop-list-scroll-'))
    try { await use(directory) } finally { await rm(directory, { recursive: true }) }
  }
})

interface FrameSample { top: number; topGap: number; bottomGap: number; mounted: number; dt: number }
interface CoverageProbe { active: boolean; samples: FrameSample[] }
type ProbeWindow = Window & typeof globalThis & { articleListCoverage?: CoverageProbe }

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
    const nativeWindow = await app.browserWindow(page)
    await nativeWindow.evaluate(window => window.setContentSize(1600, 1000))
    await expect(page.locator('.app-shell')).toBeVisible()
    await inspect(page)
    expect(errors).toEqual([])
  } finally { await app.close() }
}

async function fixture() {
  let baseUrl = '', bodyRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/image.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#6657d9"/></svg>')
      return
    }
    if (request.url !== '/feed') {
      if (request.url?.startsWith('/article/')) bodyRequests++
      response.writeHead(404).end()
      return
    }
    const now = Date.now()
    const items = Array.from({ length: 1200 }, (_, index) => '<item><guid>scroll-' + index + '</guid><title>Row ' +
      String(index).padStart(4, '0') + (index % 3 === 0 ? ' — A headline with enough words to occupy both of its allowed title lines in the narrow article list' : '') +
      '</title><link>' + baseUrl + '/article/' + index + '</link><pubDate>' + new Date(now - index * 1000).toUTCString() +
      '</pubDate><description>' + (index % 4 === 0 ? 'Brief.' : 'Preview text with enough words to fill both allowed lines at the article widths under examination. '.repeat(2)) +
      '</description>' + (index % 2 === 0 ? '<enclosure url="' + baseUrl + '/image.svg" type="image/svg+xml" length="150"/>' : '') + '</item>').join('')
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(
      '<rss version="2.0"><channel><title>List scroll fixture</title><link>' + baseUrl + '</link><description>Local scroll test</description>' +
      items + '</channel></rss>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local fixture port')
  baseUrl = 'http://127.0.0.1:' + address.port
  return { baseUrl, bodyRequests: () => bodyRequests, close: async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

async function frames(page: Page, count = 1): Promise<void> {
  await page.evaluate(count => new Promise<void>(resolve => {
    const tick = (): void => { if (--count <= 0) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }), count)
}

/** DOM coverage at animation-frame sampling points, not a claim about compositor paint timing. */
async function beginCoverage(list: Locator): Promise<void> {
  await list.evaluate(element => {
    const host = window as ProbeWindow
    const probe: CoverageProbe = { active: true, samples: [] }
    host.articleListCoverage = probe
    let previous = performance.now()
    const tick = (now: number): void => {
      if (!probe.active) return
      const rect = element.getBoundingClientRect()
      const rows = element.querySelectorAll<HTMLElement>('.article-virtual-row')
      const first = rows[0]?.getBoundingClientRect(), last = rows[rows.length - 1]?.getBoundingClientRect()
      // The scrolling list intentionally includes 4px top and 14px bottom padding.
      const top = rect.top + Math.max(0, 4 - element.scrollTop)
      const bottom = rect.bottom - Math.max(0, 14 - (element.scrollHeight - element.scrollTop - element.clientHeight))
      probe.samples.push({
        top: element.scrollTop, mounted: rows.length, dt: now - previous,
        topGap: first ? Math.max(0, first.top - top) : rect.height,
        bottomGap: last ? Math.max(0, bottom - last.bottom) : rect.height
      })
      previous = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function endCoverage(page: Page) {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).articleListCoverage!
    probe.active = false
    const samples = probe.samples
    return {
      metric: 'DOM coverage sampled each animation frame',
      frames: samples.length,
      uncoveredFrames: samples.filter(sample => Math.max(sample.topGap, sample.bottomGap) > 1).length,
      maxUncoveredPx: Math.max(0, ...samples.map(sample => Math.max(sample.topGap, sample.bottomGap))),
      maxMounted: Math.max(0, ...samples.map(sample => sample.mounted)),
      maxFrameMs: Math.max(0, ...samples.map(sample => sample.dt)),
      firstTop: samples[0]?.top ?? 0, lastTop: samples.at(-1)?.top ?? 0, samples
    }
  })
}

test('连续加速与反向滚轮逐帧覆盖可视区，并保持少于40个虚拟行', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const source = await fixture()
  const metrics: unknown[] = []
  try {
    await withDesktop(userDataDir, async page => {
      const count = await page.evaluate(async url => {
        await window.origread.updateSettings({ language: 'en', layoutMode: 'three-pane', sourcePaneWidth: 220 })
        const feed = await window.origread.addRssSource(url)
        return (await window.origread.listArticlesByFeed(feed.feedId)).length
      }, source.baseUrl + '/feed')
      expect(count).toBe(1200)
      for (const uiFontScale of [100, 150] as const) {
        for (const showArticleThumbnails of [false, true]) {
          await test.step(uiFontScale + '%/thumbnails=' + showArticleThumbnails, async () => {
            await page.evaluate(patch => window.origread.updateSettings(patch),
              { uiFontScale, showArticleThumbnails, articlePaneWidth: 320 })
            await page.reload()
            await page.locator('.source-item[title="List scroll fixture"]').click()
            await expect(page.locator('.article-item').first()).toContainText('Row 0000')
            await expect.poll(() => page.locator('.article-topline strong').first()
              .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(12.5 * uiFontScale / 100, 2)
            await frames(page, 8)
            const list = page.locator('.article-list')
            const box = (await list.boundingBox())!
            const initialRows = await list.evaluate(element => [...element.querySelectorAll<HTMLElement>('.article-virtual-row')]
              .map(row => ({ height: row.getBoundingClientRect().height, thumbnail: !!row.querySelector('.article-thumbnail') })))
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await beginCoverage(list)
            // Trusted wheel input and continuous rAF observation, with no scrollTop assignment or settling wait per input.
            for (const delta of WHEEL_DELTAS) {
              await page.mouse.wheel(0, delta)
              await frames(page)
            }
            await frames(page, 6)
            const coverage = await endCoverage(page)
            const record = { uiFontScale, showArticleThumbnails, viewport: { width: box.width, height: box.height }, initialRows, ...coverage }
            metrics.push(record)
            await writeFile('test-results/article-list-scroll-metrics.json', JSON.stringify({ wheelDeltas: WHEEL_DELTAS, metrics }, null, 2) + '\n')
            await test.info().attach('scroll-' + uiFontScale + '-' + showArticleThumbnails, {
              body: JSON.stringify(record, null, 2), contentType: 'application/json'
            })
            console.log('ARTICLE_LIST_SCROLL ' + JSON.stringify({ uiFontScale, showArticleThumbnails,
              frames: coverage.frames, uncoveredFrames: coverage.uncoveredFrames, maxUncoveredPx: coverage.maxUncoveredPx, maxMounted: coverage.maxMounted }))
            expect(coverage.frames).toBeGreaterThan(WHEEL_DELTAS.length)
            expect(coverage.lastTop - coverage.firstTop).toBeGreaterThan(1000)
            expect(coverage.maxMounted).toBeLessThan(40)
            expect(coverage.maxUncoveredPx).toBeLessThanOrEqual(1)
          })
        }
      }
      expect(source.bodyRequests()).toBe(0)
    })
  } finally { await source.close() }
})
