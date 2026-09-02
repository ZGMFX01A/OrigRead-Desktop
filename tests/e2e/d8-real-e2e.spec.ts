import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchOrigReadWithUserData } from './electron-test-app'

interface AiRequestBody {
  messages?: Array<{ role?: string; content?: string }>
  tools?: Array<{ function?: { name?: string } }>
}

interface IntegratedFixture {
  server: Server
  baseUrl: string
  aiRequests: AiRequestBody[]
  searchRequests: string[]
  mcpMethods: string[]
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
}

interface StdioFixtureEvent {
  event?: string
  pid?: number
  secretPresent?: boolean
  name?: string
  args?: unknown
}

test('D8.7 Windows release journey keeps Summary, Reader AI, Reasoning, Search, Skill, multi-article, Remote MCP and restart state on one real product chain', async () => {
  test.setTimeout(90_000)
  const fixture = await startIntegratedFixture()
  const userDataDir = await createUserDataDir('d8-real-journey-')
  let firstApp = await launchOrigReadWithUserData(userDataDir)
  let firstClosed = false

  try {
    const page = await firstApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const ids = await page.evaluate(async ({ baseUrl }) => {
      const added = await window.origread.addRssSource(`${baseUrl}/feed.xml`)
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'd8-real-model',
        models: ['d8-real-model'],
        apiKey: '',
        streamingCapabilityOverride: 'ENABLED',
        toolCallingCapabilityOverride: 'ENABLED'
      })
      await window.origread.updateAiSettings({
        enabled: true,
        defaultProviderId: provider.id,
        outputLanguage: 'zh-CN'
      })

      await window.origread.createLlmSkill({
        id: 'd8-real-review',
        description: 'Compare current and attached evidence with fresh web evidence.',
        instructions: 'D8_REAL_SKILL_MARKER: compare evidence explicitly before drawing a conclusion.',
        triggers: 'compare,latest,evidence'
      })
      await window.origread.updateLlmCustomizationSettings({
        customInstructions: 'D8_REAL_CUSTOM_MARKER: keep release verification answers concise.'
      })

      const search = await window.origread.addWebSearchProvider('TAVILY')
      const searchProvider = search.providers[0]
      if (!searchProvider) throw new Error('Search provider is missing')
      await window.origread.updateWebSearchProvider({
        id: searchProvider.id,
        name: 'D8 Real Search',
        endpoint: `${baseUrl}/search`,
        apiKey: 'd8-real-search-secret'
      })
      await window.origread.updateWebSearchSettings({ mode: 'OFF', defaultProviderId: searchProvider.id, maxResults: 5 })

      const mcp = await window.origread.addMcpRemoteServer()
      const remote = mcp.servers[0]
      if (!remote) throw new Error('Remote MCP server is missing')
      await window.origread.updateMcpRemoteServer({
        id: remote.id,
        name: 'D8 Real Remote MCP',
        url: `${baseUrl}/mcp`,
        enabled: true
      })
      const catalog = await window.origread.refreshMcpToolCatalog(remote.id)
      if (catalog.servers[0]?.tools.length !== 1) throw new Error('Remote MCP tool catalog did not load')

      const articles = (await window.origread.listArticles(100)).filter((item) => item.feedId === added.feedId)
      const current = articles.find((item) => item.title === 'D8 Real Current Article')
      const attached = articles.find((item) => item.title === 'D8 Real Attached Article')
      if (!current || !attached) throw new Error('D8.7 fixture articles are missing')
      return { currentId: current.id, attachedId: attached.id, remoteId: remote.id }
    }, { baseUrl: fixture.baseUrl })

    const mcpMethodsAfterSetup = fixture.mcpMethods.length
    expect(fixture.mcpMethods).toContain('initialize')
    expect(fixture.mcpMethods).toContain('tools/list')

    await page.reload()
    await page.locator(`.article-item[data-article-id="${ids.currentId}"]`).click()
    await expect(page.locator('.article-body')).toContainText('D8_REAL_CURRENT_MARKER')

    // Summary uses the real Reader action, Main provider path, SSE reasoning/content and persistent cache.
    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await page.locator('.reader-ai-summary-length-action').nth(1).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.ai-summary-panel-body .ai-reasoning')).toContainText('D8 real summary reasoning', { timeout: 15_000 })
    await expect(page.locator('.ai-summary-panel-body')).toContainText('D8 real summary body')
    expect(fixture.aiRequests).toHaveLength(1)

    // Continue from Summary into the same Reader AI surface, then attach another real article.
    await page.locator('.ai-summary-footer-actions .mini-action').first().click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    const attachButton = page.locator('.reader-ai-article-picker-trigger')
    await attachButton.click()
    const picker = page.locator('.reader-ai-article-picker-popover')
    await picker.locator('.reader-ai-article-picker-search input').fill('D8 Real Attached Article')
    await picker.locator('.reader-ai-article-picker-list > button').filter({ hasText: 'D8 Real Attached Article' }).click()
    await expect(page.locator('.reader-ai-article-attachment')).toContainText('D8 Real Attached Article')

    // Force one Dedicated Search so this single request proves Search + Skill + multi-article + reasoning together.
    await page.locator('.reader-ai-web-search-toggle').click()
    await expect(page.locator('.reader-ai-web-search-toggle')).toHaveAttribute('aria-pressed', 'true')
    const composer = page.locator('.reader-ai-composer textarea')
    await composer.fill('Compare the latest evidence across both articles.')
    await composer.press('Enter')

    const comparisonAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(comparisonAssistant).toContainText('D8 integrated comparison')
    await expect(comparisonAssistant.locator('.reader-ai-reasoning')).toContainText('D8 real chat reasoning')
    await expect(comparisonAssistant.locator('.reader-ai-web-search-activity')).toContainText('D8 Real Search')
    await expect(comparisonAssistant.locator('.reader-ai-inline-citation')).toHaveCount(1)
    await expect.poll(() => fixture.searchRequests.length).toBe(1)
    expect(fixture.aiRequests).toHaveLength(2)

    const comparisonSystem = systemMessage(fixture.aiRequests[1]!)
    expect(comparisonSystem).toContain('D8_REAL_SKILL_MARKER')
    expect(comparisonSystem).toContain('D8_REAL_CUSTOM_MARKER')
    expect(comparisonSystem).toContain('D8_REAL_CURRENT_MARKER')
    expect(comparisonSystem).toContain('D8_REAL_ATTACHED_MARKER')
    expect(comparisonSystem).toContain('D8_REAL_SEARCH_MARKER')

    // The next turn exercises the automatic Remote MCP loop and its real Main-process approval gate.
    await composer.fill('Publish D8 real note with the MCP tool.')
    await composer.press('Enter')
    const toolCard = page.locator('.reader-ai-tool-card').last()
    await expect(toolCard).toBeVisible()
    await expect(toolCard).toContainText('等待确认')
    expect(fixture.toolCalls).toHaveLength(0)
    await toolCard.locator('button.mini-action').last().click()
    await expect(toolCard).toContainText('已完成')
    const publishedAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(publishedAssistant).toContainText('D8 remote MCP completed')
    await expect(publishedAssistant.locator('.reader-ai-inline-citation')).toHaveCount(1)
    expect(fixture.toolCalls).toEqual([{
      name: 'publish_note',
      arguments: { title: 'D8 real note', apiKey: 'd8-real-tool-secret' }
    }])
    expect(fixture.aiRequests).toHaveLength(4)

    const persistedBeforeRestart = await page.evaluate(async (articleId) => {
      const conversation = (await window.origread.listLlmConversations(articleId))[0]
      if (!conversation) throw new Error('D8.7 conversation was not persisted')
      const messages = await window.origread.getLlmMessages(conversation.id)
      const articles = await window.origread.getLlmConversationArticles(conversation.id)
      const assistants = messages.filter((message) => message.role === 'ASSISTANT' && message.historyActive)
      return {
        conversationId: conversation.id,
        messages,
        articles,
        comparisonEvidence: assistants[0] ? await window.origread.getLlmAssistantEvidence(assistants[0].id) : null,
        toolEvidence: assistants[1] ? await window.origread.getLlmAssistantEvidence(assistants[1].id) : null
      }
    }, ids.currentId)
    expect(persistedBeforeRestart.articles.map((item) => item.articleId)).toEqual([ids.attachedId])
    expect(persistedBeforeRestart.comparisonEvidence?.contextRefs.some((ref) => ref.type === 'WEB_SEARCH_RESULT' && ref.includedInPrompt)).toBe(true)
    expect(persistedBeforeRestart.toolEvidence?.contextRefs.some((ref) => ref.type === 'TOOL_RESULT' && ref.contentSnapshot === 'published: D8 real note')).toBe(true)

    await firstApp.close()
    firstClosed = true
    const aiCountBeforeRestart = fixture.aiRequests.length
    const searchCountBeforeRestart = fixture.searchRequests.length
    const mcpCountBeforeRestart = fixture.mcpMethods.length

    const restarted = await launchOrigReadWithUserData(userDataDir)
    try {
      const restartedPage = await restarted.app.firstWindow()
      await expect(restartedPage.locator('.app-shell')).toBeVisible()

      // Startup itself must not replay AI/Search/MCP network activity.
      await restartedPage.waitForTimeout(350)
      expect(fixture.aiRequests).toHaveLength(aiCountBeforeRestart)
      expect(fixture.searchRequests).toHaveLength(searchCountBeforeRestart)
      expect(fixture.mcpMethods).toHaveLength(mcpCountBeforeRestart)

      const restartState = await restartedPage.evaluate(async ({ articleId, conversationId, remoteId }) => {
        const summary = await window.origread.summarizeArticle(articleId, false)
        const messages = await window.origread.getLlmMessages(conversationId)
        const articles = await window.origread.getLlmConversationArticles(conversationId)
        const skill = await window.origread.getLlmSkillPreview('d8-real-review')
        const remote = await window.origread.getMcpRemoteSettings()
        return {
          summary,
          messages,
          articles,
          skill,
          remote: remote.servers.find((server) => server.id === remoteId) ?? null
        }
      }, { articleId: ids.currentId, conversationId: persistedBeforeRestart.conversationId, remoteId: ids.remoteId })

      expect(restartState.summary).toMatchObject({ status: 'GENERATED', summary: 'D8 real summary body' })
      expect(restartState.skill.instructions).toContain('D8_REAL_SKILL_MARKER')
      expect(restartState.remote).toMatchObject({ name: 'D8 Real Remote MCP', enabled: true })
      expect(restartState.articles.map((item) => item.articleId)).toEqual([ids.attachedId])
      expect(restartState.messages.filter((message) => message.role === 'ASSISTANT' && message.historyActive).map((message) => message.content)).toEqual([
        expect.stringContaining('D8 integrated comparison'),
        expect.stringContaining('D8 remote MCP completed')
      ])

      // Cache/history restore must still be local after the explicit reads above.
      expect(fixture.aiRequests).toHaveLength(aiCountBeforeRestart)
      expect(fixture.searchRequests).toHaveLength(searchCountBeforeRestart)
      expect(fixture.mcpMethods).toHaveLength(mcpCountBeforeRestart)
      expect(mcpCountBeforeRestart).toBeGreaterThanOrEqual(mcpMethodsAfterSetup + 1)
    } finally {
      await restarted.close()
    }
  } finally {
    if (!firstClosed) await firstApp.close().catch(() => undefined)
    await closeServer(fixture.server)
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
  }
})

test('D8.7 Windows stdio release journey stays lazy across a real app restart and reuses SecretStore-backed env through the shared ToolRuntime', async () => {
  test.setTimeout(60_000)
  const userDataDir = await createUserDataDir('d8-real-stdio-')
  const logDir = await createUserDataDir('d8-real-stdio-log-')
  const logPath = join(logDir, 'stdio.log')
  const fixturePath = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mcp-stdio-fixture.cjs')
  let firstApp = await launchOrigReadWithUserData(userDataDir)
  let firstClosed = false

  try {
    const page = await firstApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const firstRun = await page.evaluate(async ({ command, fixturePath: script, cwd, logPath: fixtureLog }) => {
      const added = await window.origread.addMcpLocalServer()
      const server = added.servers[0]
      if (!server) throw new Error('D8.7 local MCP server was not created')
      await window.origread.updateMcpLocalServer({
        id: server.id,
        name: 'D8 Real stdio MCP',
        command,
        args: [script, '--profile=d8-real'],
        cwd,
        environment: `ORIGREAD_MCP_FIXTURE_LOG=${fixtureLog}\nFIXTURE_SECRET=local-secret-value`,
        enabled: true
      })
      const catalog = await window.origread.refreshMcpToolCatalog(server.id)
      const conversation = await window.origread.createLlmConversation({ title: 'D8 stdio restart' })
      const tools = await window.origread.listLlmManualTools()
      const tool = tools.find((item) => item.name.includes('read_local_note'))
      if (!tool) throw new Error('D8.7 local MCP read tool is missing')
      const context = await window.origread.executeLlmManualTool({
        conversationId: conversation.id,
        toolId: tool.id,
        argumentsJson: JSON.stringify({ id: 'before-restart' }),
        confirmed: true
      })
      await window.origread.discardLlmManualToolContext(context.contextId)
      return { serverId: server.id, result: context.resultPreview, catalog }
    }, { command: process.execPath, fixturePath, cwd: process.cwd(), logPath })

    expect(firstRun.result).toBe('read_local_note:ok:before-restart')
    expect(firstRun.catalog.servers.find((server) => server.serverId === firstRun.serverId)?.tools).toHaveLength(2)
    const eventsBeforeClose = await readStdioEvents(logPath)
    expect(eventsBeforeClose).toContainEqual(expect.objectContaining({
      event: 'tool-call', name: 'read_local_note', secretPresent: true, args: { id: 'before-restart' }
    }))
    const startsBeforeRestart = eventsBeforeClose.filter((event) => event.event === 'started').length

    await firstApp.close()
    firstClosed = true
    await waitForAllFixturePidsToExit(logPath)

    const restarted = await launchOrigReadWithUserData(userDataDir)
    try {
      const restartedPage = await restarted.app.firstWindow()
      await expect(restartedPage.locator('.app-shell')).toBeVisible()
      await restartedPage.waitForTimeout(350)

      // Local MCP must remain lazy after restart: saved/enabled is not permission to auto-spawn.
      expect((await readStdioEvents(logPath)).filter((event) => event.event === 'started')).toHaveLength(startsBeforeRestart)

      const publicSettings = await restartedPage.evaluate(() => window.origread.getMcpLocalSettings())
      expect(publicSettings.servers).toHaveLength(1)
      expect(publicSettings.servers[0]).toMatchObject({
        id: firstRun.serverId,
        name: 'D8 Real stdio MCP',
        enabled: true,
        command: process.execPath,
        args: [fixturePath, '--profile=d8-real'],
        hasEnvironment: true
      })
      expect(JSON.stringify(publicSettings)).not.toContain('local-secret-value')
      expect(JSON.stringify(publicSettings)).not.toContain(logPath)

      const secondRun = await restartedPage.evaluate(async (serverId) => {
        const catalog = await window.origread.refreshMcpToolCatalog(serverId)
        const conversation = await window.origread.createLlmConversation({ title: 'D8 stdio after restart' })
        const tools = await window.origread.listLlmManualTools()
        const tool = tools.find((item) => item.name.includes('read_local_note'))
        if (!tool) throw new Error('Restarted local MCP tool is missing')
        const context = await window.origread.executeLlmManualTool({
          conversationId: conversation.id,
          toolId: tool.id,
          argumentsJson: JSON.stringify({ id: 'after-restart' }),
          confirmed: true
        })
        await window.origread.discardLlmManualToolContext(context.contextId)
        return { catalog, result: context.resultPreview }
      }, firstRun.serverId)

      expect(secondRun.catalog.servers.find((server) => server.serverId === firstRun.serverId)?.tools).toHaveLength(2)
      expect(secondRun.result).toBe('read_local_note:ok:after-restart')
      const restartedEvents = await readStdioEvents(logPath)
      expect(restartedEvents.filter((event) => event.event === 'started').length).toBeGreaterThan(startsBeforeRestart)
      expect(restartedEvents).toContainEqual(expect.objectContaining({
        event: 'tool-call', name: 'read_local_note', secretPresent: true, args: { id: 'after-restart' }
      }))
    } finally {
      await restarted.close()
      await waitForAllFixturePidsToExit(logPath)
    }
  } finally {
    if (!firstClosed) await firstApp.close().catch(() => undefined)
    await waitForAllFixturePidsToExit(logPath).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
    await rm(logDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
  }
})

async function createUserDataDir(prefix: string): Promise<string> {
  const root = join(process.cwd(), 'test-results')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, prefix))
}

async function startIntegratedFixture(): Promise<IntegratedFixture> {
  const aiRequests: AiRequestBody[] = []
  const searchRequests: string[] = []
  const mcpMethods: string[] = []
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const currentText = Array.from({ length: 80 }, (_value, index) => `Current fact ${index + 1} keeps D8_REAL_CURRENT_MARKER grounded in the reader. `).join('')
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>D8 Real E2E</title><link>http://127.0.0.1/</link><description>release gate</description>
<item><title>D8 Real Current Article</title><link>http://127.0.0.1/current</link><guid>d8-real-current</guid><description><![CDATA[<h2>Current</h2><p>${currentText}</p>]]></description></item>
<item><title>D8 Real Attached Article</title><link>http://127.0.0.1/attached</link><guid>d8-real-attached</guid><description><![CDATA[<h2>Attached</h2><p>D8_REAL_ATTACHED_MARKER adds independent supporting evidence from the second article.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/search' && request.method === 'POST') {
      void readBody(request).then((body) => {
        searchRequests.push(body)
        respondJson(response, {
          results: [
            { title: 'D8 current verification', url: 'https://example.com/d8-real', content: 'D8_REAL_SEARCH_MARKER confirms the fresh external verification.' },
            { title: 'D8 secondary verification', url: 'https://example.org/d8-real-2', content: 'A secondary release verification result.' }
          ]
        })
      }).catch(() => response.writeHead(400).end())
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      void readJson<AiRequestBody>(request).then((body) => {
        aiRequests.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })

        if (aiRequests.length === 1) {
          writeSse(response, { choices: [{ delta: { reasoning_content: 'D8 real summary reasoning' }, finish_reason: null }] })
          writeSse(response, { choices: [{ delta: { content: '<!-- origread-summary-v2: {"v":2,"form":"report","domain":"technology"} -->\nD8 real summary body' }, finish_reason: null }] })
          finishSse(response)
          return
        }

        const serialized = JSON.stringify(body)
        const hasToolResult = body.messages?.some((message) => message.role === 'tool') === true
        if (hasToolResult) {
          const evidenceId = findEvidenceId(body, 'published: D8 real note')
          writeSse(response, { choices: [{ delta: { content: evidenceId ? `D8 remote MCP completed [[${evidenceId}]]` : 'D8 remote MCP completed' }, finish_reason: null }] })
          finishSse(response)
          return
        }

        if (serialized.includes('Publish D8 real note')) {
          const toolName = body.tools?.find((tool) => tool.function?.name?.includes('publish_note'))?.function?.name
          if (!toolName) {
            response.end(`data: ${JSON.stringify({ error: 'publish_note tool was not exposed' })}\n\n`)
            return
          }
          writeSse(response, {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'd8-provider-tool-call',
                  function: { name: toolName, arguments: '{"title":"D8 real note","apiKey":"d8-real-tool-secret"}' }
                }]
              },
              finish_reason: null
            }]
          })
          writeSse(response, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
          response.end('data: [DONE]\n\n')
          return
        }

        const searchEvidenceId = findEvidenceId(body, 'D8_REAL_SEARCH_MARKER')
        writeSse(response, { choices: [{ delta: { reasoning_content: 'D8 real chat reasoning' }, finish_reason: null }] })
        writeSse(response, { choices: [{ delta: { content: searchEvidenceId ? `D8 integrated comparison [[${searchEvidenceId}]]` : 'D8 integrated comparison' }, finish_reason: null }] })
        finishSse(response)
      }).catch(() => response.writeHead(400).end())
      return
    }
    if (request.url === '/mcp' && request.method === 'POST') {
      void readJson<{ id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }>(request).then((message) => {
        const method = message.method ?? ''
        mcpMethods.push(method)
        if (method === 'server/discover') {
          respondJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        if (method === 'initialize') {
          respondJson(response, {
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'd8-real-mcp', version: '1.0.0' } }
          })
          return
        }
        if (method === 'tools/list') {
          respondJson(response, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{
                name: 'publish_note',
                description: 'Publish D8 release note',
                inputSchema: { type: 'object', properties: { title: { type: 'string' }, apiKey: { type: 'string' } }, required: ['title'] },
                annotations: { readOnlyHint: false, destructiveHint: true }
              }]
            }
          })
          return
        }
        if (method === 'tools/call') {
          toolCalls.push({ name: message.params?.name ?? '', arguments: message.params?.arguments ?? {} })
          respondJson(response, {
            jsonrpc: '2.0',
            id: message.id,
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
  if (!address || typeof address === 'string') throw new Error('D8.7 integrated fixture did not expose a port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, aiRequests, searchRequests, mcpMethods, toolCalls }
}

function systemMessage(body: AiRequestBody): string {
  return body.messages?.find((message) => message.role === 'system')?.content ?? ''
}

function findEvidenceId(body: AiRequestBody, marker: string): string | null {
  for (const content of body.messages?.map((message) => message.content ?? '') ?? []) {
    const markerIndex = content.indexOf(marker)
    if (markerIndex < 0) continue
    const matches = [...content.slice(0, markerIndex).matchAll(/\[ORIGREAD_EVIDENCE id="(E\d+)"\]/g)]
    const id = matches.at(-1)?.[1]
    if (id) return id
  }
  return null
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function finishSse(response: ServerResponse): void {
  writeSse(response, { choices: [{ delta: {}, finish_reason: 'stop' }] })
  response.end('data: [DONE]\n\n')
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  return JSON.parse(await readBody(request)) as T
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body
}

function respondJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function readStdioEvents(path: string): Promise<StdioFixtureEvent[]> {
  let content = ''
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return []
  }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StdioFixtureEvent]
      } catch {
        return []
      }
    })
}

async function waitForAllFixturePidsToExit(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const pids = (await readStdioEvents(path))
      .filter((event): event is StdioFixtureEvent & { pid: number } => event.event === 'started' && Number.isInteger(event.pid))
      .map((event) => event.pid)
    if (pids.every((pid) => !isProcessAlive(pid))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('D8.7 stdio fixture process is still alive after app shutdown')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
