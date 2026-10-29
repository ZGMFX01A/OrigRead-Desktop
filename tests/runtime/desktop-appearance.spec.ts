import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, expect, test as base, type Locator, type Page } from '@playwright/test'

const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const root = join(process.cwd(), 'test-results')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'desktop-appearance-'))
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

/** Only local HTTP fixtures are used; translation never reaches a real provider. */
async function appearanceFixture() {
  let baseUrl = ''
  let imageRevision = 0
  let translationCalls = 0
  let articleRequests = 0
  const hits = new Map<string, number>()
  const slow = new Set<ServerResponse>()
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#7868d8"/><circle cx="112" cy="36" r="18" fill="#ffdf85"/><path d="M0 120L62 44L140 120Z" fill="#c8c3f3"/></svg>'
  const sendImage = (response: ServerResponse): void => {
    if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(image)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl)
    if (url.pathname === '/feed' || url.pathname === '/large') {
      const large = url.pathname === '/large'
      const count = large ? 1200 : 8
      const now = Date.now()
      const items = Array.from({ length: count }, (_, index) => {
        const title = 'Appearance article ' + String(index).padStart(4, '0') +
          (index % 3 === 0 ? ' — A longer headline that wraps across lines while the list keeps its reading position' : '')
        const preview = 'Preview ' + index + '. ' + 'Text for a variable-height article card. '.repeat(5)
        let imageUrl: string | null = baseUrl + '/good.svg?id=' + index
        if (!large) {
          if (index === 1) imageUrl = null
          if (index === 2) imageUrl = baseUrl + '/slow.svg'
          if (index === 3) imageUrl = baseUrl + (imageRevision ? '/good.svg?changed=1' : '/missing.svg')
          if (index === 4) imageUrl = baseUrl + '/not-image'
          if (index === 5) imageUrl = '../good.svg?relative=5'
          if (index === 6) imageUrl = 'javascript:alert(1)'
        }
        return '<item><guid>' + (large ? 'large-' : 'small-') + index + '</guid><title>' + title + '</title>' +
          '<link>' + baseUrl + '/article/' + index + '</link><pubDate>' + new Date(now - index * 1000).toUTCString() + '</pubDate>' +
          '<description>' + preview + '</description><content:encoded><![CDATA[<p>Body ' + index +
          '</p><p>' + 'Long body with content independent of UI scaling. '.repeat(40) + '</p>]]></content:encoded>' +
          (imageUrl ? '<enclosure url="' + imageUrl + '" type="image/svg+xml" length="200"/>' : '') + '</item>'
      }).join('')
      response.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(
        '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Appearance fixture</title>' +
        '<link>' + baseUrl + '</link><description>Appearance test</description>' + items + '</channel></rss>')
      return
    }
    if (url.pathname === '/translate') {
      let body = ''
      for await (const chunk of request) body += chunk
      translationCalls++
      const input = JSON.parse(body) as { text: string }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: '译文：' + input.text }))
      return
    }
    if (url.pathname.startsWith('/article/')) articleRequests++
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    if (url.pathname === '/good.svg') { sendImage(response); return }
    if (url.pathname === '/slow.svg') {
      slow.add(response)
      response.once('close', () => slow.delete(response))
      return
    }
    if (url.pathname === '/not-image') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end('not an image'); return }
    response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local fixture port')
  baseUrl = 'http://127.0.0.1:' + address.port
  return {
    baseUrl, hits,
    translationCalls: () => translationCalls,
    articleRequests: () => articleRequests,
    repairImage: () => { imageRevision++ },
    releaseImages: () => { for (const response of slow) sendImage(response); slow.clear() },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

async function seed(page: Page, baseUrl: string, large = false) {
  const payload = await page.evaluate(async ({ baseUrl, large }) => {
    await window.origread.updateSettings({ language: 'en' })
    await window.origread.updateTranslationProvider({ type: 'DLX', enabled: true, endpoint: baseUrl + '/translate' })
    await window.origread.updateTranslationSettings({
      defaultTarget: { type: 'traditional', provider: 'DLX' }, targetLanguage: 'zh-CN', displayMode: 'BILINGUAL'
    })
    const source = await window.origread.addRssSource(baseUrl + (large ? '/large' : '/feed'))
    const articles = await window.origread.listArticlesByFeed(source.feedId)
    return { ids: articles.map(article => article.id), count: articles.length,
      bytes: new TextEncoder().encode(JSON.stringify(articles)).byteLength,
      bodies: articles.some(article => article.contentHtml !== null || article.fullContentHtml !== null) }
  }, { baseUrl, large })
  await page.reload()
  await expect(page.locator('.source-item[title="Appearance fixture"]')).toBeVisible()
  await page.locator('.source-item[title="Appearance fixture"]').click()
  await expect(page.locator('.article-item').first()).toContainText('Appearance article 0000')
  return payload
}

const row = (page: Page, id: string): Locator => page.locator('.article-item[data-article-id="' + id + '"]')
const fontSize = (locator: Locator): Promise<number> =>
  locator.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))

async function frames(page: Page, count = 4): Promise<void> {
  await page.evaluate(count => new Promise<void>(resolve => {
    const tick = (): void => { if (--count <= 0) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }), count)
}

async function anchor(list: Locator) {
  return list.evaluate(element => {
    // Padding scrolls with content; even a partially visible row at the physical top is an anchor.
    const edge = element.getBoundingClientRect().top
    const wrapper = [...element.querySelectorAll<HTMLElement>('.article-virtual-row')]
      .find(item => item.getBoundingClientRect().bottom > edge)
    if (!wrapper) throw new Error('No visible virtual article')
    return { id: wrapper.querySelector<HTMLElement>('[data-article-id]')!.dataset.articleId!,
      offset: wrapper.getBoundingClientRect().top - edge }
  })
}

async function expectAnchor(page: Page, list: Locator, expected: { id: string; offset: number }): Promise<void> {
  await expect.poll(async () => {
    const actual = await anchor(list)
    return { id: actual.id, offsetDifference: Math.abs(actual.offset - expected.offset) <= 2 ? 0 : actual.offset - expected.offset }
  }).toEqual({ id: expected.id, offsetDifference: 0 })
  // Assert after another measurement batch as well, not just at a transient restored frame.
  await frames(page, 6)
  const actual = await anchor(list)
  expect(actual.id).toBe(expected.id)
  expect(Math.abs(actual.offset - expected.offset)).toBeLessThanOrEqual(2)
  const layout = await list.evaluate(element => {
    const rows = [...element.querySelectorAll('.article-virtual-row')].map(item => item.getBoundingClientRect())
    return { count: rows.length, contiguous: rows.every((rect, index) =>
      index === 0 || Math.abs(rect.top - rows[index - 1]!.bottom) <= 1),
      covered: rows.some(rect => rect.top <= element.getBoundingClientRect().top + 4 &&
        rect.bottom > element.getBoundingClientRect().top + 4) }
  })
  expect(layout.count).toBeLessThan(40)
  expect(layout.contiguous).toBe(true)
  expect(layout.covered).toBe(true)
}

test('界面字号即时生效、独立于正文，搜索和body portal继承且重启保存', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const fixture = await appearanceFixture()
  try {
    await withDesktop(userDataDir, async page => {
      const data = await seed(page, fixture.baseUrl)
      await row(page, data.ids[0]!).click()
      await expect(page.locator('.article-body')).toContainText('Body 0')
      expect(await fontSize(page.locator('.article-body'))).toBe(17)
      expect(await fontSize(row(page, data.ids[0]!).locator('.article-title-copy strong').first())).toBe(12.5)
      expect(await page.locator('.article-thumbnail').count()).toBe(0)
      const widths = await page.evaluate(async () => {
        const settings = await window.origread.getSettings()
        return [settings.sourcePaneWidth, settings.articlePaneWidth, settings.workspaceWidth]
      })
      await page.locator('.settings-button').click()
      await page.locator('.settings-search-input').fill('UI text size')
      await page.locator('[data-settings-search-id="uiFontScale"]').click()
      await expect(page.locator('[data-setting-anchor="uiFontScale"]')).toBeInViewport()
      for (const scale of [110, 125, 150]) {
        await page.locator('.ui-font-scale-select').selectOption(String(scale))
        await expect.poll(() => fontSize(page.locator('.source-item[title="Appearance fixture"] .source-copy strong')))
          .toBeCloseTo(12.5 * scale / 100, 2)
        expect(await fontSize(row(page, data.ids[0]!).locator('.article-title-copy strong').first())).toBeCloseTo(12.5 * scale / 100, 2)
        expect(await fontSize(row(page, data.ids[0]!).locator('p').first())).toBeCloseTo(10.5 * scale / 100, 2)
        expect(await fontSize(page.locator('[data-setting-anchor="uiFontScale"] .setting-copy strong'))).toBeCloseTo(12.5 * scale / 100, 2)
      }
      await page.locator('.settings-search-input').fill('thumbnail')
      await page.locator('[data-settings-search-id="showArticleThumbnails"]').click()
      await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="showArticleThumbnails"] input')).toBeChecked()
      await page.locator('.settings-search-clear').click()
      await page.locator('.reader-font-size-select').selectOption('19')
      await page.screenshot({ path: 'test-results/desktop-appearance-settings-150.png' })
      await page.locator('.settings-back-button').click()
      await expect(page.locator('.article-body')).toContainText('Body 0')
      expect(await fontSize(page.locator('.article-body'))).toBe(19)
      expect(await fontSize(row(page, data.ids[0]!).locator('.article-title-copy strong').first())).toBe(18.75)
      await page.locator('.translation-button').click()
      await expect(page.locator('.translated-article-body')).toContainText('译文：')
      expect(await fontSize(page.locator('.translated-article-body'))).toBe(19)
      await page.locator('.list-translation-options').click()
      const dialog = page.locator('.translation-target-dialog')
      await expect(dialog).toBeVisible()
      expect(await dialog.evaluate(element => element.closest('.app-shell') === null)).toBe(true)
      expect(await fontSize(dialog.locator('.dialog-header h2'))).toBe(25.5)
      await dialog.locator('.dialog-close').click()
      expect(await page.evaluate(async () => {
        const settings = await window.origread.getSettings()
        return [settings.sourcePaneWidth, settings.articlePaneWidth, settings.workspaceWidth]
      })).toEqual(widths)
      // Persist a second layout/theme as well, then verify in a fresh Electron process.
      await page.evaluate(() => window.origread.updateSettings({ theme: 'dark', layoutMode: 'two-pane' }))
    })
    await withDesktop(userDataDir, async page => {
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
      const settings = await page.evaluate(() => window.origread.getSettings())
      expect(settings).toMatchObject({ uiFontScale: 150, showArticleThumbnails: true, readerFontSize: 19 })
      expect(await fontSize(page.locator('.article-title-copy strong').first())).toBe(18.75)
      await expect(page.locator('.article-thumbnail').first()).toBeVisible()
      await page.locator('.source-switcher-trigger').click()
      await expect(page.locator('.source-switcher-copy strong').first()).toBeVisible()
      expect(await fontSize(page.locator('.source-switcher-copy strong').first())).toBe(17.25)
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 920, height: 760 })
      await page.locator('.settings-button').click()
      await expect(page.locator('.ui-font-scale-select')).toBeInViewport()
      await page.screenshot({ path: 'test-results/desktop-appearance-narrow-150.png' })
      await page.locator('.settings-back-button').click()
      await page.setViewportSize({ width: 2560, height: 1440 })
      await page.screenshot({ path: 'test-results/desktop-appearance-two-pane-dark-2k.png' })
    })
  } finally { await fixture.close() }
})

test('缩略图正常、相对、慢速、404及非图片响应保持布局和行交互', async ({ userDataDir }) => {
  const fixture = await appearanceFixture()
  try {
    await withDesktop(userDataDir, async page => {
      const data = await seed(page, fixture.baseUrl)
      expect(data.bodies).toBe(false)
      expect(fixture.hits.get('/good.svg') ?? 0).toBe(0)
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
      await page.locator('.settings-back-button').click()
      const good = row(page, data.ids[0]!)
      const slow = row(page, data.ids[2]!)
      const failed = row(page, data.ids[3]!)
      const notImage = row(page, data.ids[4]!)
      await expect.poll(() => good.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
      await expect(row(page, data.ids[1]!).locator('.article-thumbnail')).toHaveCount(0)
      await expect(row(page, data.ids[6]!).locator('.article-thumbnail')).toHaveCount(0)
      await expect(failed.locator('.article-thumbnail-failed')).toBeVisible()
      await expect(notImage.locator('.article-thumbnail-failed')).toBeVisible()
      await expect(row(page, data.ids[5]!).locator('.article-thumbnail img')).toHaveAttribute('src', fixture.baseUrl + '/good.svg?relative=5')
      const before = await slow.boundingBox()
      expect(await slow.locator('.article-thumbnail').evaluate(element => {
        const rect = element.getBoundingClientRect()
        return [rect.width, rect.height]
      })).toEqual([80, 60])
      await expect.poll(() => fixture.hits.get('/slow.svg') ?? 0).toBeGreaterThan(0)
      fixture.releaseImages()
      await expect.poll(() => slow.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
      expect((await slow.boundingBox())!.height).toBe(before!.height)
      expect(await failed.locator('.article-thumbnail').evaluate(element => {
        const rect = element.getBoundingClientRect()
        return [rect.width, rect.height]
      })).toEqual([80, 60])
      expect(fixture.articleRequests()).toBe(0)
      await good.locator('.star-button').click()
      await expect(good.locator('.star-button')).toHaveClass(/active/)
      await expect(good).not.toHaveClass(/selected/)
      await good.locator('.article-thumbnail').click()
      await expect(good).toHaveClass(/selected/)
      await expect(page.locator('.article-body')).toContainText('Body 0')
      await good.locator('.article-thumbnail').click({ button: 'right' })
      await expect(page.locator('.desktop-context-menu')).toBeVisible()
      await page.keyboard.press('Escape')
      fixture.repairImage()
      await page.locator('.article-pane .refresh-all-button').click()
      await expect(failed.locator('.article-thumbnail img')).toHaveAttribute('src', fixture.baseUrl + '/good.svg?changed=1')
      await expect.poll(() => failed.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
      await page.screenshot({ path: 'test-results/desktop-appearance-thumbnails.png' })
    })
  } finally { await fixture.close() }
})

test('1200条列表在字号、图片、宽度和双语变化后保留中部锚点并限制DOM', async ({ userDataDir }) => {
  test.setTimeout(120_000)
  const fixture = await appearanceFixture()
  try {
    await withDesktop(userDataDir, async page => {
      const data = await seed(page, fixture.baseUrl, true)
      expect(data.count).toBe(1200)
      expect(data.bodies).toBe(false)
      expect(data.bytes).toBeLessThan(1_800_000)
      const list = page.locator('.article-list')
      // Cache multiple offscreen regions before testing global invalidation.
      for (const top of [0, 9000, 19000, 45000]) {
        await list.evaluate((element, top) => { element.scrollTop = top }, top)
        await frames(page, 5)
      }
      const middle = await anchor(list)
      await row(page, middle.id).click()
      await expect(page.locator('.article-body')).toBeVisible()
      const selected = await page.locator('.article-item.selected').getAttribute('data-article-id')
      await page.locator('.settings-button').click()
      let position = await anchor(list)
      await page.locator('.ui-font-scale-select').selectOption('150')
      await expect.poll(() => page.evaluate(async () => (await window.origread.getSettings()).uiFontScale)).toBe(150)
      await expectAnchor(page, list, position)
      position = await anchor(list)
      await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
      await expect.poll(() => list.locator('.article-thumbnail').count()).toBeGreaterThan(0)
      await expectAnchor(page, list, position)
      expect(await list.locator('.article-thumbnail img').count()).toBeLessThan(40)
      for (const key of ['Home', 'End']) {
        position = await anchor(list)
        await page.locator('.pane-divider-article').press(key)
        await expectAnchor(page, list, position)
      }
      await page.locator('.settings-back-button').click()
      expect(await page.locator('.article-item.selected').getAttribute('data-article-id')).toBe(selected)
      position = await anchor(list)
      await page.locator('.list-translation-main').click()
      await expect.poll(fixture.translationCalls).toBeGreaterThan(0)
      await expect(page.locator('.list-translation-status')).toHaveCount(0, { timeout: 30_000 })
      await expect(list.locator('.article-title-translation').first()).toBeVisible()
      await expectAnchor(page, list, position)
      const calls = fixture.translationCalls()
      for (const mode of ['TRANSLATED', 'BILINGUAL'] as const) {
        position = await anchor(list)
        await page.evaluate(displayMode => window.origread.updateTranslationSettings({ displayMode }), mode)
        await expect.poll(() => list.locator('.article-title-translation').count())
          [mode === 'TRANSLATED' ? 'toBe' : 'toBeGreaterThan'](0)
        await expectAnchor(page, list, position)
      }
      expect(fixture.translationCalls()).toBe(calls)
      await page.screenshot({ path: 'test-results/desktop-appearance-long-list-bilingual.png' })
      await page.locator('.reader-content').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('j')
      await expect(list.locator('.article-item.selected')).toBeInViewport()
      await page.locator('.article-pane .search-field input').fill('Appearance article 0042')
      await expect(list.locator('.article-item').first()).toContainText('Appearance article 0042')
      await page.locator('.article-pane .search-field input').fill('')
      await expect(list.locator('.article-item').first()).toContainText('Appearance article 0000')
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
      expect(await list.locator('.article-item').count()).toBeLessThan(40)
    })
  } finally { await fixture.close() }
})


test('较晚的滚底操作优先于旧测量快照，切换未读范围后不会回到列表头', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const fixture = await appearanceFixture()
  try {
    await withDesktop(userDataDir, async page => {
      const data = await seed(page, fixture.baseUrl, true)
      const list = page.locator('.article-list')
      const scrollToEndDuringFrame = () => list.evaluate(element => new Promise<void>(resolve =>
        requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; resolve() })))
      await row(page, data.ids[0]!).locator('.star-button').click()
      await scrollToEndDuringFrame()
      await expect(row(page, data.ids[1199]!)).toBeInViewport()
      await row(page, data.ids[1199]!).click()
      await expect(page.locator('.article-body')).toContainText('Body 1199')
      await page.locator('.reader-content').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('k')
      await expect(page.locator('.article-body')).toContainText('Body 1198')
      // Each scope change discards previous measurements. A later animation-frame
      // scroll must win even when a head-row measurement is awaiting its commit.
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.locator('.article-destination-item').nth(2).click()
        await expect(list.locator('.article-item')).toHaveCount(1)
        await page.locator('.article-destination-item').nth(1).click()
        await expect(list.locator('.article-item').first()).toContainText('Appearance article 0000')
        await expect.poll(() => list.evaluate(element => element.scrollHeight)).toBeGreaterThan(50_000)
        await scrollToEndDuringFrame()
        await expect(row(page, data.ids[1197]!), 'unread tail after scope switch ' + attempt).toBeInViewport()
        expect(await list.locator('.article-item').count()).toBeLessThan(40)
      }
    })
  } finally { await fixture.close() }
})
