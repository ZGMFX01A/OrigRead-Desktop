import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('layout roundtrip preserves source scope, destination, reader selection and independent pane geometry', async () => {
  test.setTimeout(45_000)
  const server = await startLayoutFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const feedAUrl = `${baseUrl}/feed-a.xml`
  const feedBUrl = `${baseUrl}/feed-b.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    const fixture = await page.evaluate(async ({ feedAUrl, feedBUrl }) => {
      await window.origread.addRssSource(feedAUrl)
      await window.origread.addRssSource(feedBUrl)
      const groups = await window.origread.addGroup('DL-5 Roundtrip')
      const group = groups.find((item) => item.name === 'DL-5 Roundtrip')
      const feeds = await window.origread.listFeeds()
      const feedA = feeds.find((item) => item.url === feedAUrl)
      const feedB = feeds.find((item) => item.url === feedBUrl)
      if (!group || !feedA || !feedB) throw new Error('Failed to prepare DL-5 feed/group fixture')
      await window.origread.updateFeedSettings(feedA.id, { groupId: group.id })
      const feedAArticles = await window.origread.listArticlesByFeed(feedA.id)
      const target = feedAArticles.find((item) => item.title === 'DL-5 Feed A Article 1')
      if (!target) throw new Error('Failed to find DL-5 target article')
      await window.origread.setArticleUnread(target.id, true)
      await window.origread.setArticleStarred(target.id, true)
      return {
        groupId: group.id,
        groupName: group.name,
        feedAId: feedA.id,
        feedAName: feedA.name,
        feedBId: feedB.id,
        articleId: target.id,
        articleTitle: target.title
      }
    }, { feedAUrl, feedBUrl })

    // 直接通过 preload 建立隔离测试数据后 reload，让 Renderer 走真实首屏加载链路。
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')

    const targetGroup = page.locator('.source-group-scope').filter({ hasText: fixture.groupName })
    await expect(targetGroup).toBeVisible()
    await targetGroup.click()
    await expect(targetGroup).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.article-scope-copy strong')).toHaveText(fixture.groupName)

    const targetFeed = page.locator(`.source-item[data-feed-id="${fixture.feedAId}"]`)
    if (await targetFeed.count()) {
      await targetFeed.click()
    } else {
      // Source item 当前没有 data-feed-id；使用标题精确锁定，避免依赖列表顺序。
      await page.locator('.source-item').filter({ hasText: fixture.feedAName }).click()
    }
    await expect(page.locator('.source-item').filter({ hasText: fixture.feedAName })).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.article-scope-copy strong')).toHaveText(fixture.feedAName)

    const starredDestination = page.locator('.article-destination-item').filter({ hasText: '星标' })
    await starredDestination.click()
    await expect(starredDestination).toHaveAttribute('aria-current', 'page')

    const targetArticle = page.locator(`.article-item[data-article-id="${fixture.articleId}"]`)
    await expect(targetArticle).toBeVisible()
    await targetArticle.click()
    await expect(targetArticle).toHaveClass(/selected/)
    await expect(page.locator('.article-heading h1')).toContainText(fixture.articleTitle)

    // 三栏宽度改成非默认值，后续验证双栏 Workspace 调整不会覆盖这两个持久化值。
    await page.locator('.pane-divider-source').focus()
    await page.keyboard.press('End')
    await page.locator('.pane-divider-article').focus()
    await page.keyboard.press('End')
    await expect.poll(async () => {
      const settings = await page.evaluate(() => window.origread.getSettings())
      return [settings.sourcePaneWidth, settings.articlePaneWidth]
    }).toEqual([320, 480])

    // Settings 打开状态直接切双栏，同时启用深色模式；Reader / Scope / Filter 不得重置。
    await page.locator('.settings-button').click()
    await page.locator('.theme-select').selectOption('dark')
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.locator('.settings-close-button').click()

    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-scope-copy strong')).toHaveText(fixture.feedAName)
    await expect(page.locator('.article-destination-item').filter({ hasText: '星标' })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator(`.article-item[data-article-id="${fixture.articleId}"]`)).toHaveClass(/selected/)
    await expect(page.locator('.article-heading h1')).toContainText(fixture.articleTitle)

    const workspaceDivider = page.locator('.pane-divider-workspace')
    await workspaceDivider.focus()
    await page.keyboard.press('End')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).workspaceWidth).toBe(560)

    const sourcePicker = page.locator('.two-pane-source-picker-button')
    await sourcePicker.click()
    const sourcePickerOverlay = page.locator('.two-pane-source-picker-overlay')
    await expect(sourcePickerOverlay).toBeVisible()
    await expect(sourcePickerOverlay.locator('.source-item').filter({ hasText: fixture.feedAName })).toHaveAttribute('aria-current', 'true')
    await page.keyboard.press('Escape')
    await expect(sourcePickerOverlay).toHaveCount(0)

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await page.locator('.settings-close-button').click()

    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.article-scope-copy strong')).toHaveText(fixture.feedAName)
    await expect(page.locator('.article-destination-item').filter({ hasText: '星标' })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator(`.article-item[data-article-id="${fixture.articleId}"]`)).toHaveClass(/selected/)
    await expect(page.locator('.article-heading h1')).toContainText(fixture.articleTitle)

    const finalSettings = await page.evaluate(() => window.origread.getSettings())
    expect(finalSettings).toMatchObject({
      layoutMode: 'three-pane',
      workspaceWidth: 560,
      sourcePaneWidth: 320,
      articlePaneWidth: 480,
      theme: 'dark'
    })
    const finalGeometry = await page.evaluate(() => ({
      source: document.querySelector('.source-pane')?.getBoundingClientRect().width ?? 0,
      article: document.querySelector('.article-pane')?.getBoundingClientRect().width ?? 0
    }))
    expect(finalGeometry.source).toBeGreaterThanOrEqual(319)
    expect(finalGeometry.source).toBeLessThanOrEqual(321)
    expect(finalGeometry.article).toBeGreaterThanOrEqual(479)
    expect(finalGeometry.article).toBeLessThanOrEqual(481)
  } finally {
    await testApp.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function startLayoutFixtureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    const host = request.headers.host ?? '127.0.0.1'
    const base = `http://${host}`
    if (request.url === '/feed-a.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(feedXml(base, 'A'))
      return
    }
    if (request.url === '/feed-b.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(feedXml(base, 'B'))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

function feedXml(base: string, suffix: 'A' | 'B'): string {
  const items = Array.from({ length: 3 }, (_, index) => {
    const number = index + 1
    return `
      <item>
        <title>DL-5 Feed ${suffix} Article ${number}</title>
        <link>${base}/${suffix.toLowerCase()}/article-${number}</link>
        <guid>${base}/${suffix.toLowerCase()}/article-${number}</guid>
        <pubDate>${new Date(Date.UTC(2026, 7, 26, 8, number)).toUTCString()}</pubDate>
        <description>DL-5 ${suffix} article ${number} reader body for layout state roundtrip.</description>
      </item>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>DL-5 Feed ${suffix}</title>
        <link>${base}</link>
        <description>DL-5 layout state fixture ${suffix}</description>
        ${items}
      </channel>
    </rss>`
}
