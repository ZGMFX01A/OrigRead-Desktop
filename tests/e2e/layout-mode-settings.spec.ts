import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('general settings persist the desktop layout mode without changing the DL-1 three-pane renderer', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    expect(await page.evaluate(() => window.origread.getSettings())).toMatchObject({ layoutMode: 'three-pane' })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')

    await page.locator('.settings-button').click()
    const layoutControl = page.locator('.layout-mode-segmented')
    await expect(layoutControl).toBeVisible()
    const twoPane = layoutControl.locator('[data-layout-mode="two-pane"]')
    const threePane = layoutControl.locator('[data-layout-mode="three-pane"]')
    await expect(twoPane).toHaveAttribute('aria-pressed', 'false')
    await expect(threePane).toHaveAttribute('aria-pressed', 'true')

    await twoPane.click()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).layoutMode).toBe('two-pane')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect(twoPane).toHaveAttribute('aria-pressed', 'true')

    // DL-1 只建立设置与状态基础；真正的双栏 Renderer 从 DL-2 开始恢复。
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()

    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    expect(await page.evaluate(() => window.origread.getSettings())).toMatchObject({ layoutMode: 'two-pane' })

    await page.locator('.settings-button').click()
    const reloadedThreePane = page.locator('.layout-mode-option[data-layout-mode="three-pane"]')
    await reloadedThreePane.focus()
    await page.keyboard.press('Space')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).layoutMode).toBe('three-pane')
    await expect(reloadedThreePane).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await testApp.close()
  }
})
