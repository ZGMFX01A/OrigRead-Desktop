import { createServer, type IncomingMessage, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

interface AiRequestBody {
  messages?: Array<{ role?: string; content?: string }>
}

test('Reader AI persists up to five extra articles and freezes each request context', async () => {
  test.setTimeout(60_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    const ids = await page.evaluate(async ({ baseUrl, feedUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'multi-article-model',
        models: ['multi-article-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      const articles = (await window.origread.listArticles(100)).filter((item) => item.feedId === added.feedId)
      const current = articles.find((item) => item.title === 'Current Context Article')
      const attached = articles.find((item) => item.title === 'Attached Context Article')
      if (!current || !attached) throw new Error('Fixture articles missing')
      return { currentId: current.id, attachedId: attached.id }
    }, { baseUrl: fixture.baseUrl, feedUrl: `${fixture.baseUrl}/feed.xml` })

    await page.reload()
    await page.locator(`.article-item[data-article-id="${ids.currentId}"]`).click()
    await expect(page.locator('.article-body')).toContainText('CURRENT_CONTEXT_MARKER')
    await page.keyboard.press('a')

    const attachButton = page.locator('.reader-ai-article-picker-trigger')
    await attachButton.click()
    const picker = page.locator('.reader-ai-article-picker-popover')
    await expect(picker).toBeVisible()
    await picker.locator('.reader-ai-article-picker-search input').fill('Attached Context')
    await expect(picker.locator('.reader-ai-article-picker-list > button').first()).toContainText('Attached Context Article')
    await picker.evaluate((element) => {
      const button = element.querySelector<HTMLButtonElement>('.reader-ai-article-picker-list > button')
      if (!button || !button.textContent?.includes('Attached Context Article')) throw new Error('Attached article choice missing')
      button.click()
    })
    await expect(page.locator('.reader-ai-article-attachment')).toContainText('Attached Context Article')

    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('Compare the attached context.')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Multi article response')
    expect(fixture.aiRequests).toHaveLength(1)
    const firstSystem = systemMessage(fixture.aiRequests[0]!)
    expect(firstSystem).toContain('CURRENT_CONTEXT_MARKER')
    expect(firstSystem).toContain('ATTACHED_CONTEXT_MARKER')
    expect(firstSystem.indexOf('CURRENT_CONTEXT_MARKER')).toBeLessThan(firstSystem.indexOf('ATTACHED_CONTEXT_MARKER'))

    const firstSnapshot = await page.evaluate(async (currentId) => {
      const conversation = (await window.origread.listLlmConversations(currentId))[0]
      if (!conversation) throw new Error('Conversation missing')
      const attachedArticles = await window.origread.getLlmConversationArticles(conversation.id)
      const messages = await window.origread.getLlmMessages(conversation.id)
      const assistant = messages.filter((item) => item.role === 'ASSISTANT' && item.historyActive).at(-1)
      if (!assistant) throw new Error('Assistant missing')
      return {
        conversationId: conversation.id,
        attachedArticles,
        evidence: await window.origread.getLlmAssistantEvidence(assistant.id)
      }
    }, ids.currentId)
    expect(firstSnapshot.attachedArticles.map((item) => item.articleId)).toEqual([ids.attachedId])
    const articleRefs = firstSnapshot.evidence.contextRefs.filter((ref) => ref.type === 'ARTICLE')
    expect(articleRefs.map((ref) => ref.articleId)).toEqual(
      expect.arrayContaining([ids.currentId, ids.attachedId])
    )
    expect(articleRefs.find((ref) => ref.articleId === ids.currentId)?.priority).toBe(10_000)
    expect(articleRefs.find((ref) => ref.articleId === ids.attachedId)?.priority).toBe(9_000)

    await attachButton.click()
    await expect(picker).toBeHidden()
    await page.locator('.reader-ai-article-attachment').getByRole('button').click()
    await expect(page.locator('.reader-ai-article-attachment')).toHaveCount(0)
    await composer.fill('Now use only active context.')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Multi article response')
    expect(fixture.aiRequests).toHaveLength(2)
    expect(systemMessage(fixture.aiRequests[1]!)).toContain('CURRENT_CONTEXT_MARKER')
    expect(systemMessage(fixture.aiRequests[1]!)).not.toContain('ATTACHED_CONTEXT_MARKER')

    const afterRemoval = await page.evaluate(async ({ conversationId, firstAssistantId }) => {
      const attachedArticles = await window.origread.getLlmConversationArticles(conversationId)
      const oldEvidence = await window.origread.getLlmAssistantEvidence(firstAssistantId)
      return { attachedArticles, oldEvidence }
    }, {
      conversationId: firstSnapshot.conversationId,
      firstAssistantId: firstSnapshot.evidence.contextRefs[0]?.assistantMessageId ?? ''
    })
    expect(afterRemoval.attachedArticles).toHaveLength(0)
    expect(afterRemoval.oldEvidence.contextRefs.some((ref) => ref.articleId === ids.attachedId)).toBe(true)

    // Re-attaching persists at Conversation level and survives opening the same conversation again.
    await attachButton.click()
    await picker.locator('.reader-ai-article-picker-search input').fill('Attached Context')
    await picker.locator('.reader-ai-article-picker-list > button').filter({ hasText: 'Attached Context Article' }).evaluate((element: HTMLButtonElement) => element.click())
    await expect(page.locator('.reader-ai-article-attachment')).toContainText('Attached Context Article')
    await attachButton.click()
    await expect(picker).toBeHidden()
    await page.getByRole('button', { name: '对话历史' }).click()
    await page.locator('.reader-ai-history-item').first().click()
    await expect(page.locator('.reader-ai-article-attachment')).toContainText('Attached Context Article')
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

function systemMessage(body: AiRequestBody): string {
  return body.messages?.find((message) => message.role === 'system')?.content ?? ''
}

async function startFixture(): Promise<{ server: Server; baseUrl: string; aiRequests: AiRequestBody[] }> {
  const aiRequests: AiRequestBody[] = []
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Multi Context E2E</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Current Context Article</title><link>http://127.0.0.1/current</link><guid>multi-current</guid><description><![CDATA[<h2>Current</h2><p>CURRENT_CONTEXT_MARKER is the canonical current article evidence.</p>]]></description></item>
<item><title>Attached Context Article</title><link>http://127.0.0.1/attached</link><guid>multi-attached</guid><description><![CDATA[<h2>Attached</h2><p>ATTACHED_CONTEXT_MARKER is evidence from the additional article.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      void readJson<AiRequestBody>(request).then((body) => {
        aiRequests.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Multi article response' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }).catch(() => response.writeHead(400).end())
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not expose a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, aiRequests }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse(await readText(request)) as T
}

async function readText(request: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
