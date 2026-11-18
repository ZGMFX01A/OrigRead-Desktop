import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import type { OrigReadDesktopApi } from '../../src/shared/contracts'

interface DesktopSession {
  readonly app: ElectronApplication
  readonly page: Page
  readonly pageErrors: string[]
}

const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const userDataDir = await mkdtemp(join(resultsRoot, 'desktop-reading-history-regression-'))
    try {
      await use(userDataDir)
    } finally {
      await rm(userDataDir, { recursive: true })
    }
  }
})

async function withDesktop<T>(userDataDir: string, inspect: (session: DesktopSession) => Promise<T>): Promise<T> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
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
    await expect(page.locator('.app-shell')).toBeVisible()
    return await inspect({ app, page, pageErrors })
  } finally {
    await app.close()
  }
}

function createRegressionRssXml(newerCount = 200): string {
  const now = Date.now()
  // 较早的文章（发布于 2 小时前），用于验证在 200 篇新未读干扰下 read Tab 是否仍能检索到
  const earlierDate = new Date(now - 7_200_000).toUTCString()
  const earlierItem = `<item>
    <guid>guid-earlier-read-regression</guid>
    <title>Earlier Read Article Regression Target</title>
    <link>https://fixture.invalid/earlier-read</link>
    <pubDate>${earlierDate}</pubDate>
    <description>Earlier read description text</description>
    <content:encoded><![CDATA[<p>Earlier read body content.</p>]]></content:encoded>
  </item>`

  // 200 篇较新的文章（发布于最近 200 秒），默认保持未读
  const newerItems = Array.from({ length: newerCount }, (_, i) => {
    const pubDate = new Date(now - (newerCount - i) * 1_000).toUTCString()
    return `<item>
      <guid>guid-newer-unread-${i}</guid>
      <title>Newer Unread Article ${i}</title>
      <link>https://fixture.invalid/newer-${i}</link>
      <pubDate>${pubDate}</pubDate>
      <description>Newer unread description ${i}</description>
      <content:encoded><![CDATA[<p>Newer body content ${i}</p>]]></content:encoded>
    </item>`
  }).join('')

  return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel>
      <title>Reading History Regression Feed</title>
      <link>https://fixture.invalid</link>
      <description>Regression feed for read tab and recent reading history</description>
      ${newerItems}
      ${earlierItem}
    </channel>
  </rss>`
}

test('已读与最近阅读桌面专项回归：200篇新未读检索较早已读、打开重开重排、标未读留存与清空防回填', async ({ userDataDir }) => {
  test.setTimeout(90_000)

  const server: Server = createServer((request, response) => {
    if (request.url !== '/feed.xml') {
      response.writeHead(404).end()
      return
    }
    response.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
    response.end(createRegressionRssXml(200))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`

  try {
    // 阶段一：订阅 200 篇新未读 + 1 篇较早已读，验证 read Tab 与最近阅读交互
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      // 1. 添加本地 RSS 订阅源并同步抓取 201 篇文章
      await page.evaluate(async (url) => {
        const api: OrigReadDesktopApi = window.origread
        for (const feed of await api.listFeeds()) await api.deleteFeed(feed.id)
        await api.addRssSource(url)
      }, feedUrl)

      // 2. 将较早的文章设为已读（模拟已有 1 篇已读，而后接收了 200 篇新未读的场景）
      await page.evaluate(async (titleKeyword) => {
        const api: OrigReadDesktopApi = window.origread
        const articles = await api.listArticles(300)
        const earlier = articles.find((a) => a.title.includes(titleKeyword))
        if (!earlier) throw new Error(`Earlier article not found for title: ${titleKeyword}, total: ${articles.length}`)
        await api.setArticleUnread(earlier.id, false)
      }, 'Earlier Read Article Regression Target')

      // 重新载入页面以刷新全部计数与数据状态
      await page.reload()
      await expect(page.locator('.app-shell')).toBeVisible()

      const readTab = page.locator('.article-destination-item[data-destination="read"]')
      const unreadTab = page.locator('.article-destination-item[data-destination="unread"]')
      const recentTab = page.locator('.article-destination-item[data-destination="recent"]')

      // 验证未读数与已读数
      await expect(unreadTab.locator('strong')).toHaveText('200')
      await expect(readTab.locator('strong')).toHaveText('1')

      // 3. 验收点：即使有 200 篇新未读（超过默认 200 条分页上限），read Tab 依然必须找到较早已读文章
      await readTab.click()
      const earlierItem = page.locator('.article-item', { hasText: 'Earlier Read Article Regression Target' })
      await expect(earlierItem).toBeVisible()
      await expect(page.locator('.article-item')).toHaveCount(1)

      // 4. 切回 unread 列表，真实打开至少两篇文章
      await unreadTab.click()
      const article199 = page.locator('.article-item', { hasText: 'Newer Unread Article 199' })
      const article198 = page.locator('.article-item', { hasText: 'Newer Unread Article 198' })
      await expect(article199).toBeVisible()
      await expect(article198).toBeVisible()

      // 打开 Article 199
      await article199.click()
      await expect(page.locator('.reader-pane')).toContainText('Newer Unread Article 199')
      await expect.poll(() => recentTab.locator('strong').textContent()).toBe('1')

      // 稍作等待确保 openedAt 具有明确时间差，再打开 Article 198
      await page.waitForTimeout(60)
      await article198.click()
      await expect(page.locator('.reader-pane')).toContainText('Newer Unread Article 198')
      await expect.poll(() => recentTab.locator('strong').textContent()).toBe('2')

      // 进入 Recent 视图：后打开的 Article 198 应排在首位，先打开的 Article 199 排在第二
      await recentTab.click()
      await expect(page.locator('.article-item').nth(0)).toContainText('Newer Unread Article 198')
      await expect(page.locator('.article-item').nth(1)).toContainText('Newer Unread Article 199')

      // 5. 验收点：重开 Article 199，recent 应按最新的 lastOpenedAt 倒序重排
      await page.waitForTimeout(60)
      await page.locator('.article-item', { hasText: 'Newer Unread Article 199' }).click()
      await expect(page.locator('.reader-pane')).toContainText('Newer Unread Article 199')
      await expect.poll(() => page.locator('.article-item').nth(0).textContent()).toContain('Newer Unread Article 199')
      await expect.poll(() => page.locator('.article-item').nth(1).textContent()).toContain('Newer Unread Article 198')

      // 6. 验收点：在最近阅读中将文章标为未读，文章仍在 history 中，且视觉与数据更新为 unread
      await page.locator('.article-item', { hasText: 'Newer Unread Article 199' }).click({ button: 'right' })
      const contextMenu = page.locator('.desktop-context-menu')
      await expect(contextMenu).toBeVisible()
      await contextMenu.locator('[role="menuitem"]').first().click()

      // Article 199 仍在 recent 列表中，但状态变为 unread
      await expect(page.locator('.article-item', { hasText: 'Newer Unread Article 199' })).toBeVisible()
      await expect(page.locator('.article-item', { hasText: 'Newer Unread Article 199' })).toHaveClass(/unread/)
      await expect(page.locator('.article-item', { hasText: 'Newer Unread Article 198' })).toHaveClass(/read/)
      await expect(page.locator('.article-item')).toHaveCount(2)
      await expect(recentTab.locator('strong')).toHaveText('2')

      expect(pageErrors).toEqual([])
    })

    // 阶段二：真实重启应用，验证 recent 顺序与未读状态持久化；随后清空历史，验证刷新不回填
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      const recentTab = page.locator('.article-destination-item[data-destination="recent"]')
      await recentTab.click()

      // 重启后仍然按 lastOpenedAt 倒序排列，且保留未读状态
      await expect(recentTab.locator('strong')).toHaveText('2')
      await expect(page.locator('.article-item').nth(0)).toContainText('Newer Unread Article 199')
      await expect(page.locator('.article-item').nth(1)).toContainText('Newer Unread Article 198')
      await expect(page.locator('.article-item', { hasText: 'Newer Unread Article 199' })).toHaveClass(/unread/)
      await expect(page.locator('.article-item', { hasText: 'Newer Unread Article 198' })).toHaveClass(/read/)

      // 7. 验收点：clear 当前账户后清空
      page.once('dialog', (dialog) => {
        void dialog.accept()
      })
      await page.locator('.clear-history-button').click()

      await expect(recentTab.locator('strong')).toHaveText('0')
      await expect(page.locator('.article-item')).toHaveCount(0)
      await expect(page.locator('.clear-history-button')).toBeDisabled()

      // 8. 验收点：刷新不回填
      await page.locator('.refresh-all-button').click()
      await expect(page.locator('.article-pane')).toHaveAttribute('aria-busy', 'false')
      await expect(recentTab.locator('strong')).toHaveText('0')
      await expect(page.locator('.article-item')).toHaveCount(0)

      await page.reload()
      await expect(page.locator('.app-shell')).toBeVisible()
      await page.locator('.article-destination-item[data-destination="recent"]').click()
      await expect(page.locator('.article-destination-item[data-destination="recent"] strong')).toHaveText('0')
      await expect(page.locator('.article-item')).toHaveCount(0)

      expect(pageErrors).toEqual([])
    })

    // 阶段三：再次真实重启应用，验证重启后绝对不回填
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      const recentTab = page.locator('.article-destination-item[data-destination="recent"]')
      await recentTab.click()
      await expect(recentTab.locator('strong')).toHaveText('0')
      await expect(page.locator('.article-item')).toHaveCount(0)

      expect(pageErrors).toEqual([])
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
