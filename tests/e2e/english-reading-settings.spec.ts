import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('English Reading settings stay readable and show clear summary placement keys', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 920, height: 980 })
    await page.evaluate(async () => { await window.origread.updateSettings({ language: 'en' }) })
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()

    const subscriptionTrigger = page.locator('.subscription-menu-anchor .subscription-trigger')
    await expect(subscriptionTrigger).toHaveText(/Add/)
    const subscriptionTriggerBox = await subscriptionTrigger.boundingBox()
    expect(subscriptionTriggerBox).not.toBeNull()
    expect(subscriptionTriggerBox!.height).toBeLessThanOrEqual(32)
    expect(subscriptionTriggerBox!.width).toBeLessThan(90)

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    const backgroundRow = page.locator('.reader-background-setting-row')
    await expect(backgroundRow).toBeVisible()
    await expect(backgroundRow.locator('.setting-copy')).toContainText('Reading background')
    await expect(backgroundRow.locator('.setting-copy')).toContainText('Choose the background used while reading')
    await expect(backgroundRow.locator('.reader-background-option')).toHaveCount(5)

    const layout = await backgroundRow.evaluate((row) => {
      const copy = row.querySelector('.setting-copy')!.getBoundingClientRect()
      const control = row.querySelector('.setting-control')!.getBoundingClientRect()
      const options = [...row.querySelectorAll('.reader-background-option')].map((element) => element.getBoundingClientRect())
      return { copyWidth: copy.width, copyBottom: copy.bottom, controlTop: control.top, optionWidths: options.map((option) => option.width) }
    })
    expect(layout.copyWidth).toBeGreaterThan(300)
    expect(layout.controlTop).toBeGreaterThanOrEqual(layout.copyBottom)
    expect(Math.min(...layout.optionWidths)).toBeGreaterThan(70)

    const rssHubNav = page.locator('.settings-nav-button').filter({ hasText: 'RSSHub' })
    await expect(rssHubNav).toBeVisible()
    await rssHubNav.click()
    await expect(page.locator('.rsshub-instance-row')).toHaveCount(16)
    const rssHubMetadata = await page.locator('.rsshub-instance-head span').allTextContents()
    expect(rssHubMetadata.length).toBeGreaterThan(0)
    expect(rssHubMetadata[0]).toContain('US United States')
    expect(rssHubMetadata.join(' ')).not.toMatch(/[\u3400-\u9fff]/)

    const aboutNav = page.locator('.settings-nav-button').filter({ hasText: 'About & support' })
    await expect(aboutNav).toBeVisible()
    await aboutNav.click()
    await expect(page.locator('.about-shortcut-grid')).toBeVisible()
    const shortcutKeys = await page.locator('.about-shortcut kbd').allTextContents()
    expect(shortcutKeys).toContain('<')
    expect(shortcutKeys).toContain('>')
    expect(shortcutKeys).not.toContain(',')
    expect(shortcutKeys).not.toContain('.')
  } finally {
    await testApp.close()
  }
})
