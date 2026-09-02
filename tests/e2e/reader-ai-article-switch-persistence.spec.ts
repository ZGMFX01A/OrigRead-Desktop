import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader AI restores the persisted article conversation after switching away and back', async () => {
  test.setTimeout(30_000)
  const server = await startFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const { articleAId, articleBId } = await page.evaluate(async ({ baseUrl }) => {
      const feedA = await window.origread.addRssSource(`${baseUrl}/feed-a.xml`)
      const feedB = await window.origread.addRssSource(`${baseUrl}/feed-b.xml`)
      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'fixture-chat-model',
        models: ['fixture-chat-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      const articles = await window.origread.listArticles(100)
      const articleA = articles.find((item) => item.feedId === feedA.feedId)
      const articleB = articles.find((item) => item.feedId === feedB.feedId)
      if (!articleA || !articleB) throw new Error('Fixture articles were not saved')
      return { articleAId: articleA.id, articleBId: articleB.id }
    }, { baseUrl })

    await page.reload()
    const articleA = page.locator(`.article-item[data-article-id="${articleAId}"]`)
    const articleB = page.locator(`.article-item[data-article-id="${articleBId}"]`)
    await expect(articleA).toBeVisible()
    await expect(articleB).toBeVisible()

    await articleA.click()
    await page.keyboard.press('a')
    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('Remember this conversation')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('Remember this conversation')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Saved answer')

    const persistedBeforeSwitch = await page.evaluate(async (articleId) => {
      const conversation = (await window.origread.listLlmConversations(articleId))[0]
      if (!conversation) throw new Error('Conversation was not persisted')
      return {
        conversationId: conversation.id,
        messageIds: (await window.origread.getLlmMessages(conversation.id)).map((message) => message.id)
      }
    }, articleAId)
    expect(persistedBeforeSwitch.messageIds).toHaveLength(2)

    await articleB.click()
    await expect(page.locator('.reader-ai-panel')).toBeVisible()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.locator('.reader-ai-user-bubble')).toHaveCount(0)

    await articleA.click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('Remember this conversation')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Saved answer')

    const persistedAfterSwitch = await page.evaluate(async (articleId) => {
      const conversations = await window.origread.listLlmConversations(articleId)
      const conversation = conversations[0]
      if (!conversation) throw new Error('Conversation disappeared after article switch')
      return {
        conversationId: conversation.id,
        messageIds: (await window.origread.getLlmMessages(conversation.id)).map((message) => message.id)
      }
    }, articleAId)
    expect(persistedAfterSwitch).toEqual(persistedBeforeSwitch)

    await page.locator('.reader-ai-panel').getByRole('button', { name: '关闭' }).click()
    await articleB.click()
    await articleA.click()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('Remember this conversation')

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleAId}"]`).click()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('Remember this conversation')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Saved answer')
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFixtureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/feed-a.xml' || request.url === '/feed-b.xml') {
      const isA = request.url === '/feed-a.xml'
      const suffix = isA ? 'A' : 'B'
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Reader AI ${suffix}</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Reader AI Article ${suffix}</title><link>http://127.0.0.1/article-${suffix.toLowerCase()}</link><guid>reader-ai-article-${suffix.toLowerCase()}</guid><description><![CDATA[<h2>Results</h2><p>Article ${suffix} evidence paragraph.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Saved answer [[E2]]' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
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
