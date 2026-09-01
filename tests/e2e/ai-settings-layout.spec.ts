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
