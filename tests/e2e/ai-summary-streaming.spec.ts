import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('AI summary streams reasoning and body through Main IPC before final completion', async () => {
  test.setTimeout(30_000)
  const server = await startFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const feedUrl = `${baseUrl}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const subscribed = await page.evaluate(async ({ feedUrl, baseUrl }) => {
      const discovery = await window.origread.discoverSource(feedUrl, 'ai-summary-stream-e2e')
      const candidate = discovery.candidates.find((item) => item.kind === 'RSS_DIRECT') ?? discovery.candidates[0]
      if (!candidate) throw new Error(discovery.error || 'No RSS candidate')
      await window.origread.subscribeSource(discovery.discoveryId, [candidate.id])

      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'fixture-model',
        models: ['fixture-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id, outputLanguage: 'zh-CN' })
      return { providerId: provider.id }
    }, { feedUrl, baseUrl })

    await expect.poll(async () => page.evaluate(async (targetFeedUrl) => {
      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === targetFeedUrl)
      if (!feed) return null
      return (await window.origread.listArticles(100)).find((item) => item.feedId === feed.id)?.id ?? null
    }, feedUrl)).not.toBeNull()
    const articleId = await page.evaluate(async (targetFeedUrl) => {
      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === targetFeedUrl)
      if (!feed) throw new Error('Fixture feed was not persisted')
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === feed.id)
      if (!article) throw new Error('Fixture article was not persisted')
      return article.id
    }, feedUrl)

    const rendererPerfLogs: Array<Record<string, unknown>> = []
    page.on('console', (message) => {
      const text = message.text()
      const prefix = '[OrigRead][AI Perf] '
      if (!text.startsWith(prefix)) return
      try {
        rendererPerfLogs.push(JSON.parse(text.slice(prefix.length)) as Record<string, unknown>)
      } catch {
        // Ignore unrelated/malformed console lines; the assertion below requires the structured metric.
      }
    })

    // 先走真实 Renderer 交互，确保 UI_TTFV 测的是用户实际看到 reasoning/正文，而不是 IPC 到达时间。
    await page.reload()
    const articleItem = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(articleItem).toBeVisible()
    await articleItem.click()
    await expect(page.locator('.article-body')).toContainText('第 1 条事实用于验证桌面端摘要的真实流式链路')
    await page.evaluate((targetArticleId) => {
      const state = globalThis as typeof globalThis & {
        __origreadAiSummaryStreamProbe?: Array<{ summaryPreview: string; reasoningPreview: string }>
      }
      state.__origreadAiSummaryStreamProbe = []
      window.origread.onAiSummaryStreamUpdate((update) => {
        if (update.articleId !== targetArticleId) return
        state.__origreadAiSummaryStreamProbe?.push({
          summaryPreview: update.summaryPreview,
          reasoningPreview: update.reasoningPreview
        })
      })
    }, articleId)
    await expect(page.locator('.ai-summary-button')).toBeEnabled()
    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.getByRole('button', { name: '生成速览摘要' })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成均衡摘要' })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成深入摘要' })).toBeVisible()
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect.poll(async () => page.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __origreadAiSummaryStreamProbe?: Array<{ summaryPreview: string; reasoningPreview: string }>
      }
      return state.__origreadAiSummaryStreamProbe?.some((update) => update.reasoningPreview.includes('正在分析证据')) ?? false
    })).toBe(true)
    await expect.poll(() => rendererPerfLogs.find((entry) => entry.metric === 'UI_TTFV') ?? null).not.toBeNull()
    const uiTtfv = rendererPerfLogs.find((entry) => entry.metric === 'UI_TTFV')
    expect(uiTtfv).toMatchObject({ task: 'summary', metric: 'UI_TTFV', first_visible: 'reasoning' })
    expect(Number(uiTtfv?.UI_TTFV_ms)).toBeGreaterThan(0)
    await expect(page.locator('.ai-summary-panel-body')).toContainText('这是实时摘要')
    await expect(page.locator('.ai-summary-panel-body')).toContainText('第二段内容。')
    await expect(page.locator('.regenerate-button')).toBeVisible()

    const result = await page.evaluate(async ({ articleId, providerId }) => {
      const updates: Array<{ summaryPreview: string; reasoningPreview: string }> = []
      const unsubscribe = window.origread.onAiSummaryStreamUpdate((update) => {
        if (update.articleId === articleId) {
          updates.push({ summaryPreview: update.summaryPreview, reasoningPreview: update.reasoningPreview })
        }
      })
      try {
        const document = await window.origread.summarizeArticle(articleId, true, {
          providerId,
          model: 'fixture-model',
          length: 'STANDARD'
        })
        return { updates, document }
      } finally {
        unsubscribe()
      }
    }, { articleId, providerId: subscribed.providerId })

    expect(result.updates.some((update) => update.reasoningPreview.includes('正在分析证据'))).toBe(true)
    expect(result.updates.some((update) => update.summaryPreview.includes('这是实时摘要'))).toBe(true)
    expect(result.updates.every((update) => !update.summaryPreview.includes('origread-summary-v2'))).toBe(true)
    expect(result.document).toMatchObject({
      status: 'GENERATED',
      articleForm: 'news',
      domain: 'technology',
      summary: '这是实时摘要，第二段内容。',
      reasoning: '正在分析证据…'
    })
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFixtureServer(): Promise<Server> {
  const substantialText = Array.from({ length: 90 }, (_value, index) => `第 ${index + 1} 条事实用于验证桌面端摘要的真实流式链路。`).join('')
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>AI Summary E2E</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Streaming summary article</title><link>http://127.0.0.1/article</link><guid>streaming-summary-article</guid><description><![CDATA[<h2>背景</h2><p>${substantialText}</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '正在分析证据…' }, finish_reason: null }] })}\n\n`)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '<!-- origread-summary-v2: {"v":2,' }, finish_reason: null }] })}\n\n`)
      }, 150)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"form":"news","domain":"technology"} -->\n这是实时摘要' }, finish_reason: null }] })}\n\n`)
      }, 650)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，第二段内容。' }, finish_reason: null }] })}\n\n`)
      }, 950)
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }, 1_300)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
