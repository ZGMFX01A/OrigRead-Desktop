import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('D8.6.5 M2 uses restrained motion tokens for anchored surfaces and icon-only actions', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.evaluate(() => window.origread.updateSettings({ language: 'zh', layoutMode: 'two-pane', theme: 'light' }))
    await page.reload()

    const trigger = page.locator('.source-switcher-trigger')
    await expect(trigger).toBeVisible()
    await trigger.click()
    const popover = page.locator('.source-switcher-popover')
    await expect(popover).toBeVisible()

    const surfaceMotion = await popover.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return {
        placement: element.getAttribute('data-placement'),
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        transformOrigin: style.transformOrigin
      }
    })
    expect(['top', 'bottom']).toContain(surfaceMotion.placement)
    expect(surfaceMotion.animationName).toMatch(/motion-surface-enter-(?:up|down)/)
    expect(surfaceMotion.animationDuration).toBe('0.16s')
    expect(surfaceMotion.transformOrigin).not.toBe('50% 50%')

    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)

    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI 阅读' }).click()
    const settingsPageMotion = page.locator('.settings-page-motion')
    await expect(settingsPageMotion).toHaveAttribute('data-settings-page', 'ai')
    const settingsMotion = await settingsPageMotion.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return { animationName: style.animationName, animationDuration: style.animationDuration }
    })
    expect(settingsMotion.animationName).toBe('motion-content-enter')
    expect(settingsMotion.animationDuration).toBe('0.16s')

    await page.getByRole('tab', { name: '模型服务' }).click()
    const iconAction = page.locator('.ai-provider-workspace-head .mini-action.icon-only')
    await expect(iconAction).toBeVisible()
    const buttonMotion = await iconAction.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return {
        properties: style.transitionProperty,
        durations: style.transitionDuration
      }
    })
    expect(buttonMotion.properties).toContain('transform')
    expect(buttonMotion.durations).toContain('0.08s')
  } finally {
    await testApp.close()
  }
})

test('D8.6.5 M3 keeps structural motion limited to settings content and adaptive source overlay', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-page-motion')).toBeVisible()
    const settingsMotion = await page.locator('.settings-page-motion').evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      return { name: style.animationName, duration: style.animationDuration }
    })
    expect(settingsMotion.name).toBe('motion-content-enter')
    expect(settingsMotion.duration).toBe('0.16s')

    await page.locator('.settings-close-button').click()
    await page.evaluate(() => window.origread.updateSettings({
      layoutMode: 'three-pane',
      sourcePaneCollapsed: false,
      articlePaneCollapsed: false,
      sourcePaneWidth: 300,
      articlePaneWidth: 480
    }))
    await page.reload()

    await testApp.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setContentSize(1100, 760)
    })
    await expect(page.locator('.app-shell')).toHaveClass(/adaptive-source-hidden/)
    await page.locator('.collapsed-pane-restore').click()
    const overlay = page.locator('.adaptive-source-overlay')
    await expect(overlay).toBeVisible()
    const overlayMotion = await overlay.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement)
      const backdropStyle = getComputedStyle(document.querySelector('.adaptive-source-overlay-backdrop') as HTMLElement)
      return {
        name: style.animationName,
        duration: style.animationDuration,
        backdropName: backdropStyle.animationName,
        backdropDuration: backdropStyle.animationDuration
      }
    })
    expect(overlayMotion.name).toBe('motion-overlay-enter-left')
    expect(overlayMotion.duration).toBe('0.2s')
    expect(overlayMotion.backdropName).toBe('motion-backdrop-enter')
    expect(overlayMotion.backdropDuration).toBe('0.16s')
  } finally {
    await testApp.close()
  }
})
