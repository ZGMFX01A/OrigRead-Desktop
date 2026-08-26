import { expect, test, type Locator } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('dark theme keeps account, filter, rule and backup settings surfaces dark', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.evaluate(async () => {
      await window.origread.updateSettings({ theme: 'dark', language: 'zh' })
      window.location.reload()
    })
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.locator('.settings-button').click()

    const nav = page.locator('.settings-nav-button')

    // 账户：当前同步状态三格不能继承浅色 #fafafd。
    await nav.nth(1).click()
    const syncCells = page.locator('.sync-runtime-card > div')
    await expect(syncCells).toHaveCount(3)
    await expectDarkSurface(syncCells.first())

    // 文章过滤：输入、类型选择、导入导出条、卡片都必须留在深色 surface 中。
    await nav.nth(4).click()
    await expectDarkSurface(page.locator('.filter-rule-add-row input'))
    await expectDarkSurface(page.locator('.filter-rule-add-row select'))
    await expectDarkSurface(page.locator('.rule-file-actions'))
    await expectDarkSurface(page.locator('.settings-card').last())

    // JSON / Website 规则共用 SettingsActionRow / RuleFileActions，分别进入真实页面验证。
    await nav.nth(5).click()
    await expectDarkSurface(page.locator('.settings-action-row').first())
    await expectDarkSurface(page.locator('.rule-file-actions'))

    await nav.nth(6).click()
    await expectDarkSurface(page.locator('.settings-action-row').first())
    await expectDarkSurface(page.locator('.rule-file-actions'))

    // 备份与恢复使用 banner + action row，两者都不能回退为白底。
    await nav.nth(8).click()
    await expectDarkSurface(page.locator('.settings-banner'))
    await expectDarkSurface(page.locator('.settings-action-row').first())
  } finally {
    await testApp.close()
  }
})

async function expectDarkSurface(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const rgb = await locator.evaluate((element) => getComputedStyle(element).backgroundColor)
  const channels = rgb.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? []
  expect(channels).toHaveLength(3)
  expect(Math.max(...channels)).toBeLessThan(100)
}
