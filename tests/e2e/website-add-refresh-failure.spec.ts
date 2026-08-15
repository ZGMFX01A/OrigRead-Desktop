import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('website subscription remains added when the immediate post-subscribe refresh returns HTTP 418', async () => {
  const fixture = await startWebsiteFixtureServer()
  const server = fixture.server
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const sourceUrl = `http://127.0.0.1:${address.port}/news`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('workspace-collapsed'))) {
      await page.locator('.collapse-handle').click()
    }

    await page.locator('.primary-action').click()
    await page.locator('.dialog-field input').fill(sourceUrl)
    await page.locator('.dialog-submit').click()
    const candidate = page.locator('.source-candidate').filter({ hasText: '网站' }).first()
    await expect(candidate).toBeVisible({ timeout: 20_000 })

    fixture.setRejectRefresh(true)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })
    expect(fixture.rejectedRequests()).toBeGreaterThan(0)

    await expect.poll(async () => page.evaluate(async (url) => {
      return (await window.origread.listFeeds()).filter((feed) => feed.url === url).length
    }, sourceUrl)).toBe(1)

    await page.locator('.destination-tabs button').last().click()
    const sourceItem = page.locator('.source-item').filter({ hasText: sourceUrl })
    await expect(sourceItem).toBeVisible()
    await expect(sourceItem).toContainText('WEBSITE')
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

test('website article full content renders its external HTTP image in the reader', async () => {
  const fixture = await startWebsiteFixtureServer()
  const server = fixture.server
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const sourceUrl = `${baseUrl}/news`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('workspace-collapsed'))) {
      await page.locator('.collapse-handle').click()
    }

    await page.locator('.primary-action').click()
    await page.locator('.dialog-field input').fill(sourceUrl)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-candidate').filter({ hasText: '网站' }).first()).toBeVisible({ timeout: 20_000 })
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    const article = page.locator('.article-item').filter({ hasText: '原读完成正文提取能力升级' })
    await expect(article).toBeVisible({ timeout: 10_000 })
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Website full content fixture', { timeout: 15_000 })

    const image = page.locator('.article-body img').first()
    await expect(image).toHaveAttribute('src', `${baseUrl}/asset/site.png`)
    await expect.poll(() => image.evaluate((element) => {
      const target = element as HTMLImageElement
      return target.complete ? target.naturalWidth : 0
    })).toBeGreaterThan(0)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startWebsiteFixtureServer(): Promise<{ server: Server; setRejectRefresh(value: boolean): void; rejectedRequests(): number }> {
  let rejectRefresh = false
  let rejectedRequests = 0
  const html = readFileSync(join(process.cwd(), 'tests/fixtures/website-samples/url-clusters.html'), 'utf8')
  const server = createServer((request, response) => {
    if (request.url === '/news') {
      if (rejectRefresh) {
        rejectedRequests += 1
        response.writeHead(418, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('fixture rejects immediate refresh')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    if (request.url?.startsWith('/news/2026/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html><head><title>Website article fixture</title></head><body><article><h1>Website article fixture</h1><img src="/asset/site.png" alt="site fixture"><p>Website full content fixture. ${'This is deterministic website article content used to validate extraction and image loading. '.repeat(25)}</p></article></body></html>`)
      return
    }
    if (request.url === '/asset/site.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await listen(server)
  return {
    server,
    setRejectRefresh(value: boolean) { rejectRefresh = value },
    rejectedRequests: () => rejectedRequests
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
