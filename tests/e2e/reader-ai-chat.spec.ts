import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Reader AI Chat creates on first send, streams in Panel, preserves A toggle state, and stops safely', async () => {
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
      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('Default AI provider is missing')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'fixture-chat-model',
        models: ['fixture-chat-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { feedUrl: `${baseUrl}/feed.xml`, baseUrl })

    const alternateProviderId = await page.evaluate(async (baseUrl) => {
      const settings = await window.origread.addAiProvider()
      const alternate = settings.providers.at(-1)
      if (!alternate) throw new Error('Alternate AI provider was not created')
      await window.origread.updateAiProvider({
        id: alternate.id,
        name: 'Alternate fixture',
        endpoint: `${baseUrl}/v1`,
        defaultModel: 'fixture-alt-model',
        models: ['fixture-alt-model'],
        apiKey: ''
      })
      return alternate.id
    }, baseUrl)

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Revenue rose by 20 percent')

    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(0)
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.getByRole('textbox', { name: '问问这篇文章……' })).toBeVisible()
    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(0)

    const refreshedAlternateModels = [
      'fixture-alt-model',
      'deepseek-v4-flash-0731',
      'deepseek-v4-pro-0813',
      'gemini-2.5-pro-1m',
      'gemini-3.1-pro-preview',
      'glm-5.2',
      'gpt-5.6-luna',
      'grok-4.5',
      'grok-4.6',
      'this-is-an-extremely-long-model-name-that-must-not-stretch-the-picker-until-selected'
    ]
    // Reproduce the real bug: the AI panel is already open when Settings updates the provider model cache.
    await page.evaluate(async ({ providerId, models }) => {
      await window.origread.updateAiProvider({ id: providerId, models })
    }, { providerId: alternateProviderId, models: refreshedAlternateModels })
    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.reader-ai-panel')).toBeVisible()

    await page.locator('.reader-ai-model-label').click()
    const providerSelect = page.getByRole('combobox', { name: 'AI Provider' })
    const modelSelect = page.getByRole('combobox', { name: '默认模型' })
    await expect(providerSelect).toBeVisible()
    await providerSelect.selectOption(alternateProviderId)
    await expect(modelSelect).toHaveValue('fixture-alt-model')
    await expect(modelSelect.locator('option')).toHaveCount(refreshedAlternateModels.length)
    for (const modelName of refreshedAlternateModels) await expect(modelSelect.locator('option', { hasText: modelName })).toHaveCount(1)
    const modelPopoverWidth = await page.locator('.reader-ai-model-popover').evaluate((element) => element.getBoundingClientRect().width)
    expect(modelPopoverWidth).toBeGreaterThanOrEqual(208)
    expect(modelPopoverWidth).toBeLessThan(300)

    await modelSelect.selectOption('grok-4.6')
    await expect(page.locator('.reader-ai-model-popover')).toBeHidden()
    await expect(page.locator('.reader-ai-model-label')).toContainText('grok-4.6')
    await page.locator('.reader-ai-model-label').click()
    await page.getByRole('combobox', { name: '默认模型' }).selectOption('fixture-alt-model')
    await expect(page.locator('.reader-ai-model-popover')).toBeHidden()
    await expect(page.locator('.reader-ai-model-label')).toContainText('fixture-alt-model')

    const composer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await composer.fill('What changed?')
    await composer.press('Enter')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('What changed?')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Revenue rose')
    await expect(page.locator('.reader-ai-message.assistant .reader-ai-inline-citation')).toHaveText('1')
    await expect(page.locator('.reader-ai-message.assistant')).not.toContainText('[[E2]]')
    await expect(page.locator('.reader-ai-model-label')).toContainText('Alternate fixture · fixture-alt-model')

    // Ctrl+F inside AI Chat searches the current conversation, not the Reader article.
    // The result references the real message node; selecting it returns to Chat and highlights that node briefly.
    await page.keyboard.press('Control+f')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail', 'chat-search')
    const chatSearch = page.getByRole('textbox', { name: '搜索当前对话' })
    await expect(chatSearch).toBeFocused()
    await chatSearch.fill('What changed')
    await expect(page.locator('.reader-ai-chat-search-result')).toHaveCount(1)
    await expect(page.locator('.reader-ai-chat-search-result')).toContainText('你')
    await expect(page.locator('.reader-ai-chat-search-result')).toContainText('What changed?')
    await page.locator('.reader-ai-chat-search-result').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail', '')
    await expect(page.locator('.reader-ai-message.user.search-highlight')).toHaveCount(1)

    const firstConversation = await page.evaluate(async (id) => {
      const conversations = await window.origread.listLlmConversations(id)
      const conversation = conversations[0]
      if (!conversation) throw new Error('Conversation was not created')
      return { conversation, messages: await window.origread.getLlmMessages(conversation.id) }
    }, articleId)
    expect(firstConversation.messages).toHaveLength(2)
    expect(firstConversation.conversation).toMatchObject({ providerId: alternateProviderId, model: 'fixture-alt-model' })
    expect(firstConversation.messages[0]).toMatchObject({ role: 'USER', content: 'What changed?' })
    expect(firstConversation.messages[1]).toMatchObject({
      role: 'ASSISTANT',
      content: 'Revenue rose [[E2]]',
      status: 'COMPLETE',
      providerId: alternateProviderId,
      model: 'fixture-alt-model',
      tokenUsageEstimated: true
    })
    expect(firstConversation.messages[1]?.promptTokens).toBeGreaterThan(0)
    expect(firstConversation.messages[1]?.completionTokens).toBeGreaterThan(0)
    expect(firstConversation.messages[1]?.durationMs).toBeGreaterThanOrEqual(0)

    await page.locator('.reader-ai-model-label').click()
    await expect(page.locator('.reader-ai-model-popover')).toContainText('切换后从下一次回答开始生效')
    const defaultProviderId = await page.evaluate(async () => (await window.origread.getAiSettings()).defaultProviderId)
    await page.getByRole('combobox', { name: 'AI Provider' }).selectOption(defaultProviderId)
    await expect(page.getByRole('combobox', { name: '默认模型' })).toHaveValue('fixture-chat-model')
    await page.locator('.reader-ai-model-label').click()
    await expect(page.locator('.reader-ai-model-label')).toContainText('fixture-chat-model')

    const firstAssistant = page.locator('.reader-ai-message.assistant').first()
    await expect(firstAssistant.getByRole('button', { name: '复制' })).toBeVisible()
    await firstAssistant.locator('.reader-ai-message-usage > summary').click()
    await expect(firstAssistant.locator('.reader-ai-message-usage-popover')).toContainText('Alternate fixture · fixture-alt-model')
    await expect(firstAssistant.locator('.reader-ai-message-usage-popover')).toContainText('输入')
    await expect(firstAssistant.locator('.reader-ai-message-usage-popover')).toContainText('输出')
    await expect(firstAssistant.locator('.reader-ai-message-usage-popover')).toContainText('Token 数为估算值')
    await firstAssistant.locator('.reader-ai-message-usage > summary').click()
    await expect(firstAssistant.getByRole('button', { name: '重新生成' })).toBeVisible()

    const followUpComposer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await followUpComposer.fill('And why?')
    await followUpComposer.press('Enter')
    await expect(page.locator('.reader-ai-user-bubble')).toHaveCount(2)
    await expect(page.locator('.reader-ai-message.assistant')).toHaveCount(2)
    const switchedConversation = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation disappeared')
      return { conversation, messages: await window.origread.getLlmMessages(conversation.id) }
    }, articleId)
    expect(switchedConversation.conversation).toMatchObject({ providerId: defaultProviderId, model: 'fixture-chat-model' })
    expect(switchedConversation.messages.filter((message) => message.role === 'ASSISTANT')).toMatchObject([
      { providerId: alternateProviderId, model: 'fixture-alt-model' },
      { providerId: defaultProviderId, model: 'fixture-chat-model' }
    ])
    await expect(page.locator('.reader-ai-message.assistant')).toHaveCount(2)
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Revenue rose')
    const afterFollowUp = await page.evaluate(async (id) => {
      const conversations = await window.origread.listLlmConversations(id)
      if (!conversations[0]) throw new Error('Conversation missing after follow-up')
      return { count: conversations.length, messages: await window.origread.getLlmMessages(conversations[0].id) }
    }, articleId)
    expect(afterFollowUp.count).toBe(1)
    expect(afterFollowUp.messages).toHaveLength(4)
    expect(afterFollowUp.messages[2]).toMatchObject({ role: 'USER', content: 'And why?' })

    // Regenerate branches from the latest Assistant: no duplicate USER, old answer stays auditable but inactive.
    const supersededAssistantId = afterFollowUp.messages[3]?.id
    if (!supersededAssistantId) throw new Error('Latest assistant missing before regenerate')
    await page.getByRole('button', { name: '重新生成' }).click()
    await expect(page.locator('.reader-ai-message.assistant').last()).toContainText('Revenue rose')
    const afterRegenerate = await page.evaluate(async (id) => {
      const conversation = (await window.origread.listLlmConversations(id))[0]
      if (!conversation) throw new Error('Conversation missing after regenerate')
      return await window.origread.getLlmMessages(conversation.id)
    }, articleId)
    expect(afterRegenerate.filter((message) => message.role === 'USER')).toHaveLength(2)
    expect(afterRegenerate).toHaveLength(5)
    expect(afterRegenerate.find((message) => message.id === supersededAssistantId)).toMatchObject({ historyActive: false })
    expect(afterRegenerate.at(-1)).toMatchObject({ role: 'ASSISTANT', historyActive: true, status: 'COMPLETE' })

    const scrollStage = page.locator('.reader-ai-chat-scroll-stage')
    const timeline = page.locator('.reader-ai-chat-timeline')
    await scrollStage.evaluate((element) => { (element as HTMLElement).style.height = '150px' })
    await timeline.evaluate((element) => {
      const node = element as HTMLElement
      node.scrollTop = Math.max(1, (node.scrollHeight - node.clientHeight) / 2)
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    const jumpTop = page.getByRole('button', { name: '回到顶部' })
    const jumpBottom = page.getByRole('button', { name: '回到底部' })
    await expect(jumpTop).toBeVisible()
    await expect(jumpBottom).toBeVisible()
    const [stageBox, jumpsBox] = await Promise.all([
      scrollStage.boundingBox(),
      page.locator('.reader-ai-scroll-jumps').boundingBox()
    ])
    if (!stageBox || !jumpsBox) throw new Error('Scroll jump geometry missing')
    expect(Math.abs((jumpsBox.y + jumpsBox.height / 2) - (stageBox.y + stageBox.height / 2))).toBeLessThan(3)
    expect(stageBox.x + stageBox.width - (jumpsBox.x + jumpsBox.width)).toBeLessThan(10)
    await jumpTop.click()
    await expect.poll(() => timeline.evaluate((element) => (element as HTMLElement).scrollTop)).toBeLessThan(5)
    await expect(jumpBottom).toBeVisible()
    await jumpBottom.click()
    await expect.poll(() => timeline.evaluate((element) => {
      const node = element as HTMLElement
      return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)
    })).toBeLessThan(5)

    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toBeHidden()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble').first()).toContainText('What changed?')

    // History is an in-Panel detail surface with search + inline rename; opening it never creates a conversation.
    await page.getByRole('button', { name: '对话历史' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-surface', 'detail')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-detail', 'conversation-history')
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(1)
    const firstHistoryItem = page.locator('.reader-ai-history-item').first()
    await firstHistoryItem.getByRole('button', { name: '重命名' }).click()
    const titleInput = firstHistoryItem.getByRole('textbox', { name: '对话标题' })
    await titleInput.fill('Revenue discussion')
    await firstHistoryItem.getByRole('button', { name: '保存' }).click()
    await expect(firstHistoryItem).toContainText('Revenue discussion')
    const historySearch = page.getByRole('textbox', { name: '搜索对话' })
    await historySearch.fill('Revenue')
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(1)
    await historySearch.fill('missing')
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(0)
    await historySearch.fill('')
    await page.getByRole('button', { name: '返回' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')

    await page.getByRole('button', { name: '新建对话' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(1)

    const secondComposer = page.getByRole('textbox', { name: '问问这篇文章……' })
    await secondComposer.fill('slow question')
    await secondComposer.press('Enter')
    await expect(page.locator('.reader-ai-reasoning-stream')).toContainText('checking article')
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.locator('.reader-ai-message-status')).toContainText('已停止')
    await expect(page.locator('.reader-ai-message.assistant').last().getByRole('button', { name: '重试' })).toBeVisible()
    const conversationsAfterStop = await page.evaluate(async (id) => {
      const conversations = await window.origread.listLlmConversations(id)
      const latest = conversations[0]
      if (!latest) throw new Error('Stopped conversation missing')
      return { count: conversations.length, messages: await window.origread.getLlmMessages(latest.id) }
    }, articleId)
    expect(conversationsAfterStop.count).toBe(2)
    expect(conversationsAfterStop.messages.at(-1)).toMatchObject({ role: 'ASSISTANT', status: 'STOPPED', finishReason: 'CANCELLED' })

    // Renderer restart does not lose article conversations; History can reopen the old branch and delete another one safely.
    await page.reload()
    const reloadedArticle = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(reloadedArticle).toBeVisible()
    await reloadedArticle.click()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await page.getByRole('button', { name: '对话历史' }).click()
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(2)
    const reloadSearch = page.getByRole('textbox', { name: '搜索对话' })
    await reloadSearch.fill('Revenue discussion')
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(1)
    await page.locator('.reader-ai-history-main').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.locator('.reader-ai-user-bubble').first()).toContainText('What changed?')

    await page.getByRole('button', { name: '对话历史' }).click()
    await page.getByRole('textbox', { name: '搜索对话' }).fill('slow question')
    const stoppedHistoryItem = page.locator('.reader-ai-history-item').filter({ hasText: 'slow question' })
    await expect(stoppedHistoryItem).toHaveCount(1)
    await stoppedHistoryItem.locator('.reader-ai-history-delete').click()
    await expect(stoppedHistoryItem.locator('.reader-ai-history-delete')).toContainText('确认删除')
    await stoppedHistoryItem.locator('.reader-ai-history-delete').click()
    await expect(page.locator('.reader-ai-history-item')).toHaveCount(0)
    expect(await page.evaluate(async (id) => (await window.origread.listLlmConversations(id)).length, articleId)).toBe(1)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFixtureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Reader AI Chat</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>Reader AI Chat Article</title><link>http://127.0.0.1/article</link><guid>reader-ai-chat-article</guid><description><![CDATA[<h2>Results</h2><p>Revenue rose by 20 percent.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        const slow = body.includes('slow question')
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking article' }, finish_reason: null }] })}\n\n`)
        const finish = (): void => {
          if (response.destroyed || response.writableEnded) return
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Revenue rose [[E2]]' }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
          response.end('data: [DONE]\n\n')
        }
        if (slow) setTimeout(finish, 1_500)
        else finish()
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
