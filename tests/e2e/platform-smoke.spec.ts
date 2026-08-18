import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('packaging platform smoke: Electron, preload, database and renderer start normally', async () => {
  const testApp = await launchIsolatedOrigRead()
  const page = await testApp.app.firstWindow()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.brand-name')).toContainText(/OrigRead|原读/)
    await expect(page.locator('.destination-tabs')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()

    const appInfo = await page.evaluate(() => window.origread.getAppInfo())
    expect(appInfo.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(['win32', 'darwin', 'linux']).toContain(appInfo.platform)

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(page.getByRole('button', { name: /通用|General/ })).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await testApp.close()
  }
})
