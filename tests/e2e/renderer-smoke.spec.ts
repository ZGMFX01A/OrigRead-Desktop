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

    await expect(page.locator('.app-shell')).not.toHaveClass(/workspace-collapsed/)
    await expect(page.locator('.workspace-pane')).toBeVisible()

    await expect(page.locator('.brand-name')).toBeVisible()
    await expect(page.locator('.destination-tabs')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()
    await expect(page.locator('.reader-empty-state')).toContainText('开始建立你的阅读列表')
    await expect(page.locator('.reader-empty-state')).not.toContainText('Electron 重构进行中')

    await page.keyboard.press('F12')
    await page.keyboard.press('Control+Shift+I')
    await page.waitForTimeout(100)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.webContents.isDevToolsOpened())
      )
    ).toBe(false)

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')

    const logoLoaded = await page.locator('.brand-logo').evaluate((element) => {
      const image = element as HTMLImageElement
      return image.complete && image.naturalWidth > 0
    })
    expect(logoLoaded).toBe(true)

    const expandedReaderBox = await page.locator('.reader-pane').boundingBox()
    expect(expandedReaderBox).not.toBeNull()

    await page.locator('.collapse-handle').click()
    await expect(page.locator('.app-shell')).toHaveClass(/workspace-collapsed/)
    await expect(page.locator('.collapse-handle')).toBeVisible()
    const collapsedHandleBox = await page.locator('.collapse-handle').boundingBox()
    expect(collapsedHandleBox).not.toBeNull()
    expect(collapsedHandleBox!.x).toBeGreaterThanOrEqual(0)
    expect(collapsedHandleBox!.width).toBeGreaterThanOrEqual(28)

    const collapsedReaderBox = await page.locator('.reader-pane').boundingBox()
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(collapsedReaderBox).not.toBeNull()
    expect(collapsedReaderBox!.width).toBeGreaterThan(viewportWidth * 0.9)

    // 折叠只影响当前会话，不应持久化为下次启动时隐藏文章列表。
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).workspaceCollapsed)).toBe(false)

    await page.locator('.collapse-handle').click()
    await expect(page.locator('.workspace-pane')).toBeVisible()

    await page.evaluate(async () => {
      await window.origread.updateSettings({ workspaceCollapsed: true })
      window.location.reload()
    })
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.app-shell')).not.toHaveClass(/workspace-collapsed/)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).workspaceCollapsed)).toBe(false)

    const bridgeReady = await page.evaluate(() => {
      return (
        typeof window.origread?.getAppInfo === 'function' &&
        typeof window.origread?.getUpdateState === 'function' &&
        typeof window.origread?.checkForUpdates === 'function' &&
        typeof window.origread?.downloadUpdateAsset === 'function' &&
        typeof window.origread?.launchDownloadedUpdate === 'function' &&
        typeof window.origread?.listGroups === 'function' &&
        typeof window.origread?.addGroup === 'function' &&
        typeof window.origread?.updateFeedSettings === 'function' &&
        typeof window.origread?.clearFeedArticles === 'function' &&
        typeof window.origread?.deleteFeed === 'function' &&
        typeof window.origread?.reloadFeedIcon === 'function' &&
        typeof window.origread?.listReaderFonts === 'function' &&
        typeof window.origread?.importReaderFont === 'function' &&
        typeof window.origread?.deleteReaderFont === 'function' &&
        typeof window.origread?.getRssHubSettings === 'function' &&
        typeof window.origread?.restoreDefaultRssHubSettings === 'function' &&
        typeof window.origread?.getSourceCatalog === 'function' &&
        typeof window.origread?.listJsonRules === 'function' &&
        typeof window.origread?.exportJsonRuleTemplate === 'function' &&
        typeof window.origread?.getRuleGuide === 'function' &&
        typeof window.origread?.generateAiRule === 'function' &&
        typeof window.origread?.saveAiGeneratedRule === 'function' &&
        typeof window.origread?.exportRuleTemplateFile === 'function' &&
        typeof window.origread?.inspectWebsiteStatic === 'function' &&
        typeof window.origread?.inspectWebsiteDynamic === 'function' &&
        typeof window.origread?.listWebsiteRules === 'function' &&
        typeof window.origread?.testWebsiteRule === 'function' &&
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
        typeof window.origread?.getAiApiKey === 'function' &&
        typeof window.origread?.summarizeArticle === 'function' &&
        typeof window.origread?.getTranslationSettings === 'function' &&
        typeof window.origread?.getTranslationApiKey === 'function' &&
        typeof window.origread?.translateArticle === 'function' &&
        typeof window.origread?.getArticleFilters === 'function' &&
        typeof window.origread?.evaluateWebsiteSourceRules === 'function' &&
        typeof window.origread?.importOpml === 'function' &&
        typeof window.origread?.exportOpml === 'function' &&
        typeof window.origread?.exportConfigurationBackup === 'function' &&
        typeof window.origread?.restoreConfigurationBackup === 'function' &&
        typeof window.origread?.openOriginalArticle === 'function' &&
        typeof window.origread?.closeOriginalArticle === 'function' &&
        typeof window.origread?.openExternalUrl === 'function'
      )
    })
    expect(bridgeReady).toBe(true)
    expect(pageErrors).toEqual([])

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await expect(page.locator('.subscription-menu')).toBeVisible()
    await expect(page.getByText('导入 OPML', { exact: true })).toBeVisible()
    await page.getByText('导出 OPML', { exact: true }).click()
    await expect(page.locator('.opml-export-dialog')).toBeVisible()
    await expect(page.locator('.opml-export-options input[type="radio"]').first()).toBeChecked()
    await page.locator('.opml-export-dialog .dialog-close').click()
    await expect(page.locator('.opml-export-dialog')).toBeHidden()

    await page.locator('.source-discovery-button').click()
    await expect(page.locator('.source-discovery-page')).toBeVisible()
    await expect(page.locator('.source-discovery-item')).toHaveCount(752)
    await page.locator('.source-discovery-search input').fill('Programming')
    await expect(page.locator('.source-discovery-item').first()).toBeVisible()
    const filteredSourceCount = await page.locator('.source-discovery-item').count()
    expect(filteredSourceCount).toBeGreaterThan(0)
    expect(filteredSourceCount).toBeLessThan(752)
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.source-discovery-page')).toBeHidden()

    await page.evaluate(async () => {
      const ai = await window.origread.getAiSettings()
      const provider = ai.providers[0]
      if (!provider) throw new Error('Missing AI provider')
      await window.origread.updateAiProvider({
        id: provider.id,
        endpoint: 'https://api.example.test/v1',
        defaultModel: 'e2e-model',
        models: ['e2e-model'],
        apiKey: 'ai-secret-123456789'
      })
      await window.origread.updateTranslationProvider({
        type: 'MICROSOFT',
        enabled: true,
        endpoint: 'https://api.cognitive.microsofttranslator.com',
        apiKey: 'ms-secret-123456'
      })
    })

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-page')).toBeVisible()
    const settingsNavLabels = await page.locator('.settings-nav-button span').allTextContents()
    expect(settingsNavLabels.at(-1)).toBe('软件更新')
    await page.getByRole('button', { name: '关于与支持' }).click()
    await expect(page.locator('.about-brand-logo')).toBeVisible()
    await expect(page.locator('.about-client-card')).toContainText('OrigRead Desktop')
    await expect(page.locator('.about-client-card .about-badge')).toHaveCount(2)
    await expect(page.locator('.settings-page')).toContainText('OrigRead Desktop')
    await expect(page.locator('.settings-page')).toContainText('OrigRead Android')
    await expect(page.getByRole('button', { name: '访问仓库' })).toHaveCount(2)
    await expect(page.locator('.about-shortcut')).toHaveCount(7)
    await expect(page.locator('.about-shortcut-grid')).toContainText('Ctrl / Cmd + F')
    await expect(page.getByRole('button', { name: '提交 Issue' })).toBeVisible()
    const aboutCardWidth = await page.locator('.about-client-card').evaluate((element) => element.getBoundingClientRect().width)
    expect(aboutCardWidth).toBeLessThanOrEqual(761)
    await page.locator('.about-client-card').getByRole('button', { name: '检查更新' }).click()
    await expect(page.locator('.update-check-button')).toBeVisible()
    await page.getByRole('button', { name: '关于与支持' }).click()
    await page.getByRole('button', { name: '通用' }).click()
    await expect(page.locator('.sync-interval-select')).toHaveValue('30')
    await page.locator('.reader-font-select').selectOption('serif')
    await page.locator('.reader-font-size-select').selectOption('19')
    await page.locator('.theme-select').selectOption('dark')
    await page.locator('.reader-color-picker input[type="color"]').fill('#dff4e3')
    await page.locator('.sync-interval-select').selectOption('0')
    await page.locator('.setting-switch').click()

    await expect.poll(async () => {
      return page.evaluate(async () => {
        const settings = await window.origread.getSettings()
        const syncState = await window.origread.getSyncRuntimeState()
        return {
          readerFontId: settings.readerFontId,
          fontSize: settings.readerFontSize,
          theme: settings.theme,
          readerBackground: settings.readerBackground,
          readerBackgroundCustom: settings.readerBackgroundCustom,
          interval: settings.syncIntervalMinutes,
          syncOnStart: settings.syncOnStart,
          nextRunAt: syncState.nextRunAt
        }
      })
    }).toEqual({ readerFontId: 'serif', fontSize: 19, theme: 'dark', readerBackground: 'custom', readerBackgroundCustom: '#dff4e3', interval: 0, syncOnStart: true, nextRunAt: null })

    await expect(page.locator('.app-shell')).toHaveCSS('--reader-font-size', '19px')
    await expect(page.locator('.app-shell')).toHaveCSS('--reader-font-family', /ui-serif/)
    await expect(page.locator('.app-shell')).toHaveCSS('--reader-background', '#dff4e3')
    await expect(page.locator('.app-shell')).toHaveCSS('--reader-text-color', '#35373e')

    await page.getByRole('button', { name: 'AI 阅读' }).click()
    await expect(page.locator('.provider-card')).toHaveCount(1)
    await expect(page.getByText('1～2 段摘要 + 4～6 个主要观点，每点补充关键依据、机制或影响', { exact: true })).toBeVisible()
    await expect(page.getByText('高密度单段摘要，中文建议约 120～220 字，不列要点', { exact: true })).toHaveCount(0)
    const aiProviderCard = page.locator('.provider-card').first()
    const aiKey = aiProviderCard.locator('.secret-key-input')
    await expect(aiKey).toHaveValue('ai-secret-123456789')
    await expect(aiKey).toHaveAttribute('type', 'password')
    await expect(aiProviderCard.locator('.secret-key-state')).toContainText('19 个字符')
    await aiProviderCard.locator('.secret-key-eye').click()
    await expect(aiKey).toHaveAttribute('type', 'text')
    await aiProviderCard.locator('.secret-key-eye').click()
    const aiEndpoint = aiProviderCard.locator('.provider-field').filter({ hasText: 'Endpoint' }).locator('input')
    await aiEndpoint.fill('https://api2.example.test/v1')
    await aiEndpoint.blur()
    await expect(aiKey).toHaveValue('ai-secret-123456789')
    await aiKey.fill('ai-secret-updated-123')
    await expect(aiProviderCard.locator('.secret-key-state')).toContainText('有未保存的修改')
    await aiProviderCard.locator('.secret-key-save').click()
    await expect.poll(async () => page.evaluate(async () => {
      const ai = await window.origread.getAiSettings()
      return window.origread.getAiApiKey(ai.providers[0]!.id)
    })).toBe('ai-secret-updated-123')

    await page.getByRole('button', { name: '翻译设置' }).click()
    await expect(page.locator('.provider-card')).toHaveCount(4)
    await expect(page.getByText('Google ML Kit', { exact: true })).toHaveCount(0)
    await expect(page.getByText('启用服务与默认服务', { exact: true })).toBeVisible()
    await expect(page.locator('input[name="translation-default-provider"]')).toHaveCount(4)
    const targetLanguage = page.locator('.translation-target-language-input')
    await expect(targetLanguage).toHaveValue('zh-CN')
    await targetLanguage.fill('')
    await expect(targetLanguage).toHaveValue('')
    await targetLanguage.fill('en-US')
    await targetLanguage.blur()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getTranslationSettings()).targetLanguage)).toBe('en-US')
    const microsoftCard = page.locator('.provider-card').filter({ hasText: 'Microsoft Translator' })
    const microsoftKey = microsoftCard.locator('.secret-key-input')
    await expect(microsoftKey).toHaveValue('ms-secret-123456')
    await expect(microsoftKey).toHaveAttribute('type', 'password')
    await expect(microsoftCard.locator('.secret-key-state')).toContainText('16 个字符')
    await microsoftCard.locator('.secret-key-eye').click()
    await expect(microsoftKey).toHaveAttribute('type', 'text')
    await microsoftCard.locator('.secret-key-eye').click()
    await expect.poll(async () => page.locator('.settings-subpage').evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))).toMatchObject({ scrollHeight: expect.any(Number), clientHeight: expect.any(Number) })
    const translationScrollable = await page.locator('.settings-subpage').evaluate((element) => element.scrollHeight > element.clientHeight)
    expect(translationScrollable).toBe(true)
    await page.locator('.settings-subpage').evaluate((element) => { element.scrollTop = 200 })
    await expect.poll(async () => page.locator('.settings-subpage').evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await page.getByRole('button', { name: '文章过滤' }).click()
    const ruleAdd = page.locator('.rule-add-row')
    await ruleAdd.locator('input').fill('Blocked E2E')
    await ruleAdd.locator('.mini-action').click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getArticleFilters()).rules.some((rule) => rule.keyword === 'Blocked E2E' && rule.feedId === null))).toBe(true)

    await page.getByRole('button', { name: 'JSON 规则' }).click()
    await expect(page.locator('.rule-add-row')).toHaveCount(0)
    await expect(page.locator('button.settings-action-row').filter({ hasText: 'AI 生成 JSON 规则' })).toBeEnabled()
    await expect(page.locator('button.settings-action-row').filter({ hasText: '导出 JSON 规则模板' })).toBeEnabled()
    await page.getByText('使用教程', { exact: true }).click()
    await expect(page.locator('.rule-modal')).toContainText('JSON / API 规则使用说明')
    await page.locator('.rule-modal header .icon-button').click()

    await page.getByRole('button', { name: '网站解析规则' }).click()
    await expect(page.getByText('ithome-home', { exact: true })).toHaveCount(0)
    await expect(page.getByText('来源级解析规则', { exact: true })).toHaveCount(0)
    await expect(page.locator('button.settings-action-row').filter({ hasText: 'AI 生成网站规则' })).toBeEnabled()
    await expect(page.locator('button.settings-action-row').filter({ hasText: '导出固定规则模板' })).toBeEnabled()
    await expect(page.locator('button.settings-action-row').filter({ hasText: '测试网站解析规则' })).toBeEnabled()
    await page.getByText('网站规则使用教程', { exact: true }).click()
    await expect(page.locator('.rule-modal')).toBeVisible()
    await page.locator('.rule-modal header .icon-button').click()

    await page.getByRole('button', { name: 'RSSHub' }).click()
    await expect(page.locator('.rsshub-instance-row')).toHaveCount(16)
    await expect(page.getByText('实例列表', { exact: true })).toBeVisible()
    await expect(page.getByText('测试并添加', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: '备份与恢复' }).click()
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
