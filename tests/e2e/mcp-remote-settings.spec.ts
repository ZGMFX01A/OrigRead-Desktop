import { createServer, type IncomingMessage, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Remote MCP settings negotiate a real MCP connection without contacting servers on startup', async () => {
  test.setTimeout(30_000)
  const fixture = await startLegacyMcpFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    expect(fixture.requests).toHaveLength(0)

    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()

    const section = page.locator('.settings-section').filter({ has: page.locator('.settings-section-title', { hasText: 'MCP 工具' }) })
    await expect(section).toBeVisible()
    expect(fixture.requests).toHaveLength(0)
    await section.locator('.mcp-remote-toolbar').getByRole('button', { name: '添加' }).click()

    const card = section.locator('.mcp-remote-card').first()
    await expect(card).toBeVisible()
    await card.locator('.provider-name').fill('Fixture MCP')
    await card.locator('.provider-name').blur()
    const urlInput = card.locator('.provider-field').filter({ hasText: 'Server URL' }).locator('input')
    await urlInput.fill(fixture.url)
    await urlInput.blur()
    await card.locator('.setting-switch').click()
    await expect(card.locator('.setting-switch input')).toBeChecked()
    expect(fixture.requests).toHaveLength(0)

    const publicSettings = await page.evaluate(() => window.origread.getMcpRemoteSettings())
    expect(publicSettings.servers).toHaveLength(1)
    expect(publicSettings.servers[0]).toMatchObject({ name: 'Fixture MCP', url: fixture.url, enabled: true, transport: 'STREAMABLE_HTTP' })

    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.settings-status')).toContainText(/连接正常.*2 个工具.*Legacy.*2025-11-25/)
    expect(fixture.methods).toEqual(expect.arrayContaining(['server/discover', 'initialize', 'notifications/initialized', 'tools/list']))

    await card.getByRole('button', { name: '连接', exact: true }).click()
    await expect(card.locator('.mcp-connection-badge')).toHaveText('已连接')
    await expect(card.locator('.mcp-remote-meta')).toContainText('Legacy · 2025-11-25')
    await expect(card.locator('.mcp-remote-meta')).toContainText('Fixture MCP Server · 1.0.0')

    const states = await page.evaluate(() => window.origread.getMcpConnectionStates())
    expect(states[0]).toMatchObject({ status: 'CONNECTED', protocolEra: 'LEGACY', protocolVersion: '2025-11-25' })

    await card.getByRole('button', { name: '刷新工具', exact: true }).click()
    await expect(card.locator('.settings-status')).toContainText('工具目录已刷新 · 2 个工具')
    await expect(card.locator('.mcp-remote-meta')).toContainText('已缓存 2 个工具')
    await expect(card.locator('.mcp-tool-row')).toHaveCount(2)
    await expect(card.locator('.mcp-tool-row').filter({ hasText: 'Read article' })).toContainText('服务端标记：只读')
    await expect(card.locator('.mcp-tool-row').filter({ hasText: 'Search notes' })).toContainText('服务端标记：可能访问外部资源')

    const requestCountBeforeCachedRead = fixture.requests.length
    const catalog = await page.evaluate(() => window.origread.getMcpToolCatalog())
    expect(fixture.requests).toHaveLength(requestCountBeforeCachedRead)
    expect(catalog.servers).toHaveLength(1)
    expect(catalog.servers[0]).toMatchObject({ serverName: 'Fixture MCP', stale: false })
    expect(catalog.servers[0]?.tools.map((tool) => tool.rawName)).toEqual(['read_article', 'search_notes'])
    expect(catalog.servers[0]?.tools[0]?.id).toBe(`mcp:${publicSettings.servers[0]!.id}:read_article`)
    expect(catalog.servers[0]?.tools[0]?.providerName).toMatch(/^mcp_[0-9a-f]{8}_read_article$/)

    await card.getByRole('button', { name: '断开', exact: true }).click()
    await expect(card.locator('.mcp-connection-badge')).toHaveText('未连接')

    const authSelect = card.locator('.provider-field select').first()
    await authSelect.selectOption('BEARER')
    const bearerInput = card.locator('.secret-key-input')
    await bearerInput.fill('fixture-bearer-secret')
    await card.locator('.secret-key-save').click()
    const bearerPublicSettings = await page.evaluate(() => window.origread.getMcpRemoteSettings())
    expect(bearerPublicSettings.servers[0]).toMatchObject({ authMode: 'BEARER', hasCredential: true })
    expect(JSON.stringify(bearerPublicSettings)).not.toContain('fixture-bearer-secret')
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.settings-status')).toContainText('连接正常')
    expect(fixture.authorizationHeaders).toContain('Bearer fixture-bearer-secret')

    await authSelect.selectOption('CUSTOM_HEADERS')
    await card.getByRole('button', { name: '显示凭据' }).click()
    const customHeaders = card.locator('.mcp-custom-headers-editor textarea')
    await customHeaders.fill('X-Api-Key: fixture-custom-key')
    await card.locator('.mcp-custom-headers-editor').getByRole('button', { name: '保存凭据' }).click()
    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.settings-status')).toContainText('连接正常')
    expect(fixture.apiKeyHeaders).toContain('fixture-custom-key')
    const customPublicSettings = await page.evaluate(() => window.origread.getMcpRemoteSettings())
    expect(JSON.stringify(customPublicSettings)).not.toContain('fixture-custom-key')

    const requestCountBeforeOAuthMode = fixture.requests.length
    await authSelect.selectOption('OAUTH')
    await expect(card.locator('.mcp-oauth-field')).toContainText('尚未授权')
    await expect(card.locator('.mcp-oauth-field').getByRole('button', { name: '授权', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: '测试连接' })).toBeDisabled()
    expect(fixture.requests).toHaveLength(requestCountBeforeOAuthMode)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

test('Remote MCP isolates a dead server and enforces the health-check network timeout', async () => {
  test.setTimeout(35_000)
  const deadUrl = await allocateClosedEndpoint()
  const hanging = await startHangingMcpFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const dead = await page.evaluate(async (url) => {
      const added = await window.origread.addMcpRemoteServer()
      const server = added.servers[0]
      if (!server) throw new Error('Dead MCP test server missing')
      await window.origread.updateMcpRemoteServer({ id: server.id, name: 'Dead MCP', url, enabled: true })
      return window.origread.testMcpRemoteServer(server.id)
    }, deadUrl)
    expect(dead.ok).toBe(false)
    expect(dead.error).toBeTruthy()

    const slow = await page.evaluate(async (url) => {
      const added = await window.origread.addMcpRemoteServer()
      const server = added.servers.at(-1)
      if (!server) throw new Error('Slow MCP test server missing')
      await window.origread.updateMcpRemoteServer({ id: server.id, name: 'Slow MCP', url, enabled: true })
      const startedAt = Date.now()
      const result = await window.origread.testMcpRemoteServer(server.id)
      return { result, elapsedMs: Date.now() - startedAt }
    }, hanging.url)
    expect(slow.result.ok).toBe(false)
    expect(slow.result.error).toBeTruthy()
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(9_000)
    expect(slow.elapsedMs).toBeLessThan(20_000)

    const requestsBeforeCachedRead = hanging.requests
    await page.evaluate(() => window.origread.getMcpToolCatalog())
    expect(hanging.requests).toBe(requestsBeforeCachedRead)
  } finally {
    await testApp.close()
    hanging.server.closeAllConnections()
    await closeServer(hanging.server)
  }
})

async function startLegacyMcpFixture(): Promise<{
  server: Server
  url: string
  requests: string[]
  methods: string[]
  authorizationHeaders: string[]
  apiKeyHeaders: string[]
}> {
  const requests: string[] = []
  const methods: string[] = []
  const authorizationHeaders: string[] = []
  const apiKeyHeaders: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(202).end()
      return
    }
    readBody(request).then((body) => {
      requests.push(body)
      authorizationHeaders.push(request.headers.authorization ?? '')
      apiKeyHeaders.push(typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : '')
      const message = JSON.parse(body) as { id?: string | number; method?: string }
      if (message.method) methods.push(message.method)
      if (message.method === 'server/discover') {
        respondJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      if (message.method === 'initialize') {
        respondJson(response, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-mcp', title: 'Fixture MCP Server', version: '1.0.0' }
          }
        })
        return
      }
      if (message.method === 'tools/list') {
        respondJson(response, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              { name: 'read_article', title: 'Read article', description: 'Read an article', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
              { name: 'search_notes', title: 'Search notes', description: 'Search notes', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { openWorldHint: true } }
            ]
          }
        })
        return
      }
      response.writeHead(202).end()
    }).catch(() => response.writeHead(400).end())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP fixture port missing')
  return { server, url: `http://127.0.0.1:${address.port}/mcp`, requests, methods, authorizationHeaders, apiKeyHeaders }
}

async function allocateClosedEndpoint(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Dead MCP fixture port missing')
  const url = `http://127.0.0.1:${address.port}/mcp`
  await closeServer(server)
  return url
}

async function startHangingMcpFixture(): Promise<{ server: Server; url: string; readonly requests: number }> {
  let requests = 0
  const server = createServer((request) => {
    requests += 1
    request.resume()
    // Intentionally never respond. The product's health-check timeout must abort this request.
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Slow MCP fixture port missing')
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mcp`,
    get requests() { return requests }
  }
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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
