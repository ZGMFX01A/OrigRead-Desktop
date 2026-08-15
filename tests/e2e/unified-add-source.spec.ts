import { createServer, type Server } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('add-source dialog discovers, ranks, subscribes and refreshes through the unified source flow', async () => {
  const fixture = await startFeedServer()
  const { server } = fixture
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const feedUrl = `${baseUrl}/feed.xml`
  const testApp = await launchIsolatedOrigRead()
  const electronApp = testApp.app

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('workspace-collapsed'))) {
      await page.locator('.collapse-handle').click()
      await expect(page.locator('.workspace-pane')).toBeVisible()
    }

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await expect(page.locator('.source-dialog')).toBeVisible()
    await page.locator('.dialog-field input').fill(feedUrl)
    await page.locator('.dialog-submit').click()

    const candidate = page.locator('.source-candidate').first()
    await expect(candidate).toBeVisible({ timeout: 15_000 })
    await expect(candidate.locator('.candidate-kind')).toContainText('RSS')
    await expect(candidate.locator('.candidate-main strong')).toHaveText('OrigRead E2E Feed')
    await expect(candidate.locator('.candidate-stats')).toContainText(/30/)

    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    await expect.poll(async () => {
      const feeds = await page.evaluate(() => window.origread.listFeeds())
      return feeds.some((feed) => feed.url === feedUrl && feed.name === 'OrigRead E2E Feed')
    }).toBe(true)

    const articleList = page.locator('.article-list')
    await expect(articleList).toBeVisible()
    const listMetrics = await articleList.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))
    expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight)
    await articleList.evaluate((element) => { element.scrollTop = 240 })
    await expect.poll(() => articleList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await articleList.evaluate((element) => { element.scrollTop = 0 })

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
    await expect(page.locator('.full-content-button')).toBeEnabled()
    await expect(page.locator('.full-content-button')).toHaveClass(/active/)
    const readerContent = page.locator('.reader-content')
    const readerMetrics = await readerContent.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))
    expect(readerMetrics.scrollHeight).toBeGreaterThan(readerMetrics.clientHeight)
    await readerContent.evaluate((element) => { element.scrollTop = 300 })
    await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const articleImage = page.locator('.article-body img').first()
    await expect(articleImage).toBeVisible()
    await expect(articleImage).toHaveAttribute('src', `${baseUrl}/image/1.png`)
    await expect.poll(() => articleImage.evaluate((element) => {
      const image = element as HTMLImageElement
      return image.complete ? image.naturalWidth : 0
    })).toBeGreaterThan(0)

    await page.keyboard.press('Control+f')
    await expect(page.locator('.reader-search-bar')).toBeVisible()
    await page.locator('.reader-search-bar input').fill('OrigRead')
    await expect.poll(() => page.locator('mark.reader-search-match').count()).toBeGreaterThan(0)
    await expect(page.locator('mark.reader-search-match.current')).toHaveCount(1)
    await page.locator('.reader-search-bar input').press('Enter')
    await expect(page.locator('mark.reader-search-match.current')).toHaveCount(1)
    await page.locator('.reader-search-bar input').press('Escape')
    await expect(page.locator('.reader-search-bar')).toBeHidden()

    await page.locator('.full-content-button').click()
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(page.locator('.full-content-button')).not.toHaveClass(/active/)

    const articleRequestsBeforeOriginal = fixture.articleRequests()
    await page.locator('.original-button').click()
    await expect.poll(() => fixture.articleRequests()).toBeGreaterThan(articleRequestsBeforeOriginal)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
    await expect(page.locator('.reader-mode-button')).toBeVisible()
    await page.locator('.reader-mode-button').click()
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(false)
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(page.locator('.full-content-button')).not.toHaveClass(/active/)

    await page.evaluate(async (feedId) => {
      const groups = await window.origread.addGroup('E2E 分组')
      const group = groups.find((item) => item.name === 'E2E 分组')
      if (!group) throw new Error('E2E group was not created')
      await window.origread.updateFeedSettings(feedId, { groupId: group.id })
    }, currentFixture!.feedId)
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.locator('.destination-tabs button').last().click()
    await expect(page.locator('.source-group-header').filter({ hasText: 'E2E 分组' })).toBeVisible()
    const sourceItem = page.locator('.source-item').filter({ hasText: feedUrl })
    await sourceItem.click()
    await expect(page.locator('.active-source-filter')).toContainText('OrigRead E2E Feed')
    await expect(page.locator('.article-list')).toBeVisible()
    await expect.poll(async () => page.locator('.article-item').evaluateAll((items, feedId) => items.length > 0 && items.every((item) => item.getAttribute('data-feed-id') === feedId), currentFixture!.feedId)).toBe(true)

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
    const imageMatch = request.url?.match(/^\/image\/(\d+)\.png$/)
    if (imageMatch) {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
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
  const items = Array.from({ length: 30 }, (_, index) => `
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
          <img src="/image/${id}.png" alt="OrigRead E2E image ${id}">
          <p>OrigRead extracted full text article ${id}. ${'This paragraph contains useful full article text for deterministic Readability extraction and desktop reader validation. '.repeat(18)}</p>
          <p>${'The second paragraph keeps the fixture article-like, long enough for content scoring, sanitizing, caching, rendering, and real reader scrolling checks. '.repeat(18)}</p>
          <a href="/related/${id}">Related reading</a>
        </article>
      </body>
    </html>`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

