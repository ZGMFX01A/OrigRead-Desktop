import { createServer, type Server } from 'node:http'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader original-text Ask AI selection is one-shot, auditable, and preserved by Regenerate only', async () => {
  test.setTimeout(30_000)
  const fixture = await startSelectionFixture()
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, baseUrl }) => {
      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'selection-model',
        models: ['selection-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      const added = await window.origread.addRssSource(feedUrl)
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { feedUrl: `${baseUrl}/feed.xml`, baseUrl })

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    const articleBody = page.locator('.article-body:not(.translated-article-body)')
    await expect(articleBody).toContainText('Revenue rose by 20 percent')

    const selectedText = 'Revenue rose by 20 percent because enterprise renewals increased.'
    await articleBody.evaluate((body, text) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      while (walker.nextNode()) {
        const current = walker.currentNode as Text
        if (current.data.includes(text)) {
          node = current
          break
        }
      }
      if (!node) throw new Error('Selection fixture text node not found')
      const start = node.data.indexOf(text)
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }, selectedText)

    const askSelection = page.getByRole('button', { name: '问 AI' })
    await expect(askSelection).toBeVisible()
    await askSelection.click()
    await expect(page.locator('.reader-ai-selection-context')).toContainText('已选原文')
    await expect(page.locator('.reader-ai-selection-context')).toContainText('Revenue rose by 20 percent')
    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await expect(composer).toBeFocused()
    await composer.fill('What does this evidence imply?')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Selection answer')
    await expect(page.locator('.reader-ai-selection-context')).toHaveCount(0)
    expect(findContextEvidenceId(
      fixture.requests()[0] ?? '',
      'SELECTED_TEXT',
      'Revenue rose by 20 percent because enterprise renewals increased.'
    )).not.toBeNull()
    const firstAssistant = page.locator('.reader-ai-message.assistant').last()
    const citation = firstAssistant.locator('.reader-ai-inline-citation').first()
    await expect(citation).toBeVisible()
    const highlightedEvidence = page.locator('.article-body:not(.translated-article-body) .origread-citation-highlight')
    const readerCitationMarker = articleBody.locator('.origread-reader-citation-marker').first()
    // Citation markers appear as soon as the cited answer is complete; Sources does not need to be opened first.
    await expect(readerCitationMarker).toBeVisible()
    await expect(readerCitationMarker).toHaveText('[1]')
    await readerCitationMarker.click()
    await expect(highlightedEvidence).toContainText('Revenue rose by 20 percent')
    await page.locator('.reader-content').dispatchEvent('scroll')
    await expect(highlightedEvidence).toHaveCount(0)

    await citation.hover()
    await expect(firstAssistant.locator('.reader-ai-inline-citation-popover').first()).toContainText('Selection source article')
    await expect(firstAssistant.locator('.reader-ai-inline-citation-popover').first()).toContainText('Revenue rose by 20 percent')

    // Move far away before the inline citation click. One click must both reposition the Reader
    // and leave the target visibly highlighted; it must not require a second click after scrolling.
    await page.locator('.reader-content').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await citation.click()
    await expect(highlightedEvidence).toContainText('Revenue rose by 20 percent')
    const citationVisibleAfterFirstClick = await highlightedEvidence.evaluate((element) => {
      const target = element.getBoundingClientRect()
      const reader = document.querySelector('.reader-content')?.getBoundingClientRect()
      if (!reader) return false
      return target.bottom > reader.top && target.top < reader.bottom
    })
    expect(citationVisibleAfterFirstClick).toBe(true)
    const citationFeedback = await highlightedEvidence.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return { animationName: style.animationName, animationDuration: style.animationDuration }
    })
    expect(citationFeedback.animationName).toBe('reader-citation-highlight-feedback')
    expect(citationFeedback.animationDuration).toBe('1.05s')
    await expect(highlightedEvidence).toHaveCount(0, { timeout: 2_000 })

    await firstAssistant.getByRole('button', { name: '来源' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail', 'sources')
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('原文选区')
    await expect(page.locator('.reader-ai-sources-detail')).toContainText(selectedText)
    await expect(readerCitationMarker).toBeVisible()
    await expect(readerCitationMarker).toHaveText('[1]')

    await page.locator('.reader-content').dispatchEvent('scroll')
    await expect(highlightedEvidence).toHaveCount(0)
    await readerCitationMarker.click()
    await expect(highlightedEvidence).toContainText('Revenue rose by 20 percent')

    await page.locator('.reader-content').dispatchEvent('scroll')
    await expect(highlightedEvidence).toHaveCount(0)
    await page.locator('.reader-ai-source-citations button').first().click()
    await expect(highlightedEvidence).toContainText('Revenue rose by 20 percent')
    await page.getByRole('button', { name: '返回' }).click()

    const firstSnapshot = await latestAssistantContext(page, articleId)
    expect(firstSnapshot.contextRefs.map((ref) => ref.type)).toContain('ARTICLE')
    expect(firstSnapshot.contextRefs.map((ref) => ref.type)).toContain('SELECTED_TEXT')
    expect(firstSnapshot.contextRefs.find((ref) => ref.type === 'SELECTED_TEXT')).toMatchObject({
      articleId,
      contentSnapshot: selectedText,
      includedInPrompt: true
    })
    const firstAssistantMessageId = await latestAssistantMessageId(page, articleId)
    expect(fixture.requests()[0]).toContain('ORIGREAD_CONTEXT type=SELECTED_TEXT')

    // The UI attachment has already been consumed. Regenerate must still use the selection
    // frozen on the previous Assistant, rather than relying on current Renderer state.
    await page.getByRole('button', { name: '重新生成' }).click()
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Selection answer')
    const regeneratedSnapshot = await latestAssistantContext(page, articleId)
    expect(regeneratedSnapshot.contextRefs.find((ref) => ref.type === 'SELECTED_TEXT')).toMatchObject({
      contentSnapshot: selectedText,
      includedInPrompt: true
    })
    expect(fixture.requests()[1]).toContain('ORIGREAD_CONTEXT type=SELECTED_TEXT')

    const ordinaryComposer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await ordinaryComposer.fill('Now answer normally from the article.')
    await ordinaryComposer.press('Enter')
    await expect(page.locator('.reader-ai-user-bubble')).toHaveCount(2)
    const ordinaryAssistant = page.locator('.reader-ai-message.assistant').last()
    await expect(ordinaryAssistant.locator('.reader-ai-inline-citation')).toHaveCount(1)
    await ordinaryAssistant.locator('.reader-ai-inline-citation').click()
    await expect(page.locator('.article-body:not(.translated-article-body) .origread-citation-highlight')).toContainText('Operating margin also improved')
    const ordinarySnapshot = await latestAssistantContext(page, articleId)
    expect(ordinarySnapshot.contextRefs.map((ref) => ref.type)).toContain('ARTICLE')
    expect(ordinarySnapshot.contextRefs.some((ref) => ref.type === 'SELECTED_TEXT')).toBe(false)
    expect(fixture.requests()[2]).not.toContain('ORIGREAD_CONTEXT type=SELECTED_TEXT')

    await page.reload()
    await page.locator(`.article-item[data-article-id="${articleId}"]`).click()
    await page.keyboard.press('a')
    await page.getByRole('button', { name: '对话历史' }).click()
    await page.locator('.reader-ai-history-main').first().click()
    await expect(page.locator('.reader-ai-inline-citation')).toHaveCount(2)
    await page.locator('.reader-ai-message.assistant').last().getByRole('button', { name: '来源' }).click()
    await expect(page.locator('.reader-ai-sources-detail')).toContainText('Operating margin also improved')
    const frozenInactiveBranch = await page.evaluate(
      (assistantMessageId) => window.origread.getLlmAssistantEvidence(assistantMessageId),
      firstAssistantMessageId
    )
    expect(frozenInactiveBranch.citations).toHaveLength(1)
    expect(frozenInactiveBranch.citations[0]?.quoteSnapshot).toBe(selectedText)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function latestAssistantContext(page: Page, articleId: string) {
  return page.evaluate(async (targetArticleId) => {
    const conversation = (await window.origread.listLlmConversations(targetArticleId))[0]
    if (!conversation) throw new Error('Reader AI conversation is missing')
    const messages = await window.origread.getLlmMessages(conversation.id)
    const assistant = messages.filter((message) => message.role === 'ASSISTANT' && message.historyActive).at(-1)
    if (!assistant) throw new Error('Active Assistant message is missing')
    return window.origread.getLlmAssistantEvidence(assistant.id)
  }, articleId)
}

async function latestAssistantMessageId(page: Page, articleId: string): Promise<string> {
  return page.evaluate(async (targetArticleId) => {
    const conversation = (await window.origread.listLlmConversations(targetArticleId))[0]
    if (!conversation) throw new Error('Reader AI conversation is missing')
    const messages = await window.origread.getLlmMessages(conversation.id)
    const assistant = messages.filter((message) => message.role === 'ASSISTANT' && message.historyActive).at(-1)
    if (!assistant) throw new Error('Active Assistant message is missing')
    return assistant.id
  }, articleId)
}

async function startSelectionFixture(): Promise<{ server: Server; requests(): string[] }> {
  const requests: string[] = []
  const filler = Array.from({ length: 80 }, (_value, index) => `<p>Long article filler paragraph ${index + 1} keeps citation navigation meaningfully distant.</p>`).join('')
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>D7.3 Selection</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Selection source article</title><link>http://127.0.0.1/article</link><guid>d7-3-selection</guid><description><![CDATA[
<h2>Results</h2>
<p>Revenue rose by 20 percent because enterprise renewals increased.</p>
${filler}
<p>Operating margin also improved while support costs remained stable.</p>
]]></description></item></channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requests.push(body)
        const selectedContext = body.includes('ORIGREAD_CONTEXT type=SELECTED_TEXT')
        const evidenceId = selectedContext
          ? findContextEvidenceId(body, 'SELECTED_TEXT', 'Revenue rose by 20 percent because enterprise renewals increased.')
          : findContextEvidenceId(body, 'ARTICLE', 'Operating margin also improved while support costs remained stable.')
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking original evidence' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: evidenceId ? `Selection answer [[${evidenceId}]]` : 'Selection answer' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests: () => [...requests] }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function findContextEvidenceId(rawRequest: string, contextType: string, marker: string): string | null {
  try {
    const parsed = JSON.parse(rawRequest) as { messages?: Array<{ role?: string; content?: string }> }
    const system = parsed.messages?.find((message) => message.role === 'system')?.content ?? ''
    const contextStart = system.indexOf(`[ORIGREAD_CONTEXT type=${contextType} `)
    if (contextStart < 0) return null
    const contextEnd = system.indexOf('[/ORIGREAD_CONTEXT]', contextStart)
    const scoped = system.slice(contextStart, contextEnd >= 0 ? contextEnd : undefined)
    const markerIndex = scoped.indexOf(marker)
    if (markerIndex < 0) return null
    const matches = [...scoped.slice(0, markerIndex).matchAll(/\[ORIGREAD_EVIDENCE id="(E\d+)"\]/g)]
    return matches.at(-1)?.[1] ?? null
  } catch {
    return null
  }
}
