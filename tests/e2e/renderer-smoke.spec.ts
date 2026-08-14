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
        typeof window.origread?.getAiSettings === 'function' &&
        typeof window.origread?.summarizeArticle === 'function' &&
        typeof window.origread?.getTranslationSettings === 'function' &&
        typeof window.origread?.translateArticle === 'function' &&
        typeof window.origread?.getArticleFilters === 'function' &&
        typeof window.origread?.exportConfigurationBackup === 'function' &&
        typeof window.origread?.restoreConfigurationBackup === 'function' &&
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

    await page.locator('.settings-nav-button').nth(1).click()
    await expect(page.locator('.provider-card')).toHaveCount(1)
    await expect(page.getByText('1～2 段摘要 + 4～6 个主要观点，每点补充关键依据、机制或影响', { exact: true })).toBeVisible()
    await expect(page.getByText('高密度单段摘要，中文建议约 120～220 字，不列要点', { exact: true })).toHaveCount(0)

    await page.locator('.settings-nav-button').nth(2).click()
    await expect(page.locator('.provider-card')).toHaveCount(4)
    await expect(page.getByText('Google ML Kit', { exact: true })).toHaveCount(0)
    await expect(page.getByText('启用服务与默认服务', { exact: true })).toBeVisible()
    await expect(page.locator('input[name="translation-default-provider"]')).toHaveCount(4)
    await expect.poll(async () => page.locator('.settings-subpage').evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))).toMatchObject({ scrollHeight: expect.any(Number), clientHeight: expect.any(Number) })
    const translationScrollable = await page.locator('.settings-subpage').evaluate((element) => element.scrollHeight > element.clientHeight)
    expect(translationScrollable).toBe(true)
    await page.locator('.settings-subpage').evaluate((element) => { element.scrollTop = 200 })
    await expect.poll(async () => page.locator('.settings-subpage').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.locator('.settings-nav-button').nth(3).click()
    const ruleAdd = page.locator('.rule-add-row')
    await ruleAdd.locator('input').fill('Blocked E2E')
    await ruleAdd.locator('.mini-action').click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getArticleFilters()).rules.some((rule) => rule.keyword === 'Blocked E2E' && rule.feedId === null))).toBe(true)

    await page.locator('.settings-nav-button').nth(4).click()
    await expect(page.locator('.rule-add-row')).toHaveCount(0)

    await page.locator('.settings-nav-button').nth(5).click()
    await expect(page.getByText('ithome-home', { exact: true })).toHaveCount(0)
    await expect(page.getByText('来源级解析规则', { exact: true })).toHaveCount(0)

    await page.locator('.settings-nav-button').nth(6).click()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await page.locator('.setting-switch').click()
    await expect(page.locator('input[type="password"]')).toBeVisible()
    expect(await page.locator('input[type="password"]').getAttribute('placeholder')).toBeNull()

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
