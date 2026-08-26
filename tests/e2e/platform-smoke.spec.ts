import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('packaging platform smoke: Electron, preload, database and renderer start normally', async () => {
  const packagedExecutable = process.env.ORIGREAD_E2E_EXECUTABLE_PATH?.trim() || null
  const testApp = await launchIsolatedOrigRead()
  const page = await testApp.app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.brand-name')).toContainText(/OrigRead|原读/)
    await expect(page.locator('.source-destination-nav')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()

    const appInfo = await page.evaluate(() => window.origread.getAppInfo())
    expect(appInfo.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(['win32', 'darwin', 'linux']).toContain(appInfo.platform)
    if (packagedExecutable) {
      // UI-3P.10：传入真实打包 executable 时，本 smoke 必须验证的是 packaged app，而不是 node_modules/electron。
      expect(process.platform).toBe('win32')
      expect(appInfo.platform).toBe('win32')
      await expect(page.locator('.brand-name')).toBeVisible()
    }

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    // 这是平台打包 smoke，不应该依赖 runner 的系统语言或 i18n 可访问名称。
    // 只验证设置导航已经真正渲染，并且默认 General 页处于激活状态。
    await expect(page.locator('.settings-nav')).toBeVisible()
    await expect(page.locator('.settings-nav-button').first()).toBeVisible()
    await expect(page.locator('.settings-nav-button.active')).toBeVisible()
    await expect(page.locator('.settings-page.settings-subpage .settings-intro')).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await testApp.close()
  }
})
