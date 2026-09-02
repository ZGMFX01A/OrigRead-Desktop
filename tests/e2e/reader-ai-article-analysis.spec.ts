import { createServer, type IncomingMessage, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

interface AiRequestBody {
  messages?: Array<{ role?: string; content?: string }>
  tools?: Array<{ function?: { name?: string } }>
}

test('Article Analysis is a dedicated task with fixed Skill/Search and returns to ordinary Chat for follow-up', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ baseUrl, feedUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'analysis-fixture-model',
        models: ['analysis-fixture-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })

      await window.origread.createLlmSkill({
        id: 'analysis-evidence-review',
        description: 'Fixed method used only for the article analysis task.',
        instructions: 'ANALYSIS_SKILL_MARKER: inspect evidence quality before drawing conclusions.',
        triggers: 'analysis-fixed-only'
      })
      await window.origread.setLlmSkillBinding('ARTICLE_ANALYSIS', 'analysis-evidence-review')
      await window.origread.updateLlmCustomizationSettings({
        customInstructions: 'CUSTOM_ANALYSIS_MARKER: keep the wording concise.'
      })

      const search = await window.origread.addWebSearchProvider('TAVILY')
      const searchProvider = search.providers[0]
      if (!searchProvider) throw new Error('Search provider is missing')
      await window.origread.updateWebSearchProvider({
        id: searchProvider.id,
        name: 'Analysis Search',
        endpoint: `${baseUrl}/search`,
        apiKey: 'analysis-search-key'
      })
      await window.origread.updateWebSearchSettings({ mode: 'OFF', defaultProviderId: searchProvider.id, maxResults: 5 })

      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { baseUrl: fixture.baseUrl, feedUrl: `${fixture.baseUrl}/feed.xml` })

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleId}"]`).click()
    await expect(page.locator('.article-body')).toContainText('The author claims the release reduces recovery time')
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')

    // D7.5 reuses the existing one-shot Dedicated Search control; the analysis action itself is a real task,
    // not a fake UI button or a separate Provider path.
    const forceSearch = page.getByRole('button', { name: '下一条强制联网搜索' })
    await forceSearch.click()
    await expect(forceSearch).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: /文章分析/ }).click()

    const analysisAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(analysisAssistant.locator('.reader-ai-task-badge')).toContainText('文章分析')
    await expect(analysisAssistant).toContainText('Analysis task response')
    await expect(analysisAssistant.locator('.reader-ai-web-search-activity')).toContainText('Analysis Search')
    await expect.poll(() => fixture.searchRequests.length).toBe(1)
    await expect(forceSearch).toHaveAttribute('aria-pressed', 'false')

    expect(fixture.aiRequests).toHaveLength(1)
    const firstSystem = systemMessage(fixture.aiRequests[0]!)
    expect(firstSystem).toContain('dedicated article-analysis task')
    expect(firstSystem).toContain('ANALYSIS_SKILL_MARKER')
    expect(firstSystem).toContain('CUSTOM_ANALYSIS_MARKER')
    expect(firstSystem).toContain('ORIGREAD_CONTEXT type=ARTICLE')
    expect(firstSystem).toContain('The author claims the release reduces recovery time')
    expect(firstSystem).toContain('ORIGREAD_CONTEXT type=WEB_SEARCH_RESULT')
    expect(firstSystem).toContain('External verification result')

    const firstPersisted = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      const messages = await window.origread.getLlmMessages(conversation.id)
      const assistant = messages.filter((message) => message.role === 'ASSISTANT' && message.historyActive).at(-1)
      if (!assistant) throw new Error('Analysis assistant missing')
      return { messages, evidence: await window.origread.getLlmAssistantEvidence(assistant.id) }
    }, articleId)
    expect(firstPersisted.messages.filter((message) => message.historyActive).map((message) => [message.role, message.requestTask])).toEqual([
      ['USER', 'ARTICLE_ANALYSIS'],
      ['ASSISTANT', 'ARTICLE_ANALYSIS']
    ])
    expect(firstPersisted.evidence.contextRefs.some((ref) => ref.type === 'ARTICLE' && ref.includedInPrompt)).toBe(true)
    expect(firstPersisted.evidence.contextRefs.some((ref) => ref.type === 'WEB_SEARCH_RESULT' && ref.includedInPrompt)).toBe(true)
    expect(firstPersisted.evidence.contextRefs.some((ref) => ref.type === 'ARTICLE_SUMMARY' || ref.type === 'ARTICLE_TRANSLATION')).toBe(false)

    // Regenerate must preserve the original task. It must not silently turn Article Analysis into CHAT.
    await analysisAssistant.getByRole('button', { name: '重新生成' }).click()
    await expect(page.locator('.reader-ai-message.assistant').last().locator('.reader-ai-task-badge')).toContainText('文章分析')
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Analysis task response')
    expect(fixture.aiRequests).toHaveLength(2)
    expect(systemMessage(fixture.aiRequests[1]!)).toContain('dedicated article-analysis task')
    expect(systemMessage(fixture.aiRequests[1]!)).toContain('ANALYSIS_SKILL_MARKER')
    expect(fixture.searchRequests).toHaveLength(1)

    // A normal follow-up stays in the same Conversation but returns to the ordinary CHAT hard contract.
    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('What should I verify next?')
    await composer.press('Enter')
    const followUp = page.locator('.reader-ai-message.assistant').last()
    await expect(followUp).toContainText('Ordinary follow-up response')
    await expect(followUp.locator('.reader-ai-task-badge')).toHaveCount(0)
    expect(fixture.aiRequests).toHaveLength(3)
    const followUpSystem = systemMessage(fixture.aiRequests[2]!)
    expect(followUpSystem).not.toContain('dedicated article-analysis task')
    expect(followUpSystem).toContain('You are OrigRead, a reading assistant.')

    const finalMessages = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      return window.origread.getLlmMessages(conversation.id)
    }, articleId)
    const active = finalMessages.filter((message) => message.historyActive)
    expect(active.map((message) => [message.role, message.requestTask])).toEqual([
      ['USER', 'ARTICLE_ANALYSIS'],
      ['ASSISTANT', 'ARTICLE_ANALYSIS'],
      ['USER', 'CHAT'],
      ['ASSISTANT', 'CHAT']
    ])
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

function systemMessage(body: AiRequestBody): string {
  return body.messages?.find((message) => message.role === 'system')?.content ?? ''
}

async function startFixture(): Promise<{
  server: Server
  baseUrl: string
  aiRequests: AiRequestBody[]
  searchRequests: string[]
}> {
  const aiRequests: AiRequestBody[] = []
  const searchRequests: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Analysis E2E</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Article Analysis Fixture</title><link>http://127.0.0.1/article</link><guid>article-analysis-fixture</guid><description><![CDATA[
<h2>Claim</h2><p>The author claims the release reduces recovery time by changing how drafts are persisted.</p>
<p>The article cites an internal trial of 120 interrupted sessions, but it does not describe the control group or failure distribution.</p>
<p>The author concludes the change should reduce support incidents for production teams.</p>
]]></description></item></channel></rss>`)
      return
    }
    if (request.url === '/search' && request.method === 'POST') {
      void readText(request).then((body) => {
        searchRequests.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ results: [{
          title: 'External verification result',
          url: 'https://example.com/verification',
          content: 'External verification result says independent measurements are still pending.'
        }] }))
      })
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      void readJson<AiRequestBody>(request).then((body) => {
        aiRequests.push(body)
        const analysis = systemMessage(body).includes('dedicated article-analysis task')
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: analysis ? 'Analysis task response' : 'Ordinary follow-up response' }, finish_reason: null }] })}\n\n`)
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
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, aiRequests, searchRequests }
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
