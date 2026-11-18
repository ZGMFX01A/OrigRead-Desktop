import { createServer, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, expect, test as base, type Locator, type Page } from '@playwright/test'

const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const root = join(process.cwd(), 'test-results')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'desktop-reading-appearance-'))
    try {
      await use(directory)
    } finally {
      await rm(directory, { recursive: true })
    }
  }
})

type ContentSize = { width: number; height: number }
type ResizeDesktop = (size: ContentSize) => Promise<void>

async function withDesktop(
  userDataDir: string,
  inspect: (page: Page, resize: ResizeDesktop) => Promise<void>
): Promise<void> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const app = await _electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1',
      ORIGREAD_DISABLE_PERIODIC_SYNC: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.app-shell')).toBeVisible()
    const nativeWindow = await app.browserWindow(page)
    await expect.poll(() => nativeWindow.evaluate((window) => window.isVisible())).toBe(true)
    if (await nativeWindow.evaluate((window) => window.isMaximized())) {
      await nativeWindow.evaluate((window) => window.unmaximize())
      await expect.poll(() => nativeWindow.evaluate((window) => window.isMaximized())).toBe(false)
    }
    const resize: ResizeDesktop = async (size) => {
      await nativeWindow.evaluate((window, size) => window.setContentSize(size.width, size.height), size)
      await expect.poll(() => nativeWindow.evaluate((window) => {
        const { width, height } = window.getContentBounds()
        return { width, height }
      })).toEqual(size)
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size)
    }
    await resize({ width: 1920, height: 1080 })
    await inspect(page, resize)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
}

/** 本地 HTTP fixture，不调用真实云端或外部服务。 */
async function readingFixture() {
  let baseUrl = ''
  let translationCalls = 0
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#7868d8"/><circle cx="112" cy="36" r="18" fill="#ffdf85"/><path d="M0 120L62 44L140 120Z" fill="#c8c3f3"/></svg>'

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl)
    if (url.pathname === '/feed') {
      const now = Date.now()
      const items = Array.from({ length: 6 }, (_, index) => {
        const title = `Reading article ${String(index).padStart(4, '0')} - Headline`
        const preview = `Preview text ${index} for snippet and summary testing.`
        const imageUrl = `${baseUrl}/thumb.svg?id=${index}`
        const body = `
          <p class="body-p1">First body paragraph ${index} with plain text for paragraph indent verification.</p>
          <p class="body-p2">Second body paragraph ${index} with continuous reading content.</p>
          <blockquote><p class="quote-p">Quoted citation paragraph that should not be indented.</p></blockquote>
          <pre><code class="code-block">console.log("code block line ${index}");</code></pre>
          <p class="media-p"><img src="${imageUrl}" alt="embedded"/></p>
          <figure><p class="figure-p">Figure text that should not be indented.</p><figcaption>Figcaption</figcaption></figure>
        `
        return `<item>
          <guid>article-${index}</guid>
          <title>${title}</title>
          <link>${baseUrl}/article/${index}</link>
          <pubDate>${new Date(now - index * 1000).toUTCString()}</pubDate>
          <description>${preview}</description>
          <content:encoded><![CDATA[${body}]]></content:encoded>
          <enclosure url="${imageUrl}" type="image/svg+xml" length="200"/>
        </item>`
      }).join('')

      response.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(
        `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>` +
        `<title>Reading fixture</title><link>${baseUrl}</link><description>Reading fixture test</description>` +
        `${items}</channel></rss>`
      )
      return
    }

    if (url.pathname === '/translate') {
      let body = ''
      for await (const chunk of request) body += chunk
      translationCalls++
      const input = JSON.parse(body) as { text: string }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: '译文：' + input.text }))
      return
    }

    if (url.pathname === '/thumb.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(image)
      return
    }

    response.writeHead(404).end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local fixture port')
  baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    translationCalls: () => translationCalls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function seed(page: Page, baseUrl: string) {
  const payload = await page.evaluate(async ({ baseUrl }) => {
    for (const feed of await window.origread.listFeeds()) await window.origread.deleteFeed(feed.id)
    await window.origread.updateSettings({ language: 'en' })
    await window.origread.updateTranslationProvider({ type: 'DLX', enabled: true, endpoint: baseUrl + '/translate' })
    await window.origread.updateTranslationSettings({
      defaultTarget: { type: 'traditional', provider: 'DLX' },
      targetLanguage: 'zh-CN',
      displayMode: 'BILINGUAL'
    })
    await window.origread.updateAiSettings({ enabled: true })
    const source = await window.origread.addRssSource(baseUrl + '/feed')
    const articles = await window.origread.listArticlesByFeed(source.feedId)
    return { ids: articles.map((article) => article.id), count: articles.length }
  }, { baseUrl })

  await page.reload()
  await expect(page.locator('.source-item[title="Reading fixture"]')).toBeVisible()
  await page.locator('.source-item[title="Reading fixture"]').click()
  await expect(page.locator('.article-item').first()).toContainText('Reading article 0000')
  return payload
}

const row = (page: Page, id: string): Locator => page.locator(`.article-item[data-article-id="${id}"]`)
const fontSize = (locator: Locator): Promise<number> =>
  locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))

test('摘要开关对原文/译文预览与缩略图独立且列表几何稳定', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const fixture = await readingFixture()
  try {
    await withDesktop(userDataDir, async (page) => {
      const data = await seed(page, fixture.baseUrl)
      const firstRow = row(page, data.ids[0]!)

      // 1. 默认状态：摘要开启，缩略图关闭
      await expect(firstRow.locator('p').first()).toContainText('Preview text 0')
      expect(await firstRow.locator('.article-thumbnail').count()).toBe(0)

      // 2. 开启缩略图，摘要依然保留（独立性验证第一步）
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="showArticleThumbnails"] input')).toBeChecked()
      await page.locator('.settings-back-button').click()

      await expect(firstRow.locator('.article-thumbnail img')).toBeVisible()
      await expect(firstRow.locator('p').first()).toContainText('Preview text 0')

      // 3. 关闭摘要开关：摘要隐藏，缩略图不受影响继续展示
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="showArticleSummaries"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="showArticleSummaries"] input')).not.toBeChecked()
      await page.locator('.settings-back-button').click()

      await expect(firstRow.locator('p')).toHaveCount(0)
      await expect(firstRow.locator('.article-thumbnail img')).toBeVisible()
      await expect(firstRow.locator('.article-title-copy strong')).toBeVisible()
      await expect(firstRow.locator('.article-meta')).toBeVisible()

      // 4. 验证列表几何稳定性：行无重叠、无空隙、连续覆盖视口
      const layout = await page.locator('.article-list').evaluate((element) => {
        const rows = [...element.querySelectorAll('.article-virtual-row')].map((item) => item.getBoundingClientRect())
        return {
          count: rows.length,
          contiguous: rows.every((rect, index) => index === 0 || Math.abs(rect.top - rows[index - 1]!.bottom) <= 1),
          covered: rows.some((rect) => rect.top <= element.getBoundingClientRect().top + 4 && rect.bottom > element.getBoundingClientRect().top + 4)
        }
      })
      expect(layout.count).toBeGreaterThan(0)
      expect(layout.contiguous).toBe(true)
      expect(layout.covered).toBe(true)

      // 5. 触发列表翻译：摘要关闭时，译文标题展示但译文摘要保持隐藏
      await page.locator('.list-translation-main').click()
      await expect(page.locator('.list-translation-status')).toHaveCount(0, { timeout: 30_000 })
      await expect(firstRow.locator('.article-title-translation')).toBeVisible()
      await expect(firstRow.locator('p')).toHaveCount(0)

      // 6. 重新开启摘要开关：原文预览与译文预览均在双语模式下恢复呈现
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="showArticleSummaries"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="showArticleSummaries"] input')).toBeChecked()
      await page.locator('.settings-back-button').click()

      await expect(firstRow.locator('.article-preview-translation')).toBeVisible()
      await expect(firstRow.locator('p').first()).toContainText('Preview text 0')

      // 7. 关闭缩略图：缩略图隐藏，摘要不受影响继续完整展示
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="showArticleThumbnails"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="showArticleThumbnails"] input')).not.toBeChecked()
      await page.locator('.settings-back-button').click()

      await expect(firstRow.locator('.article-thumbnail')).toHaveCount(0)
      await expect(firstRow.locator('.article-preview-translation')).toBeVisible()
      await expect(firstRow.locator('p').first()).toContainText('Preview text 0')
    })
  } finally {
    await fixture.close()
  }
})

test('普通段落2em缩进而代码引用媒体不缩进，标题随正文字号比例且关闭重启持久化', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const fixture = await readingFixture()
  try {
    // 首次会话：检查标题联动、正文缩进排他性与修改设置
    await withDesktop(userDataDir, async (page) => {
      const data = await seed(page, fixture.baseUrl)
      await row(page, data.ids[0]!).click()
      await expect(page.locator('.article-body')).toContainText('First body paragraph 0')

      const heading = page.locator('.article-heading h1')
      // 17px 基准字号下，标题尺寸为 clamp(22px, calc(17px * 1.65), 38px) = 28.05px
      expect(await fontSize(heading)).toBeCloseTo(28.05, 1)

      // 默认未开启缩进时，普通段落 textIndent 为 0
      const initialIndent = await page.locator('.article-body > p').first().evaluate((el) => getComputedStyle(el).textIndent)
      expect(initialIndent).toBe('0px')

      // 打开设置面板，将正文字号调整为 21px，并开启段落缩进开关
      await page.locator('.settings-button').click()
      await page.locator('[data-setting-anchor="readerFontSize"] select').selectOption('21')
      await page.locator('[data-setting-anchor="readerIndentParagraphs"] .setting-switch').click()
      await expect(page.locator('[data-setting-anchor="readerIndentParagraphs"] input')).toBeChecked()
      await page.locator('.settings-back-button').click()

      // 动态将正文字号调整为 21px，标题按 1.65 比例自动联动缩放至约 34.65px (21 * 1.65)
      await expect.poll(() => fontSize(heading)).toBeCloseTo(34.65, 1)

      await expect(page.locator('.article-body')).toHaveClass(/indent-paragraphs/)

      // 验证普通段落有 2em 缩进 (21px * 2 = 42px)
      const normalIndent = await page.locator('.article-body > p').filter({ hasText: 'First body paragraph' }).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(normalIndent).toBeCloseTo(42, 1)

      // 验证 blockquote 引用段落不缩进 (0px)
      const quoteIndent = await page.locator('.article-body blockquote p').evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(quoteIndent).toBe(0)

      // 验证 pre/code 代码块不缩进 (0px)
      const preIndent = await page.locator('.article-body pre').evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(preIndent).toBe(0)

      // 验证媒体段落 (包含 img) 不缩进 (0px)
      const mediaIndent = await page.locator('.article-body p:has(img)').evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(mediaIndent).toBe(0)

      // 验证 figure 段落不缩进 (0px)
      const figureIndent = await page.locator('.article-body figure p').evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(figureIndent).toBe(0)
    })

    // 重启进程：验证持久化配置正确还原
    await withDesktop(userDataDir, async (page) => {
      const settings = await page.evaluate(() => window.origread.getSettings())
      expect(settings).toMatchObject({
        readerFontSize: 21,
        readerIndentParagraphs: true
      })

      await expect(page.locator('.source-item[title="Reading fixture"]')).toBeVisible()
      await page.locator('.source-item[title="Reading fixture"]').click()
      await expect(page.locator('.article-item').first()).toBeVisible()
      await page.locator('.article-item').first().click()
      await expect(page.locator('.article-body')).toHaveClass(/indent-paragraphs/)

      // 标题字号保持比例联动
      expect(await fontSize(page.locator('.article-heading h1'))).toBeCloseTo(34.65, 1)

      // 普通段落缩进与排他性规则保持生效
      const persistedNormalIndent = await page.locator('.article-body > p').filter({ hasText: 'First body paragraph' }).evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(persistedNormalIndent).toBeCloseTo(42, 1)

      const persistedQuoteIndent = await page.locator('.article-body blockquote p').evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).textIndent)
      )
      expect(persistedQuoteIndent).toBe(0)
    })
  } finally {
    await fixture.close()
  }
})

test('Ollama与LMStudio预设按钮创建仅本地配置、保留已有服务且手填模型后翻译目标可选', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  const fixture = await readingFixture()
  try {
    await withDesktop(userDataDir, async (page) => {
      await seed(page, fixture.baseUrl)

      const initialAi = await page.evaluate(() => window.origread.getAiSettings())
      const initialProviderCount = initialAi.providers.length
      const initialProviderId = initialAi.providers[0]?.id

      // 打开设置面板并导航至 AI 页面
      await page.locator('.settings-button').click()
      await page.locator('.settings-nav-button').filter({ hasText: /AI/ }).click()
      await expect(page.locator('.ai-settings-page')).toBeVisible()

      // 确保全局 AI 开关开启
      const aiToggleInput = page.locator('[data-setting-anchor="aiEnabled"] input')
      if (!(await aiToggleInput.isChecked())) {
        await page.locator('[data-setting-anchor="aiEnabled"] .setting-switch').click()
        await expect(aiToggleInput).toBeChecked()
      }

      // 切换至服务商（Providers / Model services）选项卡
      await page.locator('.ai-settings-tabs button').filter({ hasText: /Model services|模型服务/ }).click()
      await expect(page.locator('.ai-provider-workspace')).toBeVisible()

      const ollamaBtn = page.locator('button.mini-action').filter({ hasText: 'Ollama' })
      const lmStudioBtn = page.locator('button.mini-action').filter({ hasText: 'LM Studio' })
      await expect(ollamaBtn).toBeVisible()
      await expect(lmStudioBtn).toBeVisible()

      // 1. 点击 Ollama 预设按钮创建本地配置
      await ollamaBtn.click()

      // 验证自动填充 Ollama 官方本地端点
      await expect(page.locator('.ai-provider-detail-name')).toHaveValue('Ollama')
      await expect(page.locator('.ai-provider-form-field').filter({ hasText: 'Endpoint' }).locator('input')).toHaveValue(
        'http://localhost:11434/v1'
      )

      // 验证未破坏或覆盖原有 Provider
      const providerItems = page.locator('.ai-provider-list-item')
      expect(await providerItems.count()).toBe(initialProviderCount + 1)
      if (initialProviderId) {
        const currentAi = await page.evaluate(() => window.origread.getAiSettings())
        expect(currentAi.providers.some((p) => p.id === initialProviderId)).toBe(true)
      }

      // 2. 手动在模型输入框填写实际模型名并失焦保存
      const modelInput = page.locator('.ai-provider-model-input')
      await modelInput.fill('llama3:latest')
      await modelInput.blur()

      await expect.poll(async () => {
        const s = await page.evaluate(() => window.origread.getAiSettings())
        const ollama = s.providers.find((item) => item.name === 'Ollama')
        return ollama?.defaultModel
      }).toBe('llama3:latest')

      // 3. 点击 LM Studio 预设按钮创建另一个本地配置
      await lmStudioBtn.click()
      await expect(page.locator('.ai-provider-detail-name')).toHaveValue('LM Studio')
      await expect(page.locator('.ai-provider-form-field').filter({ hasText: 'Endpoint' }).locator('input')).toHaveValue(
        'http://localhost:1234/v1'
      )
      // 验证原有 Provider 与已添加的 Ollama 均保留
      expect(await providerItems.count()).toBe(initialProviderCount + 2)

      // 4. 返回主界面，打开翻译目标选择对话框
      await page.locator('.settings-back-button').click()
      await page.locator('.list-translation-options').click()

      const targetDialog = page.locator('.translation-target-dialog')
      await expect(targetDialog).toBeVisible()

      // 验证手填模型的本地 AI 服务商在翻译目标中可选
      const localTargetOption = targetDialog.locator('.translation-target-option').filter({ hasText: 'Ollama · llama3:latest' })
      await expect(localTargetOption).toBeVisible()

      // 可点击选中该本地 AI 目标
      await localTargetOption.click()
      await expect(localTargetOption).toHaveClass(/selected/)

      // 关闭对话框，不触发真实网络调用
      await targetDialog.locator('.dialog-close').click()
      await expect(targetDialog).toHaveCount(0)
    })
  } finally {
    await fixture.close()
  }
})
