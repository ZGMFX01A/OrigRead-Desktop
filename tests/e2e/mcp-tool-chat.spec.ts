import { createServer, type IncomingMessage, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader AI approves a risky Remote MCP tool before tools/call and continues the same model loop', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, aiBaseUrl, mcpUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: aiBaseUrl,
        defaultModel: 'mcp-tool-model',
        models: ['mcp-tool-model'],
        apiKey: '',
        streamingCapabilityOverride: 'ENABLED',
        toolCallingCapabilityOverride: 'ENABLED'
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })

      const mcp = await window.origread.addMcpRemoteServer()
      const server = mcp.servers[0]
      if (!server) throw new Error('Remote MCP server was not created')
      await window.origread.updateMcpRemoteServer({
        id: server.id,
        name: 'Approval fixture',
        url: mcpUrl,
        enabled: true
      })
      const catalog = await window.origread.refreshMcpToolCatalog(server.id)
      if (catalog.servers[0]?.tools.length !== 1) throw new Error('Fixture MCP catalog missing tool')

      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, {
      feedUrl: `${fixture.baseUrl}/feed.xml`,
      aiBaseUrl: `${fixture.baseUrl}/v1`,
      mcpUrl: `${fixture.baseUrl}/mcp`
    })

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await page.keyboard.press('a')
    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('Publish the weekly note with the MCP tool.')
    await composer.press('Enter')

    const toolCard = page.locator('.reader-ai-tool-card').first()
    await expect(toolCard).toBeVisible()
    await expect(toolCard).toContainText('可能修改数据')
    await expect(toolCard).toContainText('等待确认')
    await expect(toolCard.locator('.reader-ai-tool-arguments')).toContainText('Weekly')
    await expect(toolCard.locator('.reader-ai-tool-arguments')).toContainText('[redacted]')
    await expect(toolCard.locator('.reader-ai-tool-arguments')).not.toContainText('fixture-secret-key')
    await toolCard.evaluate((element) => { (element as HTMLElement).dataset.motionIdentity = 'stable-tool-card' })
    const pendingMotion = await toolCard.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return { animationName: style.animationName, transitionProperty: style.transitionProperty }
    })
    expect(pendingMotion.animationName).toBe('motion-feedback-enter')
    expect(pendingMotion.transitionProperty).toContain('background-color')
    expect(fixture.toolCalls).toHaveLength(0)

    const allowButton = toolCard.getByRole('button', { name: '允许这一次' })
    await expect(allowButton).toBeEnabled()
    await allowButton.click()
    await expect(toolCard).toContainText('已完成')
    await expect(toolCard).toHaveAttribute('data-motion-identity', 'stable-tool-card')
    const assistant = page.locator('.reader-ai-message.assistant').last()
    await expect(assistant).toContainText('Published after approval')
    await expect(assistant.locator('.reader-ai-inline-citation')).toHaveCount(1)
    await assistant.getByRole('button', { name: '来源' }).click()
    const sources = page.locator('.reader-ai-sources-detail')
    await expect(sources).toContainText('工具结果')
    await expect(sources).toContainText('Publish a weekly note')
    await expect(sources).toContainText('published: Weekly')
    await expect(sources).toContainText('MCP 服务')
    await page.getByRole('button', { name: '返回' }).click()

    expect(fixture.toolCalls).toEqual([{ name: 'publish_note', arguments: { title: 'Weekly', apiKey: 'fixture-secret-key' } }])
    expect(fixture.aiRequests).toHaveLength(2)
    expect(fixture.aiRequests[0]?.tools?.[0]?.function?.name).toMatch(/^mcp_[0-9a-f]{8}_publish_note$/)
    const secondMessages = fixture.aiRequests[1]?.messages ?? []
    expect(secondMessages.at(-1)?.role).toBe('tool')
    expect(secondMessages.at(-1)?.content).toContain('published: Weekly')
    expect(secondMessages.at(-1)?.content).toContain('ORIGREAD_EVIDENCE id="E')

    const activity = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      return window.origread.getLlmToolActivity(conversation.id)
    }, articleId)
    expect(activity).toMatchObject([{
      risk: 'WRITE', status: 'COMPLETE', argumentsPreview: expect.stringContaining('[redacted]'), resultPreview: 'published: Weekly'
    }])
    expect(JSON.stringify(activity)).not.toContain('fixture-secret-key')
    const evidence = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      const messages = await window.origread.getLlmMessages(conversation.id)
      const latest = [...messages].reverse().find((message) => message.role === 'ASSISTANT')
      if (!latest) throw new Error('Assistant missing')
      return window.origread.getLlmAssistantEvidence(latest.id)
    }, articleId)
    expect(evidence.contextRefs.some((ref) => ref.type === 'TOOL_RESULT' && ref.contentSnapshot === 'published: Weekly')).toBe(true)
    expect(evidence.citations[0]?.locatorSnapshot).toMatchObject({ sourceKind: 'TOOL_RESULT', toolName: 'Publish a weekly note' })
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

test('Article Analysis reuses the same MCP catalog, approval gate, and automatic tool loop', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, aiBaseUrl, mcpUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: aiBaseUrl,
        defaultModel: 'mcp-analysis-model',
        models: ['mcp-analysis-model'],
        apiKey: '',
        streamingCapabilityOverride: 'ENABLED',
        toolCallingCapabilityOverride: 'ENABLED'
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })

      const mcp = await window.origread.addMcpRemoteServer()
      const server = mcp.servers[0]
      if (!server) throw new Error('Remote MCP server was not created')
      await window.origread.updateMcpRemoteServer({ id: server.id, name: 'Analysis MCP', url: mcpUrl, enabled: true })
      const catalog = await window.origread.refreshMcpToolCatalog(server.id)
      if (catalog.servers[0]?.tools.length !== 1) throw new Error('Fixture MCP catalog missing tool')

      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, {
      feedUrl: `${fixture.baseUrl}/feed.xml`,
      aiBaseUrl: `${fixture.baseUrl}/v1`,
      mcpUrl: `${fixture.baseUrl}/mcp`
    })

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleId}"]`).click()
    await page.keyboard.press('a')
    await page.getByRole('button', { name: /文章分析/ }).click()

    const assistant = page.locator('.reader-ai-message.assistant').last()
    await expect(assistant.locator('.reader-ai-task-badge')).toContainText('文章分析')
    const toolCard = assistant.locator('.reader-ai-tool-card').first()
    await expect(toolCard).toBeVisible()
    await expect(toolCard).toContainText('等待确认')
    expect(fixture.toolCalls).toHaveLength(0)

    await toolCard.getByRole('button', { name: '允许这一次' }).click()
    await expect(toolCard).toContainText('已完成')
    await expect(assistant).toContainText('Published after approval')
    expect(fixture.toolCalls).toHaveLength(1)
    expect(fixture.aiRequests).toHaveLength(2)
    expect(fixture.aiRequests[0]?.tools?.[0]?.function?.name).toMatch(/^mcp_[0-9a-f]{8}_publish_note$/)
    expect(JSON.stringify(fixture.aiRequests[0]?.messages ?? [])).toContain('dedicated article-analysis task')

    const persisted = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      const messages = await window.origread.getLlmMessages(conversation.id)
      return messages.filter((message) => message.historyActive)
    }, articleId)
    expect(persisted.map((message) => [message.role, message.requestTask])).toEqual([
      ['USER', 'ARTICLE_ANALYSIS'],
      ['ASSISTANT', 'ARTICLE_ANALYSIS']
    ])
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

test('Reader AI runs MCP manually for a model without tool calling and injects the result as TOOL_RESULT context', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, aiBaseUrl, mcpUrl }) => {
      const added = await window.origread.addRssSource(feedUrl)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: aiBaseUrl,
        defaultModel: 'manual-mcp-model',
        models: ['manual-mcp-model'],
        apiKey: '',
        streamingCapabilityOverride: 'ENABLED',
        toolCallingCapabilityOverride: 'DISABLED'
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })

      const mcp = await window.origread.addMcpRemoteServer()
      const server = mcp.servers[0]
      if (!server) throw new Error('Remote MCP server was not created')
      await window.origread.updateMcpRemoteServer({
        id: server.id,
        name: 'Manual fixture',
        url: mcpUrl,
        enabled: true
      })
      await window.origread.refreshMcpToolCatalog(server.id)

      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, {
      feedUrl: `${fixture.baseUrl}/feed.xml`,
      aiBaseUrl: `${fixture.baseUrl}/v1`,
      mcpUrl: `${fixture.baseUrl}/mcp`
    })

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await page.keyboard.press('a')

    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('Start a conversation without automatic tool calling.')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('No MCP tool exposed')
    expect(fixture.aiRequests).toHaveLength(1)
    expect(fixture.aiRequests[0]?.tools ?? []).toHaveLength(0)

    await page.locator('.reader-ai-composer-add').click()
    const actions = page.locator('.reader-ai-composer-actions-popover')
    await expect(actions).toContainText('MCP 工具')
    await actions.getByRole('button', { name: /Publish a weekly note/ }).click()

    const editor = page.locator('.reader-ai-manual-tool-editor')
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('可能修改数据')
    await editor.locator('textarea').fill('{"title":"Manual"}')
    await editor.getByRole('button', { name: '确认并执行' }).click()

    await expect(page.locator('.reader-ai-manual-context')).toContainText('将作为资料加入下一条消息')
    expect(fixture.toolCalls).toEqual([{ name: 'publish_note', arguments: { title: 'Manual' } }])

    await composer.fill('Use the attached MCP result in your answer.')
    await composer.press('Enter')
    const manualAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(manualAssistant).toContainText('Used manual MCP context')
    await expect(manualAssistant.locator('.reader-ai-inline-citation')).toHaveCount(1)
    await manualAssistant.getByRole('button', { name: '来源' }).click()
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('工具结果')
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('published: Manual')
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('MCP 服务')
    await page.getByRole('button', { name: '返回' }).click()
    await expect(page.locator('.reader-ai-manual-context')).toHaveCount(0)

    expect(fixture.aiRequests).toHaveLength(2)
    expect(fixture.aiRequests[1]?.tools ?? []).toHaveLength(0)
    expect(fixture.aiRequests[1]?.messages?.some((message) => message.role === 'tool')).toBe(false)
    expect(JSON.stringify(fixture.aiRequests[1])).toContain('ORIGREAD_CONTEXT type=TOOL_RESULT')
    expect(JSON.stringify(fixture.aiRequests[1])).toContain('published: Manual')

    const evidence = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing')
      const messages = await window.origread.getLlmMessages(conversation.id)
      const assistant = [...messages].reverse().find((message) => message.role === 'ASSISTANT')
      if (!assistant) throw new Error('Assistant missing')
      return window.origread.getLlmAssistantEvidence(assistant.id)
    }, articleId)
    expect(evidence.contextRefs.some((ref) => ref.type === 'TOOL_RESULT' && ref.contentSnapshot === 'published: Manual')).toBe(true)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

interface AiRequestBody {
  messages?: Array<{ role?: string; content?: string }>
  tools?: Array<{ function?: { name?: string } }>
}

async function startFixture(): Promise<{
  server: Server
  baseUrl: string
  aiRequests: AiRequestBody[]
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
}> {
  const aiRequests: AiRequestBody[] = []
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>MCP Tool Chat</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>MCP Approval Article</title><link>http://127.0.0.1/article</link><guid>mcp-tool-chat-article</guid><description><![CDATA[<p>Weekly release notes are ready.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      void readJson(request).then((body: AiRequestBody) => {
        aiRequests.push(body)
        const serialized = JSON.stringify(body)
        const hasManualToolContext = serialized.includes('ORIGREAD_CONTEXT type=TOOL_RESULT') && serialized.includes('published: Manual')
        const hasToolResult = body.messages?.some((message) => message.role === 'tool') === true
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (hasManualToolContext) {
          const evidenceId = findEvidenceId(body, 'published: Manual')
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: evidenceId ? `Used manual MCP context [[${evidenceId}]]` : 'Used manual MCP context' }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
          response.end('data: [DONE]\n\n')
          return
        }
        if (hasToolResult) {
          const evidenceId = findEvidenceId(body, 'published: Weekly')
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: evidenceId ? `Published after approval [[${evidenceId}]]` : 'Published after approval' }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
          response.end('data: [DONE]\n\n')
          return
        }
        const toolName = body.tools?.[0]?.function?.name
        if (!toolName) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'No MCP tool exposed' }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
          response.end('data: [DONE]\n\n')
          return
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'provider-mcp-call-1', function: { name: toolName, arguments: '{"title":"Weekly","apiKey":"fixture-secret-key"}' } }] }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      }).catch(() => response.writeHead(400).end())
      return
    }
    if (request.url === '/mcp' && request.method === 'POST') {
      void readJson(request).then((message: { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) => {
        if (message.method === 'server/discover') {
          respondJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        if (message.method === 'initialize') {
          respondJson(response, {
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'approval-fixture', version: '1.0.0' } }
          })
          return
        }
        if (message.method === 'tools/list') {
          respondJson(response, {
            jsonrpc: '2.0', id: message.id,
            result: {
              tools: [{
                name: 'publish_note',
                description: 'Publish a weekly note',
                inputSchema: { type: 'object', properties: { title: { type: 'string' }, apiKey: { type: 'string' } }, required: ['title'] },
                annotations: { readOnlyHint: false, destructiveHint: true }
              }]
            }
          })
          return
        }
        if (message.method === 'tools/call') {
          toolCalls.push({ name: message.params?.name ?? '', arguments: message.params?.arguments ?? {} })
          respondJson(response, {
            jsonrpc: '2.0', id: message.id,
            result: { content: [{ type: 'text', text: `published: ${String(message.params?.arguments?.title ?? '')}` }] }
          })
          return
        }
        response.writeHead(202).end()
      }).catch(() => response.writeHead(400).end())
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture port missing')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, aiRequests, toolCalls }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(request)) as T
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function respondJson(response: import('node:http').ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function findEvidenceId(body: AiRequestBody, marker: string): string | null {
  const candidates = body.messages?.map((message) => message.content ?? '').filter((content) => content.includes(marker)) ?? []
  for (const content of candidates) {
    const markerIndex = content.indexOf(marker)
    const matches = [...content.slice(0, markerIndex).matchAll(/\[ORIGREAD_EVIDENCE id="(E\d+)"\]/g)]
    const id = matches.at(-1)?.[1]
    if (id) return id
  }
  return null
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
