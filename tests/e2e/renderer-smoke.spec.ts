import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('desktop renderer mounts with preload bridge and primary UI', async () => {
  const testApp = await launchIsolatedOrigRead()
  const electronApp = testApp.app

  try {
    const page = await electronApp.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await expect(page.locator('.app-shell')).toBeVisible()

    if (await page.locator('.app-shell').evaluate((element) => element.classList.contains('workspace-collapsed'))) {
      await page.locator('.collapse-handle').click()
      await expect(page.locator('.workspace-pane')).toBeVisible()
    }

    await expect(page.locator('.brand-name')).toBeVisible()
    await expect(page.locator('.destination-tabs')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()

    const logoLoaded = await page.locator('.brand-logo').evaluate((element) => {
      const image = element as HTMLImageElement
      return image.complete && image.naturalWidth > 0
    })
    expect(logoLoaded).toBe(true)

    const expandedReaderBox = await page.locator('.reader-pane').boundingBox()
    expect(expandedReaderBox).not.toBeNull()

    await page.locator('.collapse-handle').click()
    await expect(page.locator('.app-shell')).toHaveClass(/workspace-collapsed/)

    const collapsedReaderBox = await page.locator('.reader-pane').boundingBox()
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(collapsedReaderBox).not.toBeNull()
    expect(collapsedReaderBox!.width).toBeGreaterThan(viewportWidth * 0.9)

    await page.locator('.collapse-handle').click()
    await expect(page.locator('.workspace-pane')).toBeVisible()

    const bridgeReady = await page.evaluate(() => {
      return (
        typeof window.origread?.getAppInfo === 'function' &&
        typeof window.origread?.getRssHubSettings === 'function' &&
        typeof window.origread?.listJsonRules === 'function' &&
        typeof window.origread?.exportJsonRuleTemplate === 'function' &&
        typeof window.origread?.inspectWebsiteStatic === 'function' &&
        typeof window.origread?.inspectWebsiteDynamic === 'function' &&
        typeof window.origread?.listWebsiteRules === 'function' &&
        typeof window.origread?.discoverSource === 'function' &&
        typeof window.origread?.subscribeSource === 'function' &&
        typeof window.origread?.refreshJsonSource === 'function' &&
        typeof window.origread?.refreshWebsiteSource === 'function' &&
        typeof window.origread?.refreshSource === 'function' &&
        typeof window.origread?.refreshAllSources === 'function' &&
        typeof window.origread?.getSyncRuntimeState === 'function' &&
        typeof window.origread?.getReaderContent === 'function' &&
        typeof window.origread?.fetchFullContent === 'function' &&
        typeof window.origread?.openOriginalArticle === 'function' &&
        typeof window.origread?.closeOriginalArticle === 'function' &&
        typeof window.origread?.openExternalUrl === 'function'
      )
    })
    expect(bridgeReady).toBe(true)
    expect(pageErrors).toEqual([])

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-page')).toBeVisible()
    await expect(page.locator('.sync-interval-select')).toHaveValue('30')
    await page.locator('.reader-font-size-select').selectOption('19')
    await page.locator('.sync-interval-select').selectOption('0')
    await page.locator('.setting-switch').click()

    await expect.poll(async () => {
      return page.evaluate(async () => {
        const settings = await window.origread.getSettings()
        const syncState = await window.origread.getSyncRuntimeState()
        return {
          fontSize: settings.readerFontSize,
          interval: settings.syncIntervalMinutes,
          syncOnStart: settings.syncOnStart,
          nextRunAt: syncState.nextRunAt
        }
      })
    }).toEqual({ fontSize: 19, interval: 0, syncOnStart: true, nextRunAt: null })

    await expect(page.locator('.app-shell')).toHaveCSS('--reader-font-size', '19px')
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.settings-page')).toBeHidden()

    await page.screenshot({
      path: 'test-results/renderer-smoke.png',
      fullPage: true
    })
  } finally {
    await testApp.close()
  }
})
