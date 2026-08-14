import { createServer, type Server } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('hidden Chromium executes page JavaScript and feeds rendered DOM into the normal website parser', async () => {
  const server = await startDynamicFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const url = `http://127.0.0.1:${address.port}/dynamic-news`
  const testApp = await launchIsolatedOrigRead()
  const electronApp = testApp.app

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const result = await page.evaluate(async (targetUrl) => {
      return window.origread.inspectWebsiteDynamic(targetUrl)
    }, url)

    expect(result.finalUrl).toContain('/dynamic-news')
    expect(result.candidate.articles).toHaveLength(5)
    expect(result.candidate.articles.map((article) => article.title)).toEqual([
      '动态渲染后的新闻文章一',
      '动态渲染后的新闻文章二',
      '动态渲染后的新闻文章三',
      '动态渲染后的新闻文章四',
      '动态渲染后的新闻文章五'
    ])
    expect(result.candidate.rule.id).toMatch(/^auto-dom:/)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startDynamicFixtureServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><title>Dynamic OrigRead Fixture</title></head>
        <body>
          <main><section id="stream"></section></main>
          <script>
            setTimeout(() => {
              const stream = document.getElementById('stream');
              stream.innerHTML = [1, 2, 3, 4, 5].map((id) =>
                '<article class="news-card"><h2><a class="headline" href="/article/' + id + '">动态渲染后的新闻文章' + ['一','二','三','四','五'][id - 1] + '</a></h2><time datetime="2026-08-14T10:0' + id + ':00+08:00"></time></article>'
              ).join('');
            }, 150);
          </script>
        </body>
      </html>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

