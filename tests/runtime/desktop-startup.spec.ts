import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { _electron, expect, test as base, type Page } from '@playwright/test'
import type { OrigReadDesktopApi } from '../../src/shared/contracts'

// 新本地账户包含默认分组和发行订阅，后台同步关闭时尚无文章。
const INITIAL_LIBRARY_COUNTS = { groups: 1, feeds: 1, articles: 0, unread: 0, starred: 0 }

interface DesktopSession {
  readonly page: Page
  readonly pageErrors: string[]
}

// 每个用例独立使用真实数据库，结束后仅删除自己创建的临时数据。
const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const userDataDir = await mkdtemp(join(resultsRoot, 'desktop-startup-'))
    try {
      await use(userDataDir)
    } finally {
      await rm(userDataDir, { recursive: true })
    }
  }
})

/** 使用实际生产构建启动 Electron；继承完整系统环境以支持原生窗口和系统路径。 */
async function withDesktop<T>(userDataDir: string, inspect: (session: DesktopSession) => Promise<T>): Promise<T> {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const app = await _electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1',
      ORIGREAD_DISABLE_PERIODIC_SYNC: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    return await inspect({ page, pageErrors })
  } finally {
    await app.close()
  }
}

/** 窗口显示后通过正式 preload/IPC 读取真实 SQLite，避免仅有空白窗口也通过。 */
async function inspectStartup(session: DesktopSession) {
  await expect(session.page.locator('.app-shell')).toBeVisible()
  await expect(session.page.locator('.article-pane')).toBeVisible()
  await expect(session.page.locator('.reader-pane')).toBeVisible()
  const state = await session.page.evaluate(async () => {
    const api: OrigReadDesktopApi = window.origread
    return {
      info: await api.getAppInfo(),
      accounts: await api.getAccounts(),
      snapshot: await api.getLibrarySnapshot(),
      feeds: (await api.listFeeds()).map((feed) => ({ id: feed.id, url: feed.url, sourceType: feed.sourceType }))
    }
  })
  expect(state.info.platform).toBe(process.platform)
  expect(state.info.version).toMatch(/^\d+\.\d+\.\d+/)
  expect(state.snapshot).toEqual(INITIAL_LIBRARY_COUNTS)
  expect(session.pageErrors).toEqual([])
  return state
}

test('生产构建的窗口、preload、IPC 和真实数据库正常启动', async ({ userDataDir }) => {
  await withDesktop(userDataDir, inspectStartup)
})

test('实际关闭重启后账户和默认订阅身份保持且没有重复', async ({ userDataDir }) => {
  const before = await withDesktop(userDataDir, inspectStartup)
  const after = await withDesktop(userDataDir, inspectStartup)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.snapshot).toEqual(before.snapshot)
  expect(after.feeds).toEqual(before.feeds)
})

test('大列表限制 DOM 和 IPC 体积，滚动末尾仍能阅读与键盘切换', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const count = 1_200
  const now = Date.now()
  const items = Array.from({ length: count }, (_, index) => `<item><guid>large-${index}</guid><title>Large article ${index}${index % 3 === 0 ? ' — A longer title that wraps across multiple lines in the article pane'.repeat(2) : ''}</title>
    <link>https://fixture.invalid/large/${index}</link><pubDate>${new Date(now - index * 1_000).toUTCString()}</pubDate>
    <description>Preview ${index}</description><content:encoded><![CDATA[<p>Body ${index}</p><p>${'Long body text. '.repeat(700)}</p>]]></content:encoded></item>`).join('')
  const server = createServer((request, response) => {
    if (request.url !== '/feed') { response.writeHead(404).end(); return }
    response.setHeader('Content-Type', 'application/rss+xml')
    response.end(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Large list fixture</title>
      <link>https://fixture.invalid</link><description>Large list test</description>${items}</channel></rss>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      await expect(page.locator('.app-shell')).toBeVisible()
      const payload = await page.evaluate(async url => {
        const source = await window.origread.addRssSource(url)
        const articles = await window.origread.listArticlesByFeed(source.feedId)
        return { count: articles.length, bytes: JSON.stringify(articles).length,
          bodies: articles.some(article => article.contentHtml !== null || article.fullContentHtml !== null) }
      }, `http://127.0.0.1:${address.port}/feed`)
      expect(payload.count).toBe(count)
      expect(payload.bodies).toBe(false)
      expect(payload.bytes).toBeLessThan(1_000_000)
      await page.reload()
      await page.setViewportSize({ width: 1428, height: 890 })
      await page.locator('.source-item[title="Large list fixture"]').click()
      const list = page.locator('.article-list')
      const rows = list.locator('.article-item')
      await expect(rows.first()).toContainText('Large article 0')
      await expect.poll(() => rows.count()).toBeLessThan(40)
      await list.evaluate(element => { element.scrollTop = element.scrollHeight })
      const last = list.locator('.article-item', { hasText: 'Large article 1199' })
      await expect(last).toBeInViewport()
      await page.setViewportSize({ width: 1000, height: 700 })
      await list.evaluate(element => { element.scrollTop = element.scrollHeight })
      await expect(last).toBeInViewport()
      await page.setViewportSize({ width: 1428, height: 890 })
      await expect.poll(() => rows.count()).toBeLessThan(40)
      await last.click()
      await expect(page.locator('.article-body')).toContainText('Body 1199')
      await page.locator('.reader-content').click({ position: { x: 20, y: 20 } })
      await page.keyboard.press('k')
      await expect(page.locator('.article-body')).toContainText('Body 1198')
      await expect(list.locator('.article-item.selected')).toBeInViewport()
      // Debounced search and external clear must reset the scroll window.
      await page.locator('.article-pane .search-field input').fill('Large article 42')
      await expect(rows.first()).toContainText('Large article 42')
      await page.locator('.article-pane .search-field input').fill('')
      await expect(rows.first()).toContainText('Large article 0')
      await rows.first().locator('.star-button').click()
      await page.locator('.article-destination-item').nth(2).click()
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('Large article 0')
      await page.locator('.article-destination-item').nth(1).click()
      await expect(rows.first()).toContainText('Large article 0')
      await list.evaluate(element => { element.scrollTop = element.scrollHeight })
      const unreadTail = list.locator('.article-item', { hasText: 'Large article 1197' })
      await expect(unreadTail).toBeInViewport()
      await unreadTail.click()
      await expect(page.locator('.article-body')).toContainText('Body 1197')
      await page.locator('.article-destination-item').nth(0).click()
      await expect(rows.first()).toContainText('Large article 0')
      expect(pageErrors).toEqual([])
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('列表翻译位于计数行，模式切换与重启只读本地，停止中断实际请求', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  let translations = 0
  let slow = false
  const server = createServer(async (request, response) => {
    if (request.url === '/feed') {
      response.setHeader('Content-Type', 'application/rss+xml')
      response.end('<rss version="2.0"><channel><title>Translation fixture</title><link>https://fixture.invalid</link><description>Local test</description><item><guid>translation-fixture-article</guid><title>Screening demo title</title><link>https://fixture.invalid/article</link><description><![CDATA[<p>Article preview for screening.</p><p>Second paragraph for body translation.</p>]]></description></item></channel></rss>')
      return
    }
    if (request.url !== '/translate') { response.writeHead(404).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body) as { text: string }
    translations++
    const send = (): void => { if (!response.destroyed) response.setHeader('Content-Type', 'application/json').end(JSON.stringify({ data: `译:${input.text}` })) }
    if (!slow) send()
    else {
      const timer = setTimeout(send, 5_000)
      response.once('close', () => clearTimeout(timer))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test HTTP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      await expect(page.locator('.article-pane')).toBeVisible()
      await page.evaluate(async baseUrl => {
        await window.origread.updateTranslationProvider({ type: 'DLX', enabled: true, endpoint: `${baseUrl}/translate` })
        await window.origread.updateTranslationSettings({ defaultTarget: { type: 'traditional', provider: 'DLX' }, targetLanguage: 'zh-CN', displayMode: 'TRANSLATED' })
        await window.origread.addRssSource(`${baseUrl}/feed`)
      }, baseUrl)
      await page.reload()
      const title = page.locator('.article-title-copy strong').first()
      await expect(title).toHaveText('Screening demo title')
      const action = page.locator('.list-meta .list-translation-main')
      await expect(action).toBeEnabled()
      await expect(page.locator('.list-translation-status')).toHaveCount(0)
      expect(translations).toBe(0)
      await action.click()
      await expect(title).toHaveText('译:Screening demo title')
      await expect(page.locator('.list-translation-status')).toHaveCount(0)
      const calls = translations
      await page.evaluate(() => window.origread.updateTranslationSettings({ displayMode: 'BILINGUAL' }))
      await expect(page.locator('.article-title-translation').first()).toHaveText('译:Screening demo title')
      await expect(title).toHaveText('Screening demo title')
      expect(translations).toBe(calls)
      const meta = await page.locator('.article-pane .list-meta').boundingBox()
      const button = await action.boundingBox()
      const refresh = await page.locator('.list-meta .refresh-all-button').boundingBox()
      expect(meta && button && refresh).toBeTruthy()
      expect(button!.x).toBeGreaterThan(meta!.x)
      expect(button!.x + button!.width).toBeLessThanOrEqual(refresh!.x)
      await page.screenshot({ path: 'test-results/desktop-list-translation.png' })
      await page.locator('.article-item').first().click()
      await expect(page.locator('.translation-button')).toBeEnabled()
      await page.locator('.translation-button').click()
      await expect(page.locator('.translated-article-body')).toBeVisible()
      await expect(page.locator('.translated-article-body')).toContainText('译:')
      expect(pageErrors).toEqual([])
    })
    const beforeRestart = translations
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      await expect(page.locator('.article-title-translation').first()).toHaveText('译:Screening demo title')
      await page.locator('.article-item').first().click()
      await expect(page.locator('.translated-article-body')).toBeVisible()
      expect(translations).toBe(beforeRestart)
      await page.setViewportSize({ width: 920, height: 760 })
      // Narrow/two-pane mode must retain the list action; return from the reader if collapsed.
      await page.setViewportSize({ width: 1428, height: 890 })
      slow = true
      await page.evaluate(() => window.origread.updateTranslationSettings({ targetLanguage: 'ja' }))
      await expect(page.locator('.article-title-translation')).toHaveCount(0)
      await page.locator('.list-translation-main').click()
      await expect(page.locator('.list-translation-status')).toBeVisible()
      await expect.poll(() => translations).toBeGreaterThan(beforeRestart)
      await page.locator('.list-translation-main').click()
      await expect(page.locator('.list-translation-status')).toHaveCount(0)
      await expect(page.locator('.list-translation-main svg')).toBeVisible()
      expect(pageErrors).toEqual([])
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
