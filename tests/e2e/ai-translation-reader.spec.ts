import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('reader generates AI summary and full-article translation through main-process providers', async () => {
  const fixture = await startFixtureServer()
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const base = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async ({ feedUrl, aiEndpoint, dlxEndpoint }) => {
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Missing default AI provider')
      await window.origread.updateAiProvider({
        id: provider.id,
        enabled: true,
        endpoint: aiEndpoint,
        defaultModel: 'mock-model',
        models: ['mock-model'],
        apiKey: 'ai-e2e-secret'
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id, outputLanguage: 'zh-CN' })

      await window.origread.updateTranslationProvider({ type: 'DLX', enabled: true, endpoint: dlxEndpoint })
      await window.origread.updateTranslationSettings({
        targetLanguage: 'zh-CN',
        displayMode: 'TRANSLATED',
        defaultTarget: { type: 'traditional', provider: 'DLX' }
      })

      const added = await window.origread.addRssSource(feedUrl)
      const articles = await window.origread.listArticles(100)
      const article = articles.find((item) => item.feedId === added.feedId && item.title === 'OrigRead AI E2E Article 1')
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, {
      feedUrl: `${base}/feed.xml`,
      aiEndpoint: `${base}/v1`,
      dlxEndpoint: `${base}/dlx`
    })

    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()

    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Original full article body one')

    const conversationsBeforeAssistantOpen = await page.evaluate(async (targetArticleId) => (
      await window.origread.listLlmConversations(targetArticleId)
    ).length, articleId)
    expect(fixture.aiRequests()).toBe(0)

    // Reader 单键 A 是统一 AI 助手入口；打开和关闭都不能产生 Provider 请求或空 Conversation。
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    expect(fixture.aiRequests()).toBe(0)
    expect(await page.evaluate(async (targetArticleId) => (
      await window.origread.listLlmConversations(targetArticleId)
    ).length, articleId)).toBe(conversationsBeforeAssistantOpen)
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toHaveCount(0)

    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-surface', 'home')
    await expect(page.getByRole('button', { name: '生成速览摘要' })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成均衡摘要' })).toBeVisible()
    await expect(page.getByRole('button', { name: '生成深入摘要' })).toBeVisible()
    expect(fixture.aiRequests()).toBe(0)
    expect(await page.evaluate(async (targetArticleId) => (
      await window.origread.listLlmConversations(targetArticleId)
    ).length, articleId)).toBe(conversationsBeforeAssistantOpen)

    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-surface', 'summary')
    await expect(page.locator('.ai-summary-progress-status')).toContainText(/正在准备文章内容|正在等待 AI 服务返回/)
    await expect(page.locator('.article-body')).toContainText('Original full article body one')
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.ai-summary-markdown')).toContainText('核心结论')
    await expect(page.locator('.ai-summary-markdown')).toContainText('第一项关键事实')
    await expect(page.locator('.ai-summary-panel-body')).not.toContainText('zh-CN · STANDARD')
    await expect(page.locator('.ai-summary-panel-body h2').first()).toHaveText('主要内容')
    await expect(page.locator('.ai-summary-mode-badge')).toHaveText('均衡')
    await expect(page.locator('.ai-reasoning')).toContainText('mock reasoning')
    await expect(page.getByRole('button', { name: '朗读摘要' })).toBeVisible()
    await expect(page.getByRole('button', { name: '朗读正文' })).toBeVisible()
    expect(await page.evaluate(() => typeof window.speechSynthesis?.speak === 'function')).toBe(true)
    expect(fixture.aiRequests()).toBeGreaterThan(0)

    // Summary 是 AI 助手里的 artifact：返回 Home 后显示已有长度；点击同档只查看缓存，不额外请求。
    const requestsAfterSummary = fixture.aiRequests()
    await page.getByRole('button', { name: '返回 AI 助手' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.locator('.reader-ai-summary-existing')).toContainText('已有摘要：均衡')
    expect(fixture.aiRequests()).toBe(requestsAfterSummary)
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.ai-summary-markdown')).toContainText('核心结论')
    expect(fixture.aiRequests()).toBe(requestsAfterSummary)

    const conversationsBeforeContinueAsking = await page.evaluate(async (targetArticleId) => (
      await window.origread.listLlmConversations(targetArticleId)
    ).length, articleId)
    await page.getByRole('button', { name: '继续提问' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'chat')
    await expect(page.getByRole('textbox', { name: '问问这篇文章……' })).toBeVisible()
    expect(fixture.aiRequests()).toBe(requestsAfterSummary)
    expect(await page.evaluate(async (targetArticleId) => (
      await window.origread.listLlmConversations(targetArticleId)
    ).length, articleId)).toBe(conversationsBeforeContinueAsking)
    await page.getByRole('button', { name: '返回 AI 助手' }).click()
    await expect(page.locator('.reader-ai-summary-existing')).toContainText('已有摘要：均衡')
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')

    // DL-5：已生成的 AI Summary 属于 Reader 会话状态，主布局切换不得清掉摘要或替换当前文章。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible()
    await expect(page.locator('.ai-summary-markdown')).toContainText('核心结论')
    await expect(page.locator('.article-item.selected')).toHaveAttribute('data-article-id', articleId)

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible()
    await expect(page.locator('.ai-summary-markdown')).toContainText('核心结论')

    await page.keyboard.down('Shift')
    await page.keyboard.press('Comma')
    await page.keyboard.up('Shift')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).aiSummaryPlacement).toBe('left')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Period')
    await page.keyboard.up('Shift')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).aiSummaryPlacement).toBe('right')

    // 真实深色模式下摘要选项弹窗不能重新出现白色 select / 白色摘要长度卡片。
    await page.locator('.settings-button').click()
    await page.locator('.theme-select').selectOption('dark')
    await page.locator('.settings-close-button').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.locator('.reader-tool-options').first().click()
    await expect(page.locator('.reader-tool-dialog')).toBeVisible()
    await expectDarkSurface(page.locator('.reader-tool-dialog'))
    await expectDarkSurface(page.locator('.reader-tool-dialog .dialog-field select').first())
    await expectDarkSurface(page.locator('.summary-mode-option').first())
    await page.locator('.summary-mode-option').filter({hasText:'深入'}).click()
    await page.locator('.reader-tool-dialog .dialog-submit').click()
    await expect(page.locator('.reader-tool-dialog')).toBeHidden({ timeout: 1_000 })
    await expect(page.locator('.ai-summary-progress-status')).toBeVisible()
    await expect(page.locator('.ai-summary-progress-status')).toContainText(/正在准备文章内容|正在等待 AI 服务返回/)
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible()
    await expect(page.locator('.ai-summary-mode-badge')).toHaveText('深入')
    expect(fixture.aiRequests()).toBeGreaterThan(1)

    const requestsAfterDetailedSummary = fixture.aiRequests()
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()
    const reloadedArticle = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await reloadedArticle.click()
    await expect(page.locator('.article-body')).toContainText('Original full article body one')
    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    expect(fixture.aiRequests()).toBe(requestsAfterDetailedSummary)
    await page.getByRole('button', { name: '生成深入摘要' }).click()
    await expect(page.locator('.ai-summary-panel.docked')).toBeVisible({ timeout: 3_000 })
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.ai-summary-mode-badge')).toHaveText('深入')
    expect(fixture.aiRequests()).toBe(requestsAfterDetailedSummary)

    await page.locator('.regenerate-button').click()
    await expect(page.locator('.reader-tool-dialog')).toBeVisible()
    await page.locator('.reader-tool-dialog .dialog-submit').click()
    await expect(page.locator('.reader-tool-dialog')).toBeHidden({ timeout: 1_000 })
    await expect(page.locator('.ai-summary-progress-status')).toBeVisible()
    const stopSummary = page.getByRole('button', { name: '停止生成' }).first()
    await expect(stopSummary).toBeVisible()
    await stopSummary.click()
    await expect(page.locator('.ai-summary-progress-status')).toBeHidden({ timeout: 1_000 })
    await expect(page.locator('.ai-summary-mode-badge')).toHaveText('深入')
    await expect.poll(() => fixture.aiAbortedRequests()).toBeGreaterThan(0)

    await page.locator('.ai-summary-panel-actions select').selectOption('left')
    await expect(page.locator('.reader-composite')).toHaveClass(/summary-left/)
    await expect.poll(async()=>page.locator('.ai-summary-panel-header').evaluate((element)=>element.getBoundingClientRect().height)).toBeLessThan(60)
    await expect.poll(async()=>page.locator('.ai-summary-accent-icon-panel').evaluate((element)=>getComputedStyle(element).backgroundImage)).toContain('linear-gradient')
    await expect.poll(async()=>page.locator('.ai-summary-button .ai-summary-accent-icon-toolbar').evaluate((element)=>getComputedStyle(element).backgroundImage)).toContain('linear-gradient')

    await page.locator('.ai-summary-panel-actions select').selectOption('right')
    await expect(page.locator('.reader-composite')).toHaveClass(/summary-right/)
    const dockedSummary = page.locator('.ai-summary-panel.docked')
    await expect(dockedSummary).toBeVisible()
    await dockedSummary.getByRole('button',{name:'AI 面板尺寸'}).click()
    await expect(dockedSummary.locator('.ai-summary-size-popover')).toBeVisible()
    await dockedSummary.locator('.ai-summary-size-popover input').fill('420')
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).aiSummaryPanelSize)).toBe(420)

    await page.locator('.reader-tool-options').nth(1).click()
    await expect(page.locator('.translation-target-dialog')).toBeVisible()
    await expect(page.locator('.translation-target-group').filter({hasText:'传统翻译'})).toBeVisible()
    await expect(page.locator('.translation-target-group').filter({hasText:'AI 翻译'})).toBeVisible()
    await page.locator('.translation-target-dialog .dialog-submit').click()
    await expect(page.locator('.translated-article-body')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.translated-article-body')).toContainText('译文：')
    await expect(page.locator('.article-heading h1')).toContainText('译文：OrigRead AI E2E Article 1')
    await expect(page.locator('.article-original-title')).toContainText('OrigRead AI E2E Article 1')
    await expect(page.getByRole('button', { name: '朗读正文' })).toBeVisible()
    await expect(page.getByRole('button', { name: '朗读摘要' })).toBeVisible()
    expect(fixture.translationRequests()).toBeGreaterThan(0)

    // DL-5：Translation 与已缓存 Summary 同样必须跨布局保留，不能因为 Workspace 子树替换而回到正文模式。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect(page.locator('.translated-article-body')).toBeVisible()
    await expect(page.locator('.translated-article-body')).toContainText('译文：')
    await expect(page.locator('.article-heading h1')).toContainText('译文：OrigRead AI E2E Article 1')
    // DL-6：TTS 不是三栏专属能力；双栏 Reader 仍必须保留正文与摘要朗读入口。
    await expect(page.getByRole('button', { name: '朗读正文' })).toBeVisible()
    await expect(page.getByRole('button', { name: '朗读摘要' })).toBeVisible()
    expect(await page.evaluate(() => typeof window.speechSynthesis?.speak === 'function')).toBe(true)

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await expect(page.locator('.translated-article-body')).toBeVisible()
    await expect(page.locator('.article-heading h1')).toContainText('译文：OrigRead AI E2E Article 1')
    await expect(page.getByRole('button', { name: '朗读正文' })).toBeVisible()
    await expect(page.getByRole('button', { name: '朗读摘要' })).toBeVisible()

    const conciseArticleId = await page.evaluate(async () => {
      const article = (await window.origread.listArticles(100)).find((item) => item.title === 'OrigRead Concise Flash')
      if (!article) throw new Error('Concise fixture article was not saved')
      return article.id
    })
    const conciseArticle = page.locator(`.article-item[data-article-id="${conciseArticleId}"]`)
    await conciseArticle.click()
    await expect(page.locator('.article-body')).toContainText('英伟达盘中涨超 10%')
    const requestsBeforeConcise = fixture.aiRequests()
    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    expect(fixture.aiRequests()).toBe(requestsBeforeConcise)
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    await expect(page.locator('.ai-summary-panel')).toBeVisible()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'summary')
    await expect(page.locator('.ai-summary-not-needed')).toContainText('这篇文章无需再摘要')
    await expect(page.locator('.ai-summary-not-needed')).toContainText('本次没有发送 AI 请求')
    await expect(page.getByRole('button', { name: '朗读摘要' })).toHaveCount(0)
    expect(fixture.aiRequests()).toBe(requestsBeforeConcise)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

test('reader shows friendly setup guidance instead of raw IPC errors when AI or translation is not configured', async () => {
  const fixture = await startFixtureServer()
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const articleId = await page.evaluate(async (feedUrl) => {
      const translation = await window.origread.getTranslationSettings()
      if (translation.defaultTarget.type !== 'traditional' || translation.defaultTarget.provider !== 'MICROSOFT') {
        throw new Error(`Unexpected Desktop translation default: ${JSON.stringify(translation.defaultTarget)}`)
      }
      const mlKit = translation.providers.find((provider) => provider.type === 'ML_KIT')
      if (mlKit?.enabled) throw new Error('ML Kit must not be enabled on Desktop')

      const added = await window.origread.addRssSource(feedUrl)
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId && item.title === 'OrigRead AI E2E Article 1')
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, `http://127.0.0.1:${address.port}/feed.xml`)

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-body')).toContainText('Original full article body one')

    await page.locator('.ai-summary-button').click()
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await expect(page.locator('.reader-tool-notice')).toHaveCount(0)
    await page.getByRole('button', { name: '生成均衡摘要' }).click()
    const aiNotice = page.locator('.reader-tool-notice')
    await expect(aiNotice).toContainText('AI 摘要尚未配置完成')
    await expect(aiNotice).not.toContainText('Error invoking remote method')
    await expect(page.locator('.reader-ai-panel')).toHaveAttribute('data-reader-ai-view', 'home')
    await aiNotice.getByRole('button', { name: '打开 AI 设置' }).click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.locator('.settings-nav-button.active')).toContainText('AI')

    await page.locator('.settings-close-button').click()
    await expect(page.locator('.settings-layout')).toBeHidden()
    await page.locator('.translation-button').click()
    const translationNotice = page.locator('.reader-tool-notice')
    await expect(translationNotice).toContainText('还没有可用的桌面翻译服务')
    await expect(translationNotice).not.toContainText('Error invoking remote method')
    await translationNotice.getByRole('button', { name: '打开翻译设置' }).click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.locator('.settings-nav-button.active')).toContainText('翻译')
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function startFixtureServer(): Promise<{ server: Server; aiRequests: () => number; aiAbortedRequests: () => number; translationRequests: () => number }> {
  let aiRequests = 0
  let aiAbortedRequests = 0
  let translationRequests = 0
  const server = createServer(async (request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(rssXml(`http://${request.headers.host}`))
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      aiRequests += 1
      const requestNumber = aiRequests
      await readBody(request)
      if (request.headers.authorization !== 'Bearer ai-e2e-secret') {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { message: 'missing fixture authorization' } }))
        return
      }
      let completed = false
      response.once('close', () => {
        if (!completed) aiAbortedRequests += 1
      })
      await new Promise((resolve) => setTimeout(resolve, requestNumber === 3 ? 5_000 : 550))
      if (response.destroyed) return
      completed = true
      json(response, {
        choices: [{
          message: {
            content: '## 摘要\n核心结论来自本地 Mock。\n\n## 主要内容\n1. **第一项关键事实。** 这是用于 Electron Reader E2E 的结构化摘要。',
            reasoning_content: 'mock reasoning'
          }
        }]
      })
      return
    }
    if (request.url === '/v1/models') {
      json(response, { data: [{ id: 'mock-model' }] })
      return
    }
    if (request.url === '/dlx' && request.method === 'POST') {
      translationRequests += 1
      const body = JSON.parse(await readBody(request)) as { text?: string }
      json(response, { data: `译文：${body.text ?? ''}` })
      return
    }
    if (request.url?.startsWith('/article/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><article><h1>Article</h1><p>Fallback article page content.</p></article></body></html>')
      return
    }
    response.writeHead(404).end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server,
    aiRequests: () => aiRequests,
    aiAbortedRequests: () => aiAbortedRequests,
    translationRequests: () => translationRequests
  }
}

function rssXml(base: string): string {
  const items = Array.from({ length: 10 }, (_, index) => `
    <item>
      <guid>ai-e2e-${index + 1}</guid>
      <title>OrigRead AI E2E Article ${index + 1}</title>
      <link>${base}/article/${index + 1}</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 14, 10, index)).toUTCString()}</pubDate>
      <description>AI translation fixture summary ${index + 1}</description>
      <content:encoded><![CDATA[
        <p>Original full article body one ${index + 1}. This fixture describes a desktop reader feature rollout in enough detail to require real compression rather than a trivial restatement. The first section explains the motivation, the previous behavior, the user-visible problem, and the expected result after the change. It also records several concrete facts so the summary provider has meaningful information to select and prioritize.</p>
        <p>Original full article body two ${index + 1}. The second section adds implementation constraints, compatibility considerations, test observations, and a limitation that should remain visible in a balanced or detailed summary. It deliberately creates an independent content block so the translation processor must preserve structure while the summary path still has enough source material to exercise the remote AI provider.</p>
        <p>Original full article body three ${index + 1}. The final section states the rollout outcome, notes that existing reader behavior outside this feature remains unchanged, and provides additional context about regression coverage. These details make the fixture representative of a normal article instead of a short bulletin that the local NOT_NEEDED policy should skip.</p>
      ]]></content:encoded>
    </item>`).join('')
  const concise = `
    <item>
      <guid>ai-e2e-concise</guid>
      <title>OrigRead Concise Flash</title>
      <link>${base}/article/concise</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 14, 9, 0)).toUTCString()}</pubDate>
      <description>英伟达盘中涨超 10%，受财报超预期影响。</description>
      <content:encoded><![CDATA[<p>英伟达盘中涨超 10%，受财报超预期影响。</p>]]></content:encoded>
    </item>`
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel>
        <title>OrigRead AI E2E Feed</title>
        <link>${base}</link>
        <description>AI and translation fixture</description>
        ${concise}
        ${items}
      </channel>
    </rss>`
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return body
}

async function expectDarkSurface(locator: import('@playwright/test').Locator): Promise<void> {
  const rgb = await locator.evaluate((element) => getComputedStyle(element).backgroundColor)
  const channels = rgb.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? []
  expect(channels).toHaveLength(3)
  expect(Math.max(...channels)).toBeLessThan(100)
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

