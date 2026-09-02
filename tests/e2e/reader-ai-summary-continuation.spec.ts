import { createServer, type IncomingMessage, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Summary continues into the same Reader AI timeline without hiding the artifact or re-feeding it as model context', async () => {
  test.setTimeout(30_000)
  const server = await startFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, baseUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'd7-summary-chat-model',
        models: ['d7-summary-chat-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id, outputLanguage: 'zh-CN' })
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { feedUrl: `${baseUrl}/feed.xml`, baseUrl })

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Original fact 1 for D7.4')

    await page.locator('.ai-summary-button').click()
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.ai-summary-panel-body')).toContainText('D7.4 summary body', { timeout: 15_000 })
    await expect(page.locator('.ai-summary-panel-body .ai-reasoning')).toContainText('D7.4 summary reasoning')

    const completedOrder = await page.locator('.ai-summary-panel-body').evaluate((body) => {
      const reasoning = body.querySelector('.ai-reasoning')
      const summary = body.querySelector('.ai-summary-markdown')
      if (!reasoning || !summary) return false
      return Boolean(reasoning.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(completedOrder).toBe(true)

    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(0)
    await page.getByRole('button', { name: '继续提问' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')

    const artifact = page.locator('.reader-ai-summary-artifact')
    await expect(artifact).toBeVisible()
    await expect(artifact).toHaveJSProperty('open', true)
    await expect(artifact).toContainText('D7.4 summary reasoning')
    await expect(artifact).toContainText('D7.4 summary body')
    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await expect(composer).toBeFocused()
    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(0)

    await composer.fill('Follow up from summary, but answer from the original article.')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Follow-up answer from original article', { timeout: 15_000 })
    await expect(artifact).toHaveJSProperty('open', false)

    const conversationSnapshot = await page.evaluate(async (id) => {
      const conversations = await window.origread.listLlmConversations(id)
      const conversation = conversations[0]
      if (!conversation) throw new Error('Chat conversation was not created')
      const messages = await window.origread.getLlmMessages(conversation.id)
      const assistant = messages.filter((message) => message.role === 'ASSISTANT').at(-1)
      if (!assistant) throw new Error('Assistant message is missing')
      return {
        messages,
        evidence: await window.origread.getLlmAssistantEvidence(assistant.id)
      }
    }, articleId)
    expect(conversationSnapshot.messages).toHaveLength(2)
    expect(conversationSnapshot.messages.some((message) => message.content.includes('D7.4 summary body'))).toBe(false)
    expect(conversationSnapshot.evidence.contextRefs.some((ref) => ref.type === 'ARTICLE' && ref.includedInPrompt)).toBe(true)
    expect(conversationSnapshot.evidence.contextRefs.some((ref) => ref.type === 'ARTICLE_SUMMARY' || ref.type === 'ARTICLE_TRANSLATION')).toBe(false)

    await artifact.locator('> summary').click()
    await expect(artifact).toHaveJSProperty('open', true)
    await expect(artifact).toContainText('D7.4 summary reasoning')
    await expect(artifact).toContainText('D7.4 summary body')
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFixtureServer(): Promise<Server> {
  const substantialText = Array.from({ length: 90 }, (_value, index) => `Original fact ${index + 1} for D7.4 summary continuation. `).join('')
  const server = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>D7.4 Summary Chat</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>D7.4 Summary Continuation</title><link>http://127.0.0.1/article</link><guid>d7-summary-continuation</guid><description><![CDATA[<h2>Original evidence</h2><p>${substantialText}</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      const body = await readBody(request)
      const isChat = body.includes('Follow up from summary')
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      const reasoning = isChat ? 'checking original article' : 'D7.4 summary reasoning'
      const content = isChat
        ? 'Follow-up answer from original article.'
        : '<!-- origread-summary-v2: {"v":2,"form":"report","domain":"technology"} -->\nD7.4 summary body with preserved artifact.'
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
