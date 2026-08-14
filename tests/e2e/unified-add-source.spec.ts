import { createServer, type Server } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('add-source dialog discovers, ranks, subscribes and refreshes through the unified source flow', async () => {
  const fixture = await startFeedServer()
  const { server } = fixture
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`
  const testApp = await launchIsolatedOrigRead()
  const electronApp = testApp.app

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('workspace-collapsed'))) {
      await page.locator('.collapse-handle').click()
      await expect(page.locator('.workspace-pane')).toBeVisible()
    }

    await page.locator('.primary-action').click()
    await expect(page.locator('.source-dialog')).toBeVisible()
    await page.locator('.dialog-field input').fill(feedUrl)
    await page.locator('.dialog-submit').click()

    const candidate = page.locator('.source-candidate').first()
    await expect(candidate).toBeVisible({ timeout: 15_000 })
    await expect(candidate.locator('.candidate-kind')).toContainText('RSS')
    await expect(candidate.locator('.candidate-main strong')).toHaveText('OrigRead E2E Feed')
    await expect(candidate.locator('.candidate-stats')).toContainText(/10/)

    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    await expect.poll(async () => {
      const feeds = await page.evaluate(() => window.origread.listFeeds())
      return feeds.some((feed) => feed.url === feedUrl && feed.name === 'OrigRead E2E Feed')
    }).toBe(true)

    const currentFixture = await page.evaluate(async (targetFeedUrl) => {
      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === targetFeedUrl)
      if (!feed) return null
      const articles = await window.origread.listArticles(1_000)
      const article = articles.find((item) => item.feedId === feed.id && item.title === 'OrigRead E2E Article 1')
      return article ? { feedId: feed.id, articleId: article.id } : null
    }, feedUrl)
    expect(currentFixture).not.toBeNull()
    const article = page.locator(`.article-item[data-article-id="${currentFixture!.articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(page.locator('.original-button')).toBeEnabled()
    await expect(page.locator('.full-content-button')).toBeEnabled()
    await page.locator('.full-content-button').click()
    await expect(page.locator('.article-body')).toContainText('OrigRead extracted full text article 1', { timeout: 15_000 })
    await expect(page.locator('.full-content-button')).toBeDisabled()

    const articleRequestsBeforeOriginal = fixture.articleRequests()
    await page.locator('.original-button').click()
    await expect.poll(() => fixture.articleRequests()).toBeGreaterThan(articleRequestsBeforeOriginal)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
    await expect(page.locator('.reader-mode-button')).toBeVisible()
    await page.locator('.reader-mode-button').click()
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(false)
    await expect(page.locator('.article-body')).toContainText('OrigRead extracted full text article 1')

    await page.locator('.destination-tabs button').last().click()
    const sourceRefresh = page
      .locator('.source-item')
      .filter({ hasText: feedUrl })
      .locator('.source-refresh-button')
    await expect(sourceRefresh).toBeVisible()

    const requestsAfterSubscribe = fixture.feedRequests()
    await sourceRefresh.click()
    await expect.poll(() => fixture.feedRequests()).toBeGreaterThan(requestsAfterSubscribe)

    const requestsAfterSingleRefresh = fixture.feedRequests()
    await page.locator('.refresh-all-button').click()
    await expect.poll(() => fixture.feedRequests()).toBeGreaterThan(requestsAfterSingleRefresh)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFeedServer(): Promise<{ server: Server; feedRequests: () => number; articleRequests: () => number }> {
  let feedRequests = 0
  let articleRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      feedRequests += 1
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(rssXml(`http://${request.headers.host}`))
      return
    }
    const articleMatch = request.url?.match(/^\/article\/(\d+)$/)
    if (articleMatch) {
      articleRequests += 1
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml(Number(articleMatch[1])))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, feedRequests: () => feedRequests, articleRequests: () => articleRequests }
}

function rssXml(baseUrl: string): string {
  const items = Array.from({ length: 10 }, (_, index) => `
    <item>
      <guid>e2e-${index + 1}</guid>
      <title>OrigRead E2E Article ${index + 1}</title>
      <link>${baseUrl}/article/${index + 1}</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 14, 5, 0 - index)).toUTCString()}</pubDate>
      <description>Article ${index + 1} summary</description>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>OrigRead E2E Feed</title>
        <link>https://example.com/e2e</link>
        <description>OrigRead unified discovery fixture</description>
        ${items}
      </channel>
    </rss>`
}

function articleHtml(id: number): string {
  return `<!doctype html>
    <html>
      <head>
        <title>OrigRead E2E Article ${id}</title>
        <meta property="og:title" content="OrigRead E2E Article ${id}">
        <meta name="author" content="OrigRead E2E Author">
      </head>
      <body>
        <nav>Home · Archive · Categories</nav>
        <article>
          <h1>OrigRead E2E Article ${id}</h1>
          <p>OrigRead extracted full text article ${id}. ${'This paragraph contains useful full article text for deterministic Readability extraction and desktop reader validation. '.repeat(8)}</p>
          <p>${'The second paragraph keeps the fixture article-like, long enough for content scoring, sanitizing, caching, and rendering checks. '.repeat(8)}</p>
          <a href="/related/${id}">Related reading</a>
        </article>
      </body>
    </html>`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

