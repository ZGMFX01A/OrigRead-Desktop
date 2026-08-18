import { createServer, type Server } from 'node:http'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('a 470-item RSS remains fully visible in feed scope even though the global window is 200', async () => {
  test.setTimeout(45_000)
  const fixture = await startFixtureServer(470, false)
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await addSource(page, feedUrl)

    const databaseState = await page.evaluate(async (url) => {
      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === url)
      if (!feed) return null
      const [globalArticles, scopedArticles, stats] = await Promise.all([
        window.origread.listArticles(),
        window.origread.listArticlesByFeed(feed.id),
        window.origread.listFeedArticleStats()
      ])
      return {
        feedId: feed.id,
        globalCount: globalArticles.length,
        scopedCount: scopedArticles.length,
        stats: stats.find((item) => item.feedId === feed.id) ?? null
      }
    }, feedUrl)
    expect(databaseState).toMatchObject({
      globalCount: 200,
      scopedCount: 470,
      stats: { total: 470, unread: 470, starred: 0 }
    })

    await page.locator('.scope-picker-button').click()
    const sourceRow = page.locator('.source-item').filter({ hasText: 'Large Scope Feed' })
    await expect(sourceRow).toContainText('470')
    await sourceRow.click()

    await expect.poll(() => page.locator('.article-item').count()).toBe(470)
    await expect(page.locator('.list-meta')).toContainText('470')
    await expect(page.locator('.article-scope-bar')).toContainText('Large Scope Feed')

    const requestsBeforeRefresh = fixture.feedRequests()
    await page.locator('.refresh-all-button').click()
    await expect.poll(() => fixture.feedRequests()).toBeGreaterThan(requestsBeforeRefresh)
    await expect.poll(() => page.locator('.article-item').count()).toBe(470)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

test('direct RSS discovery still exposes a WordPress JSON channel from the same site', async () => {
  test.setTimeout(45_000)
  const fixture = await startFixtureServer(9, true)
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await openSourceDiscovery(page, feedUrl)

    const candidates = page.locator('.source-candidate')
    await expect(candidates).toHaveCount(2, { timeout: 15_000 })
    await expect(candidates.filter({ has: page.locator('.candidate-kind', { hasText: 'RSS' }) })).toHaveCount(1)
    await expect(candidates.filter({ has: page.locator('.candidate-kind', { hasText: 'JSON' }) })).toHaveCount(1)
    await expect(page.locator('.source-dialog')).toContainText('WordPress')
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function addSource(page: Page, feedUrl: string): Promise<void> {
  await openSourceDiscovery(page, feedUrl)
  await page.locator('.dialog-submit').click()
  await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })
}

async function openSourceDiscovery(page: Page, feedUrl: string): Promise<void> {
  await page.locator('.subscription-menu-anchor .primary-action').click()
  await page.getByRole('menuitem', { name: '添加来源' }).click()
  await expect(page.locator('.source-dialog')).toBeVisible()
  await page.locator('.dialog-field input').fill(feedUrl)
  await page.locator('.dialog-submit').click()
  await expect(page.locator('.source-candidate').first()).toBeVisible({ timeout: 15_000 })
}

async function startFixtureServer(itemCount: number, wordpress: boolean): Promise<{ server: Server; feedRequests: () => number }> {
  let feedRequests = 0
  const server = createServer((request, response) => {
    const base = `http://${request.headers.host}`
    if (request.url === '/feed.xml') {
      feedRequests += 1
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(rssXml(base, itemCount))
      return
    }
    if (request.url?.startsWith('/wp-json/wp/v2/posts')) {
      if (!wordpress) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        link: `${base}/article/json-${index + 1}`,
        date_gmt: `2026-08-${String(18 - index).padStart(2, '0')}T08:00:00`,
        title: { rendered: `WordPress JSON Article ${index + 1}` },
        content: { rendered: `<p>JSON article ${index + 1} body</p>` }
      }))))
      return
    }
    if (request.url === '/' || request.url === '') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><title>Large Scope Site</title></head><body><main>Fixture site</main></body></html>')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, feedRequests: () => feedRequests }
}

function rssXml(base: string, itemCount: number): string {
  const items = Array.from({ length: itemCount }, (_, index) => `
    <item>
      <guid>scope-${index + 1}</guid>
      <title>Large Scope Article ${index + 1}</title>
      <link>${base}/article/${index + 1}</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 18, 8, 0, 0) - index * 60_000).toUTCString()}</pubDate>
      <description>Large Scope Article ${index + 1} summary</description>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Large Scope Feed</title>
        <link>${base}/</link>
        <description>Large scope regression fixture</description>
        ${items}
      </channel>
    </rss>`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
