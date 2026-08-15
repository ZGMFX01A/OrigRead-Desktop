import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('reader generates AI summary and full-article translation through main-process providers', async () => {
  const fixture = await startFixtureServer()
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const base = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, aiEndpoint, dlxEndpoint }) => {
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Missing default AI provider')
      await window.origread.updateAiProvider({
        id: provider.id,
        enabled: true,
        endpoint: aiEndpoint,
        defaultModel: 'mock-model',
        models: ['mock-model'],
        apiKey: 'ai-e2e-secret'
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id, outputLanguage: 'zh-CN' })

      await window.origread.updateTranslationProvider({ type: 'DLX', enabled: true, endpoint: dlxEndpoint })
      await window.origread.updateTranslationSettings({
        targetLanguage: 'zh-CN',
        displayMode: 'TRANSLATED',
        defaultTarget: { type: 'traditional', provider: 'DLX' }
      })

      const added = await window.origread.addRssSource(feedUrl)
      const articles = await window.origread.listArticles(100)
      const article = articles.find((item) => item.feedId === added.feedId && item.title === 'OrigRead AI E2E Article 1')
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, {
      feedUrl: `${base}/feed.xml`,
      aiEndpoint: `${base}/v1`,
      dlxEndpoint: `${base}/dlx`
    })

    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()

    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Original full article body one')

    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.ai-summary-view')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.ai-summary-markdown')).toContainText('核心结论')
    await expect(page.locator('.ai-summary-markdown')).toContainText('第一项关键事实')
    await expect(page.locator('.ai-reasoning')).toContainText('mock reasoning')
    expect(fixture.aiRequests()).toBeGreaterThan(0)

    await page.locator('.translation-button').click()
    await expect(page.locator('.translated-article-body')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.translated-article-body')).toContainText('译文：')
    expect(fixture.translationRequests()).toBeGreaterThan(0)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function startFixtureServer(): Promise<{ server: Server; aiRequests: () => number; translationRequests: () => number }> {
  let aiRequests = 0
  let translationRequests = 0
  const server = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(rssXml(`http://${request.headers.host}`))
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      aiRequests += 1
      await readBody(request)
      if (request.headers.authorization !== 'Bearer ai-e2e-secret') {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { message: 'missing fixture authorization' } }))
        return
      }
      json(response, {
        choices: [{
          message: {
            content: '## 摘要\n核心结论来自本地 Mock。\n\n## 主要内容\n1. **第一项关键事实。** 这是用于 Electron Reader E2E 的结构化摘要。',
            reasoning_content: 'mock reasoning'
          }
        }]
      })
      return
    }
    if (request.url === '/v1/models') {
      json(response, { data: [{ id: 'mock-model' }] })
      return
    }
    if (request.url === '/dlx' && request.method === 'POST') {
      translationRequests += 1
      const body = JSON.parse(await readBody(request)) as { text?: string }
      json(response, { data: `译文：${body.text ?? ''}` })
      return
    }
    if (request.url?.startsWith('/article/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><article><h1>Article</h1><p>Fallback article page content.</p></article></body></html>')
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, aiRequests: () => aiRequests, translationRequests: () => translationRequests }
}

function rssXml(base: string): string {
  const items = Array.from({ length: 10 }, (_, index) => `
    <item>
      <guid>ai-e2e-${index + 1}</guid>
      <title>OrigRead AI E2E Article ${index + 1}</title>
      <link>${base}/article/${index + 1}</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 14, 10, index)).toUTCString()}</pubDate>
      <description>AI translation fixture summary ${index + 1}</description>
      <content:encoded><![CDATA[
        <p>Original full article body one ${index + 1}. This paragraph is intentionally substantial enough for AI summary and translation validation.</p>
        <p>Original full article body two ${index + 1}. It carries a second block so the translation content processor must preserve block structure.</p>
      ]]></content:encoded>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel>
        <title>OrigRead AI E2E Feed</title>
        <link>${base}</link>
        <description>AI and translation fixture</description>
        ${items}
      </channel>
    </rss>`
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

