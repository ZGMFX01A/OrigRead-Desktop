import { createServer, type Server } from 'node:http'
import { expect, test, type Locator } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader AI Chat keeps scroll ownership across long streaming, resize, placement and dark theme', async () => {
  test.setTimeout(50_000)
  const server = await startLongChatFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, baseUrl }) => {
      await window.origread.updateSettings({
        language: 'zh',
        theme: 'light',
        layoutMode: 'two-pane',
        workspaceCollapsed: false,
        aiSummaryPlacement: 'right',
        aiSummaryPanelSize: 360
      })
      const added = await window.origread.addRssSource(feedUrl)
      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'fixture-long-chat-model',
        models: ['fixture-long-chat-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { feedUrl: `${baseUrl}/feed.xml`, baseUrl })

    await page.reload()
    await page.setViewportSize({ width: 1600, height: 900 })
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')

    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    for (let index = 1; index <= 4; index += 1) {
      await composer.fill(`long turn ${index}`)
      await composer.press('Enter')
      await expect(page.locator('.reader-ai-message.assistant')).toHaveCount(index)
      await expect(page.locator('.reader-ai-message.assistant').last()).toContainText(`END-NORMAL-${index}`)
    }

    const timeline = page.locator('.reader-ai-chat-timeline')
    await expect.poll(async () => timeline.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300)
    await expect.poll(async () => distanceToBottom(timeline)).toBeLessThanOrEqual(4)

    // Placement is visual only: moving AI left/right must not remount Reader or Chat and lose local scroll/focus state.
    const readerContent = page.locator('.reader-content')
    await timeline.evaluate((element) => { element.setAttribute('data-e2e-stable-node', 'timeline') })
    await readerContent.evaluate((element) => { element.setAttribute('data-e2e-stable-node', 'reader') })
    const rightBoxes = await panelAndReaderBoxes(page.locator('.reader-ai-panel'), readerContent)
    expect(rightBoxes.panel.x).toBeGreaterThan(rightBoxes.reader.x)

    await page.locator('.reader-ai-panel-actions select').selectOption('left')
    await expect(page.locator('.reader-composite')).toHaveClass(/summary-left/)
    await expect(timeline).toHaveAttribute('data-e2e-stable-node', 'timeline')
    await expect(readerContent).toHaveAttribute('data-e2e-stable-node', 'reader')
    const leftBoxes = await panelAndReaderBoxes(page.locator('.reader-ai-panel'), readerContent)
    expect(leftBoxes.panel.x).toBeLessThan(leftBoxes.reader.x)
    await expect.poll(async () => distanceToBottom(timeline)).toBeLessThanOrEqual(4)

    await page.locator('.reader-ai-panel-actions select').selectOption('right')
    await expect(page.locator('.reader-composite')).toHaveClass(/summary-right/)
    await expect(timeline).toHaveAttribute('data-e2e-stable-node', 'timeline')
    await expect(readerContent).toHaveAttribute('data-e2e-stable-node', 'reader')

    // Start a genuinely multi-chunk stream, then scroll upward after the first visible chunk.
    // Later chunks and panel reflow must not steal ownership back from the user.
    await composer.fill('stream long')
    await composer.press('Enter')
    const streamingAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(streamingAssistant).toContainText('STREAM-START')
    await timeline.hover()
    await page.mouse.wheel(0, -520)
    await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
    const pausedTop = await timeline.evaluate((element) => element.scrollTop)

    await expect(streamingAssistant).toContainText('STREAM-MIDDLE')
    await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
    const afterMiddleTop = await timeline.evaluate((element) => element.scrollTop)
    expect(Math.abs(afterMiddleTop - pausedTop)).toBeLessThan(40)
    expect(await distanceToBottom(timeline)).toBeGreaterThan(120)

    // Narrowing increases wrapping/scrollHeight. The user-paused state must survive the ResizeObserver reflow.
    const panel = page.locator('.reader-ai-panel')
    await panel.getByRole('button', { name: 'AI 面板尺寸' }).click()
    const sizeSlider = panel.getByRole('slider', { name: 'AI 面板宽度' })
    await sizeSlider.fill('220')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).aiSummaryPanelSize).toBe(220)
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(219)
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThanOrEqual(221)
    await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()

    await expect(streamingAssistant).toContainText('STREAM-END')
    await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible()
    expect(await distanceToBottom(timeline)).toBeGreaterThan(120)

    await page.getByRole('button', { name: '回到底部' }).click()
    await expect(page.getByRole('button', { name: '回到底部' })).toBeHidden()
    await expect.poll(async () => distanceToBottom(timeline)).toBeLessThanOrEqual(4)

    // While following, widening to the maximum must keep the viewport anchored to the end.
    const maxSizeSlider = panel.getByRole('slider', { name: 'AI 面板宽度' })
    if (!await maxSizeSlider.isVisible()) {
      await panel.getByRole('button', { name: 'AI 面板尺寸' }).click()
    }
    await maxSizeSlider.fill('640')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).aiSummaryPanelSize).toBe(640)
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(639)
    await expect.poll(async () => distanceToBottom(timeline)).toBeLessThanOrEqual(4)

    // Theme is persisted independently of the conversation. Reload, reopen the same Conversation, then validate
    // the real Chat surfaces rather than only checking the root data-theme flag.
    await page.evaluate(async () => {
      await window.origread.updateSettings({ theme: 'dark' })
      window.location.reload()
    })
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    const darkArticle = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(darkArticle).toBeVisible()
    await darkArticle.click()
    await page.keyboard.press('a')
    await page.getByRole('button', { name: '对话历史' }).click()
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(1)
    await page.locator('.reader-ai-history-main').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-message.assistant')).toHaveCount(5)

    await expectDarkSurface(page.locator('.reader-ai-panel'))
    await expectDarkSurface(page.locator('.reader-ai-composer'))
    await expectDarkSurface(page.locator('.reader-ai-user-bubble').first())
    await page.locator('.reader-ai-model-label').click()
    await expectDarkSurface(page.locator('.reader-ai-model-popover'))
    await page.locator('.reader-ai-model-label').click()
    const lastAssistant = page.locator('.reader-ai-message.assistant').last()
    await lastAssistant.locator('.reader-ai-message-usage > summary').click()
    await expectDarkSurface(lastAssistant.locator('.reader-ai-message-usage-popover'))
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function panelAndReaderBoxes(panel: Locator, reader: Locator) {
  const panelBox = await panel.boundingBox()
  const readerBox = await reader.boundingBox()
  if (!panelBox || !readerBox) throw new Error('Reader AI panel layout box is unavailable')
  return { panel: panelBox, reader: readerBox }
}

async function distanceToBottom(timeline: Locator): Promise<number> {
  return timeline.evaluate((element) => Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop))
}

async function expectDarkSurface(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const rgb = await locator.evaluate((element) => getComputedStyle(element).backgroundColor)
  const channels = rgb.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? []
  expect(channels).toHaveLength(3)
  expect(Math.max(...channels)).toBeLessThan(100)
}

async function startLongChatFixtureServer(): Promise<Server> {
  let normalRequestCount = 0
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Reader AI Long Chat</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Reader AI Long Chat Article</title><link>http://127.0.0.1/article</link><guid>reader-ai-long-chat-article</guid><description><![CDATA[<h2>Long reading</h2><p>This article provides enough context for a long Reader AI conversation.</p>]]></description></item>
</channel></rss>`)
      return
    }

    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking long conversation' }, finish_reason: null }] })}\n\n`)

        if (body.includes('stream long')) {
          const write = (content: string): void => {
            if (response.destroyed || response.writableEnded) return
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
          }
          write(`STREAM-START ${longParagraph('start')} `)
          setTimeout(() => write(`STREAM-MIDDLE ${longParagraph('middle')} `), 650)
          setTimeout(() => write(`STREAM-END ${longParagraph('end')} `), 1_350)
          setTimeout(() => {
            if (response.destroyed || response.writableEnded) return
            response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
            response.end('data: [DONE]\n\n')
          }, 1_800)
          return
        }

        normalRequestCount += 1
        const content = `Long answer ${normalRequestCount}. ${longParagraph(`normal-${normalRequestCount}`)} END-NORMAL-${normalRequestCount}`
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`)
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

function longParagraph(marker: string): string {
  return Array.from(
    { length: 42 },
    (_, index) => `${marker} section ${index + 1} explains the article with enough detail to exercise wrapping and long-chat scrolling.`
  ).join(' ')
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
