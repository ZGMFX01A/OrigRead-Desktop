import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('website subscription persists discovered articles without a second source request', async () => {
  const fixture = await startWebsiteFixtureServer()
  const server = fixture.server
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const sourceUrl = `http://127.0.0.1:${address.port}/news`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await page.locator('.dialog-field input').fill(sourceUrl)
    await page.locator('.dialog-submit').click()
    const candidate = page.locator('.source-candidate').filter({ hasText: '网站' }).first()
    await expect(candidate).toBeVisible({ timeout: 20_000 })

    fixture.setRejectRefresh(true)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })
    expect(fixture.rejectedRequests()).toBe(0)

    await expect.poll(async () => page.evaluate(async (url) => {
      return (await window.origread.listFeeds()).filter((feed) => feed.url === url).length
    }, sourceUrl)).toBe(1)

    const websiteFeedName = await page.evaluate(async (url) => {
      const feed = (await window.origread.listFeeds()).find((item) => item.url === url)
      return feed?.name ?? ''
    }, sourceUrl)
    expect(websiteFeedName).not.toBe('')
    await expect(page.locator('.article-item').filter({ hasText: '原读完成正文提取能力升级' })).toBeVisible({ timeout: 10_000 })
    const sourceItem = page.locator('.source-item').filter({ hasText: websiteFeedName })
    await expect(sourceItem).toBeVisible()
    await expect(sourceItem).toContainText('WEBSITE')

    // UI-3P.5：先进入该 Website 的 Feed Scope，再由 Article Pane 做单来源刷新。
    // 不用“全部来源”刷新，因为隔离库还包含内置 Release Feed，整批刷新会被外网请求时长影响，
    // 而本用例真正要验证的是 Website 418 是否落到 Article Pane 的错误反馈。
    await sourceItem.click()
    await expect(page.locator('.article-scope-bar')).toContainText(websiteFeedName)
    await page.locator('.refresh-all-button').click()
    await expect(page.locator('.article-list-error')).toContainText('HTTP 418')
    await expect(page.locator('.source-pane .workspace-error')).toHaveCount(0)
    expect(fixture.rejectedRequests()).toBeGreaterThan(0)
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

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await page.locator('.dialog-field input').fill(sourceUrl)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-candidate').filter({ hasText: '网站' }).first()).toBeVisible({ timeout: 20_000 })
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    const article = page.locator('.article-item').filter({ hasText: '原读完成正文提取能力升级' })
    await expect(article).toBeVisible({ timeout: 10_000 })
    await expect(article).toContainText('来源未提供文章简介')
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Website full content fixture', { timeout: 15_000 })

    const image = page.locator('.article-body img').first()
    await expect(image).toHaveAttribute('src', `${baseUrl}/asset/site.png`)
    await expect.poll(() => image.evaluate((element) => {
      const target = element as HTMLImageElement
      return target.complete ? target.naturalWidth : 0
    })).toBeGreaterThan(0)
    expect(fixture.imageReferers()).toContain(`${baseUrl}/`)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startWebsiteFixtureServer(): Promise<{ server: Server; setRejectRefresh(value: boolean): void; rejectedRequests(): number; imageReferers(): string[] }> {
  let rejectRefresh = false
  let rejectedRequests = 0
  const imageReferers: string[] = []
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
      const referer = request.headers.referer ?? ''
      imageReferers.push(referer)
      const expectedReferer = `http://${request.headers.host}/`
      if (referer !== expectedReferer) {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('hotlink protection fixture')
        return
      }
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
    rejectedRequests: () => rejectedRequests,
    imageReferers: () => [...imageReferers]
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
