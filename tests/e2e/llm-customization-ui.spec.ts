import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('D4 settings persist Custom Instructions, Skills switch, and Quick Messages', async () => {
  test.setTimeout(30_000)
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()

    const customInstructions = page.locator('.llm-custom-instructions-editor textarea')
    await expect(customInstructions).toBeVisible()
    await customInstructions.fill('Keep answers concise and preserve exact numbers.')
    await page.locator('.llm-custom-instructions-editor').getByRole('button', { name: '保存' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getLlmCustomizationSettings())).customInstructions)
      .toBe('Keep answers concise and preserve exact numbers.')

    const skillsSection = page.locator('.settings-section').filter({ has: page.locator('.settings-section-title', { hasText: 'Skills' }) })
    const skillsToggle = skillsSection.locator('.setting-switch input').first()
    const skillsToggleControl = skillsSection.locator('.setting-switch').first()
    await expect(skillsToggle).toBeChecked()
    await skillsToggleControl.click()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getLlmCustomizationSettings())).skillsEnabled).toBe(false)
    await skillsToggleControl.click()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getLlmCustomizationSettings())).skillsEnabled).toBe(true)

    await skillsSection.getByRole('button', { name: '新建 Skill' }).click()
    await skillsSection.getByPlaceholder('reading-review').fill('review-helper')
    await skillsSection.getByPlaceholder('这个 Skill 适合处理什么任务？').fill('检查文章论证和证据。')
    await skillsSection.getByPlaceholder('可选：关键词或使用场景，帮助聊天自动匹配').fill('批判 审视 证据')
    await skillsSection.getByPlaceholder('说明这个 Skill 应该如何处理任务。').fill('先列出主要论点，再检查每个论点的证据是否充分。')
    await skillsSection.locator('.llm-skill-create-editor').getByRole('button', { name: '保存' }).click()
    const createdSkill = skillsSection.locator('.llm-skill-card').filter({ hasText: 'review-helper' })
    await expect(createdSkill).toHaveCount(1)
    await expect(createdSkill).toContainText('检查文章论证和证据。')
    const createdPreview = await page.evaluate(() => window.origread.getLlmSkillPreview('review-helper'))
    expect(createdPreview.instructions).toContain('先列出主要论点')

    await createdSkill.getByRole('button', { name: '查看 Skill' }).click()
    const skillPreviewModal = page.locator('.rule-modal').filter({ hasText: 'review-helper' })
    await expect(skillPreviewModal).toBeVisible()
    await expect(skillPreviewModal.locator('.llm-skill-preview pre')).toContainText('检查每个论点的证据是否充分')
    await skillPreviewModal.locator('header .icon-button').click()

    // Same stable ID is the explicit update/replace path rather than creating a duplicate Skill.
    await skillsSection.getByRole('button', { name: '新建 Skill' }).click()
    await skillsSection.getByPlaceholder('reading-review').fill('review-helper')
    await skillsSection.getByPlaceholder('这个 Skill 适合处理什么任务？').fill('更新后的论证检查。')
    await skillsSection.getByPlaceholder('说明这个 Skill 应该如何处理任务。').fill('优先找出关键结论，再逐条核对证据。')
    page.once('dialog', async (dialog) => { await dialog.accept() })
    await skillsSection.locator('.llm-skill-create-editor').getByRole('button', { name: '保存' }).click()
    await expect(createdSkill).toContainText('更新后的论证检查。')
    expect(await page.evaluate(async () => (await window.origread.getLlmSkills()).skills.filter((item) => item.id === 'review-helper').length)).toBe(1)
    expect((await page.evaluate(() => window.origread.getLlmSkillPreview('review-helper'))).instructions).toContain('逐条核对证据')

    const quickSection = page.locator('.settings-section').filter({ has: page.locator('.settings-section-title', { hasText: '快捷消息' }) })
    await quickSection.getByRole('button', { name: '添加' }).click()
    await quickSection.getByPlaceholder('名称').fill('需要选中文本')
    await quickSection.getByPlaceholder('输入要发送的内容…').fill('请解释 {{selection}}')
    await quickSection.locator('.quick-message-editor').getByRole('button', { name: '保存' }).click()
    await expect(quickSection.locator('.quick-message-row').filter({ hasText: '需要选中文本' })).toHaveCount(1)
    expect(await page.evaluate(async () => (await window.origread.getLlmQuickMessages('zh')).some((item) => item.title === '需要选中文本'))).toBe(true)

    // Unsaved Custom Instructions cannot be lost by changing Settings pages.
    await customInstructions.fill('Unsaved navigation draft')
    page.once('dialog', async (dialog) => { await dialog.dismiss() })
    await page.locator('.settings-nav-button').filter({ hasText: '通用' }).click()
    await expect(customInstructions).toHaveValue('Unsaved navigation draft')
    page.once('dialog', async (dialog) => { await dialog.accept() })
    await page.locator('.settings-nav-button').filter({ hasText: '通用' }).click()
    await expect(page.locator('.settings-intro h1')).toContainText('通用')
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()
    const reopenedInstructions = page.locator('.llm-custom-instructions-editor textarea')
    await expect(reopenedInstructions).toHaveValue('Keep answers concise and preserve exact numbers.')

    // Closing Settings uses the same guard and only discards after explicit confirmation.
    await reopenedInstructions.fill('Unsaved close draft')
    page.once('dialog', async (dialog) => { await dialog.dismiss() })
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(reopenedInstructions).toHaveValue('Unsaved close draft')
    page.once('dialog', async (dialog) => { await dialog.accept() })
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.settings-layout')).toBeHidden()
  } finally {
    await testApp.close()
  }
})

test('Quick Messages use the real Reader Chat send path and block unavailable template variables locally', async () => {
  test.setTimeout(30_000)
  const fixture = await startFixtureServer()
  const address = fixture.server.address()
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
        defaultModel: 'fixture-d4-model',
        models: ['fixture-d4-model'],
        apiKey: ''
      })
      await window.origread.updateAiSettings({ enabled: true, defaultProviderId: provider.id })
      await window.origread.updateLlmCustomizationSettings({ customInstructions: 'Keep answers concise and preserve exact numbers.' })
      await window.origread.createLlmSkill({
        id: 'explain-helper',
        description: 'Explain difficult parts of an article in plain language.',
        instructions: 'Explain the difficult point with concrete steps and preserve source facts.',
        triggers: '解释,难点'
      })
      await window.origread.createLlmQuickMessage('需要选中文本', '请解释 {{selection}}', 'zh')
      const article = (await window.origread.listArticles(100)).find((item) => item.feedId === added.feedId)
      if (!article) throw new Error('Fixture article was not saved')
      return article.id
    }, { feedUrl: `${baseUrl}/feed.xml`, baseUrl })

    await page.reload()
    const article = page.locator(`.article-item[data-article-id="${articleId}"]`)
    await expect(article).toBeVisible()
    await article.click()
    await page.keyboard.press('a')
    await expect(page.locator('.reader-ai-panel')).toBeVisible()

    await page.locator('.reader-ai-composer-add').click()
    const quickMenu = page.locator('.reader-ai-composer-actions-popover')
    await expect(quickMenu.getByRole('button', { name: /解释难点/ })).toBeVisible()
    await quickMenu.getByRole('button', { name: /解释难点/ }).click()
    await expect(page.locator('.reader-ai-user-bubble')).toContainText('请解释这篇文章最难理解的部分，用更直白的方式说明。')
    await expect(page.locator('.reader-ai-message.assistant')).toContainText('Fixture answer')
    expect(fixture.chatBodies).toHaveLength(1)
    const firstRequest = JSON.parse(fixture.chatBodies[0]!) as { messages?: Array<{ role?: string; content?: string }> }
    const systemPrompt = firstRequest.messages?.find((message) => message.role === 'system')?.content ?? ''
    expect(systemPrompt).toContain('<origread_user_skill id="explain-helper">')
    expect(systemPrompt).toContain('Explain the difficult point with concrete steps')
    expect(systemPrompt).toContain('<origread_user_custom_instructions>')
    expect(systemPrompt).toContain('Keep answers concise and preserve exact numbers.')

    const beforeUnavailable = await page.locator('.reader-ai-user-bubble').count()
    await page.locator('.reader-ai-composer-add').click()
    await page.locator('.reader-ai-composer-actions-popover').getByRole('button', { name: /需要选中文本/ }).click()
    await expect(page.locator('.reader-ai-chat-error')).toContainText('选中文本')
    await expect(page.locator('.reader-ai-user-bubble')).toHaveCount(beforeUnavailable)
    expect(fixture.chatBodies).toHaveLength(1)
  } finally {
    await testApp.close()
    await closeServer(fixture.server)
  }
})

async function startFixtureServer(): Promise<{ server: Server; chatBodies: string[] }> {
  const chatBodies: string[] = []
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>D4 Customization</title><link>http://127.0.0.1/</link><description>E2E</description>
<item><title>D4 Article</title><link>http://127.0.0.1/article</link><guid>d4-customization-article</guid><description><![CDATA[<p>Revenue rose by exactly 20 percent.</p>]]></description></item>
</channel></rss>`)
      return
    }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        chatBodies.push(body)
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Fixture answer' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
      })
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, chatBodies }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
