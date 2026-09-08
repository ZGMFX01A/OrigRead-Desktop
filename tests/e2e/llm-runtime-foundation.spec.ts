import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('LLM foundation crosses Main/Preload IPC and persists article evidence citations', async () => {
  test.setTimeout(30_000)
  let completionRequestBody = ''
  const server = await startFixtureServer((body) => { completionRequestBody = body })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const feedUrl = `${baseUrl}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const article = await page.evaluate(async ({ feedUrl, baseUrl }) => {
      const discovery = await window.origread.discoverSource(feedUrl, 'llm-foundation-e2e')
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
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })

      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === feedUrl)
      if (!feed) throw new Error('Fixture feed was not persisted')
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === feed.id)
      if (!article) throw new Error('Fixture article was not persisted')
      return { id: article.id, title: article.title, url: article.url }
    }, { feedUrl, baseUrl })

    const result = await page.evaluate(async (article) => {
      const conversation = await window.origread.createLlmConversation({
        title: 'Evidence test',
        articleId: article.id,
        articleTitle: article.title,
        articleLink: article.url
      })
      await window.origread.appendLlmUserMessage({
        conversationId: conversation.id,
        content: 'What changed?',
        requestTask: 'CHAT'
      })

      const events: Array<{ type: string; finishReason?: string }> = []
      let resolveTerminal: (() => void) | null = null
      const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
      const unsubscribe = window.origread.onLlmExecutionEvent((event) => {
        events.push({ type: event.type, ...('finishReason' in event ? { finishReason: event.finishReason } : {}) })
        if (event.type === 'TERMINAL' || event.type === 'ERROR') resolveTerminal?.()
      })
      const identity = await window.origread.startLlmExecution({
        requestId: 'llm-runtime-foundation-request',
        conversationId: conversation.id,
        profile: { model: 'fixture-model' }
      })
      await Promise.race([
        terminal,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('LLM terminal event timeout')), 8_000))
      ])
      unsubscribe()

      return {
        identity,
        events,
        messages: await window.origread.getLlmMessages(conversation.id),
        evidence: await window.origread.getLlmAssistantEvidence(identity.assistantMessageId)
      }
    }, article)

    expect(result.events.map((event) => event.type)).toEqual([
      'STARTED', 'REASONING_DELTA', 'CONTENT_DELTA', 'TERMINAL'
    ])
    expect(result.events.at(-1)).toMatchObject({ type: 'TERMINAL', finishReason: 'STOP' })
    expect(result.messages.at(-1)).toMatchObject({
      id: result.identity.assistantMessageId,
      role: 'ASSISTANT',
      content: 'Revenue rose',
      reasoning: 'checking article',
      status: 'COMPLETE',
      finishReason: 'STOP'
    })
    expect(result.evidence.contextRefs).toHaveLength(1)
    expect(result.evidence.evidenceBlocks.map((block) => block.textSnapshot)).toEqual([
      'Results',
      'Revenue rose by 20 percent.'
    ])
    expect(result.evidence.citations).toMatchObject([
      { protocolId: 'E2', displayOrder: 1, quoteSnapshot: 'Revenue rose by 20 percent.' }
    ])

    const providerRequest = JSON.parse(completionRequestBody) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(providerRequest.messages[0]?.role).toBe('system')
    expect(providerRequest.messages[0]?.content).toContain('[ORIGREAD_EVIDENCE id="E1"]')
    expect(providerRequest.messages[0]?.content).toContain('[ORIGREAD_EVIDENCE id="E2"]')
    expect(providerRequest.messages.at(-1)).toEqual({ role: 'user', content: 'What changed?' })
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFixtureServer(onCompletionBody: (body: string) => void): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>LLM Foundation</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Evidence article</title><link>http://127.0.0.1/article</link><guid>llm-evidence-article</guid><description><![CDATA[<h2>Results</h2><p>Revenue rose by 20 percent.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        onCompletionBody(body)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking article' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Revenue rose [[E2]]' }, finish_reason: null }] })}\n\n`)
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
