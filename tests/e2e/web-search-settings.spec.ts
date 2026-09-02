import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Dedicated Web Search settings use safe secret reveal and the real provider adapter for health checks', async () => {
  test.setTimeout(30_000)
  const fixture = await startTavilyFixture()
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '网络搜索' }).click()

    const section = page.locator('.settings-section').filter({ has: page.locator('.settings-section-title', { hasText: '网络搜索' }) })
    await expect(section).toBeVisible()
    await section.locator('.setting-row').filter({ hasText: '默认联网' }).locator('select').selectOption('AUTO')
    await section.locator('.setting-row').filter({ hasText: '搜索结果数' }).locator('select').selectOption('8')
    await expect(section.locator('.web-search-kind-select option')).toHaveCount(8)
    expect(await section.locator('.web-search-kind-select option').allTextContents()).toEqual(['Exa','Tavily','Brave Search','Perplexity Search','Linkup','Firecrawl','Keenable','SearXNG'])
    await section.locator('.web-search-kind-select').selectOption('TAVILY')
    await section.locator('.web-search-toolbar').getByRole('button', { name: '添加' }).click()

    const card = section.locator('.web-search-provider-card').first()
    await expect(card).toBeVisible()
    await card.locator('.provider-name').fill('Fixture Tavily')
    await card.locator('.provider-name').blur()
    await card.locator('.provider-field').filter({ hasText: 'Endpoint' }).locator('input').fill(fixture.url)
    await card.locator('.provider-field').filter({ hasText: 'Endpoint' }).locator('input').blur()

    const keyEditor = card.locator('.secret-key-editor')
    const keyInput = keyEditor.locator('.secret-key-input')
    await keyInput.fill('search-secret-value')
    await keyEditor.locator('.secret-key-save').click()
    await expect(keyInput).toHaveValue('')
    await expect(keyInput).toHaveAttribute('type', 'password')
    await expect(keyInput).toHaveAttribute('placeholder', /19/)

    const publicSettings = await page.evaluate(() => window.origread.getWebSearchSettings())
    expect(publicSettings.mode).toBe('AUTO')
    expect(publicSettings.maxResults).toBe(8)
    expect(publicSettings.providers[0]).toMatchObject({ kind: 'TAVILY', name: 'Fixture Tavily', hasApiKey: true, apiKeyLength: 19 })
    expect(JSON.stringify(publicSettings)).not.toContain('search-secret-value')

    await keyEditor.locator('.secret-key-eye').click()
    await expect(keyInput).toHaveAttribute('type', 'text')
    await expect(keyInput).toHaveValue('search-secret-value')
    await keyEditor.locator('.secret-key-eye').click()
    await expect(keyInput).toHaveAttribute('type', 'password')
    await expect(keyInput).toHaveValue('')

    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.settings-status')).toContainText(/连接正常.*1 条结果/)
    await expect.poll(() => fixture.requests.length).toBe(1)
    expect(fixture.requests[0]?.authorization).toBe('Bearer search-secret-value')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'OpenAI', max_results: 1, include_answer: false, include_raw_content: false })
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function startTavilyFixture(): Promise<{
  server: Server
  url: string
  requests: Array<{ authorization: string | undefined; body: string }>
}> {
  const requests: Array<{ authorization: string | undefined; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ authorization: request.headers.authorization, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ results: [{ title: 'Health result', url: 'https://example.com/health', content: 'ok' }] }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Web Search fixture port missing')
  return { server, url: `http://127.0.0.1:${address.port}/search`, requests }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
