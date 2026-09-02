import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('AI reading settings keep common defaults simple and move advanced controls into focused workspaces', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()

    const tabs = page.locator('.ai-settings-tabs [role="tab"]')
    await expect(tabs).toHaveCount(4)
    await expect(page.getByRole('tab', { name: '阅读' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('阅读默认值', { exact: true })).toBeVisible()
    await expect(page.locator('.ai-default-model-picker select')).toHaveCount(2)
    await expect(page.locator('.ai-provider-workspace')).toHaveCount(0)
    await expect(page.locator('.llm-custom-instructions-editor')).toHaveCount(0)
    await expect(page.locator('.web-search-provider-list')).toHaveCount(0)

    if (process.env.ORIGREAD_CAPTURE_AI_SETTINGS === '1') {
      await page.screenshot({ path: 'test-results/ai-settings-reading-v2.png' })
    }

    await page.getByRole('tab', { name: '模型服务' }).click()
    await expect(page.locator('.ai-provider-workspace')).toBeVisible()
    await expect(page.locator('.ai-provider-list-item')).toHaveCount(1)
    await expect(page.locator('.ai-provider-detail')).toBeVisible()
    await expect(page.locator('.ai-provider-form-field')).toHaveCount(3)
    await expect(page.locator('.provider-card')).toHaveCount(0)

    if (process.env.ORIGREAD_CAPTURE_AI_SETTINGS === '1') {
      await page.screenshot({ path: 'test-results/ai-settings-providers-v2.png' })
    }

    await page.getByRole('tab', { name: '网络搜索' }).click()
    await expect(page.locator('.settings-section-title').filter({ hasText: '网络搜索' })).toBeVisible()
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()
    await expect(page.locator('.llm-custom-instructions-editor')).toBeVisible()
    await expect(page.locator('.settings-section-title').filter({ hasText: '快捷消息' })).toBeVisible()

    await page.evaluate(async () => {
      await window.origread.updateSettings({ language: 'en' })
      window.location.reload()
    })
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await expect(page.getByText('Reading defaults', { exact: true })).toBeVisible()
    await expect(page.getByText('Default for new AI tasks', { exact: true })).toBeVisible()
    const defaultModelRow = page.locator('.setting-row').filter({ hasText: 'Default model' })
    await expect(defaultModelRow).toBeVisible()
    await expect(defaultModelRow).toContainText('New summaries and article chats start here. You can switch models inside a conversation later.')
    await expect(page.getByRole('tab', { name: 'Prompts & behavior' })).toBeVisible()
  } finally {
    await testApp.close()
  }
})

test('AI settings respond to the actual narrow three-pane reader width in Chinese and English', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    const prepareLanguage = async (language: 'zh' | 'en'): Promise<void> => {
      await page.evaluate(async (nextLanguage) => {
        await window.origread.updateSettings({
          language: nextLanguage,
          layoutMode: 'three-pane',
          sourcePaneCollapsed: false,
          articlePaneCollapsed: false,
          sourcePaneWidth: 320,
          articlePaneWidth: 480
        })
        window.location.reload()
      }, language)
      await expect(page.locator('.app-shell')).toBeVisible()
      await page.locator('.settings-button').click()
      const aiNav = page.locator('.settings-nav-button').filter({ has: page.locator('svg') }).nth(2)
      await aiNav.click()
      await expect(page.locator('.ai-settings-page')).toBeVisible()

      const shellGeometry = await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>('.settings-layout')
        const nav = document.querySelector<HTMLElement>('.settings-nav')
        const content = document.querySelector<HTMLElement>('.settings-subpage')
        if (!shell || !nav || !content) throw new Error('Settings geometry is missing')
        return {
          shellWidth: shell.getBoundingClientRect().width,
          navWidth: nav.getBoundingClientRect().width,
          contentWidth: content.getBoundingClientRect().width,
          horizontalOverflow: content.scrollWidth - content.clientWidth
        }
      })
      expect(shellGeometry.shellWidth).toBeLessThan(920)
      expect(shellGeometry.navWidth).toBeLessThanOrEqual(54)
      expect(shellGeometry.contentWidth).toBeGreaterThan(600)
      expect(shellGeometry.horizontalOverflow).toBeLessThanOrEqual(1)

      const tabColumns = await page.locator('.ai-settings-tabs').evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
      )
      expect(tabColumns).toBe(2)

      const readingRows = page.locator('.ai-settings-page .setting-row')
      await expect(readingRows.first()).toBeVisible()
      expect(await readingRows.first().evaluate((element) => getComputedStyle(element).flexDirection)).toBe('column')
      const readingCopyWidth = await readingRows.nth(1).locator('.setting-copy').evaluate((element) => element.getBoundingClientRect().width)
      expect(readingCopyWidth).toBeGreaterThan(300)
      expect(await page.locator('.ai-default-model-picker').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    }

    await prepareLanguage('zh')
    await page.getByRole('tab', { name: '模型服务' }).click()
    await expect(page.locator('.ai-provider-workspace')).toBeVisible()
    expect(await page.locator('.ai-provider-list').evaluate((element) => getComputedStyle(element).display)).toBe('flex')
    const zhEndpointField = page.locator('.ai-provider-form-field').first()
    expect(await zhEndpointField.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length)).toBe(1)
    const zhEndpointLabel = zhEndpointField.locator('strong').first()
    const zhLabelBox = await zhEndpointLabel.boundingBox()
    expect(zhLabelBox?.width ?? 0).toBeGreaterThan(80)
    expect(zhLabelBox?.height ?? 999).toBeLessThan(32)

    await page.getByRole('tab', { name: '网络搜索' }).click()
    await expect(page.locator('.settings-section-title').filter({ hasText: '网络搜索' })).toBeVisible()
    expect(await page.locator('.settings-subpage').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

    await page.getByRole('tab', { name: '回答与快捷操作' }).click()
    await expect(page.locator('.llm-custom-instructions-editor')).toBeVisible()
    expect(await page.locator('.llm-custom-instructions-row').evaluate((element) => getComputedStyle(element).flexDirection)).toBe('column')
    expect(await page.locator('.llm-custom-instructions-editor').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(300)

    await prepareLanguage('en')
    await expect(page.getByRole('tab', { name: 'Reading' })).toBeVisible()
    await page.getByRole('tab', { name: 'Model services' }).click()
    const enEndpointField = page.locator('.ai-provider-form-field').first()
    await expect(enEndpointField).toBeVisible()
    expect(await enEndpointField.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length)).toBe(1)
    const enEndpointLabel = enEndpointField.locator('strong').first()
    const enLabelBox = await enEndpointLabel.boundingBox()
    expect(enLabelBox?.width ?? 0).toBeGreaterThan(80)
    expect(enLabelBox?.height ?? 999).toBeLessThan(32)
    expect(await page.locator('.settings-subpage').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

    await page.getByRole('tab', { name: 'Web search' }).click()
    await expect(page.locator('.settings-section-title').filter({ hasText: 'Web search' })).toBeVisible()
    expect(await page.locator('.settings-subpage').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)

    await page.getByRole('tab', { name: 'Prompts & behavior' }).click()
    await expect(page.locator('.llm-custom-instructions-editor')).toBeVisible()
    expect(await page.locator('.llm-custom-instructions-row').evaluate((element) => getComputedStyle(element).flexDirection)).toBe('column')

    // Keep the same maximum persisted three-pane widths and progressively narrow only the
    // application viewport. The Settings surface must continue adapting to its own container.
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(async () => page.locator('.settings-layout').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(920)
      expect(await page.locator('.settings-nav').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(54)
      expect(await page.locator('.settings-subpage').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      expect(await page.locator('.llm-custom-instructions-editor').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    }
  } finally {
    await testApp.close()
  }
})
