import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { _electron, expect, test as base, type Page } from '@playwright/test'
import type { OrigReadDesktopApi } from '../../src/shared/contracts'

// Each case uses its own real Electron profile and database; no user profile is touched.
const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const root = join(process.cwd(), 'test-results')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'settings-search-'))
    try { await use(directory) } finally { await rm(directory, { recursive: true }) }
  }
})

async function withSettings(userDataDir: string, inspect: (page: Page) => Promise<void>): Promise<void> {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const app = await _electron.launch({
    args: [process.cwd()], cwd: process.cwd(),
    env: { ...inheritedEnv, ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1', ORIGREAD_DISABLE_PERIODIC_SYNC: '1' }
  })
  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.evaluate(async () => {
      const api: OrigReadDesktopApi = window.origread
      await api.updateSettings({ language: 'en' })
    })
    await page.reload()
    await page.setViewportSize({ width: 1180, height: 740 })
    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await inspect(page)
    expect(pageErrors).toEqual([])
  } finally { await app.close() }
}

test('设置搜索定位实际控件、保留返回结果，并随界面语言刷新', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    await search.fill('reading')
    await expect.poll(() => page.locator('.settings-search-result').count()).toBeGreaterThan(2)
    await page.screenshot({ path: 'test-results/desktop-settings-search-results.png' })
    await search.fill('font size')
    const result = page.locator('[data-settings-search-id="readerFontSize"]')
    await expect(result).toContainText('Article font size')
    await expect(result).toContainText('Settings › General › Reading')
    await result.click()
    await expect(page.locator('[data-setting-anchor="readerFontSize"]')).toBeInViewport()
    await page.locator('.reader-font-size-select').selectOption('19')
    await expect.poll(() => page.evaluate(async () => (await window.origread.getSettings()).readerFontSize)).toBe(19)
    await expect(search).toHaveValue('font size')
    await page.locator('.settings-search-back').click()
    await expect(result).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('.settings-search-results')).toHaveCount(0)
    await expect(page.locator('.reader-font-size-select')).toHaveValue('19')

    await search.fill('language')
    await page.locator('[data-settings-search-id="language"]').click()
    await page.locator('.language-select').selectOption('zh')
    await expect(search).toHaveAttribute('placeholder', '搜索设置项')
    await page.locator('.settings-search-back').click()
    await expect(page.locator('[data-settings-search-id="language"]')).toContainText('界面语言')
    await expect(page.locator('[data-settings-search-id="language"]')).toContainText('设置 › 通用')
    await page.locator('.settings-search-clear').click()
    await search.fill('   ')
    await expect(page.locator('.settings-search-results')).toHaveCount(0)
    await search.fill('no-setting-can-match-this')
    await expect(page.locator('.settings-search-count')).toHaveText('未找到相关设置项')
    await page.locator('.settings-search-clear').click()
    await expect(page.locator('[data-settings-page="general"]')).toBeVisible()
  })
})

test('DeepSeek 搜索入口打开正确的 AI 子页且保留原有服务配置流程', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    await page.locator('.settings-search-input').fill('DeepSeek')
    await page.locator('[data-settings-search-id="webSearchProviders"]').click()
    await expect(page.locator('[data-ai-settings-view="search"]')).toBeVisible()
    await expect(page.locator('[data-setting-anchor="webSearchProviders"]')).toBeInViewport()
    const kinds = page.locator('.web-search-kind-select')
    await kinds.selectOption('DEEPSEEK')
    await page.getByRole('button', { name: 'Add: DeepSeek Search', exact: true }).click()
    const provider = page.locator('.web-search-provider-card').filter({ hasText: 'DeepSeek Search' })
    await expect(provider).toBeVisible()
    await expect(provider.locator('.provider-field').filter({ hasText: 'Endpoint' }).locator('input'))
      .toHaveValue('https://api.deepseek.com/v1/tools/search')
    await expect(provider.locator('.provider-field').filter({ hasText: 'API Key' }).locator('.secret-key-input')).toBeVisible()
    expect(await page.evaluate(async () => (await window.origread.getWebSearchSettings()).providers
      .some(item => item.kind === 'DEEPSEEK' && item.hasApiKey))).toBe(false)
    await page.screenshot({ path: 'test-results/desktop-settings-search-deepseek.png' })
  })
})

test('搜索保留未保存草稿、AI 内部切换确认和 RSSHub 禁用条件', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    await search.fill('instructions')
    await page.locator('[data-settings-search-id="customInstructions"]').click()
    const editor = page.locator('.llm-custom-instructions-editor textarea')
    await expect(editor).toBeVisible()
    await editor.fill('Keep this unsaved draft while searching.')
    await expect(page.locator('.llm-custom-instructions-editor button')).toBeEnabled()

    await search.fill('DeepSeek')
    page.once('dialog', dialog => dialog.dismiss())
    await page.locator('[data-settings-search-id="webSearchProviders"]').click()
    await expect(page.locator('.settings-search-results')).toBeVisible()
    await page.locator('.settings-search-clear').click()
    await expect(editor).toHaveValue('Keep this unsaved draft while searching.')
    await search.fill('DeepSeek')
    page.once('dialog', dialog => dialog.accept())
    await page.locator('[data-settings-search-id="webSearchProviders"]').click()
    await expect(page.locator('[data-ai-settings-view="search"]')).toBeVisible()
    expect(await page.evaluate(async () => (await window.origread.getLlmCustomizationSettings()).customInstructions))
      .not.toBe('Keep this unsaved draft while searching.')

    await page.evaluate(async () => { await window.origread.setRssHubEnabled(false) })
    await search.fill('RSSHub')
    await page.locator('[data-settings-search-id="rssHubAddInstance"]').click()
    await expect(page.locator('[data-setting-anchor="rssHubAddInstance"]')).toBeInViewport()
    await expect(page.locator('.rsshub-add-row input')).toBeDisabled()
    expect(await page.evaluate(async () => (await window.origread.getRssHubSettings()).enabled)).toBe(false)
  })
})

test('搜索备份操作后键盘 Tab 顺序保持，清空搜索后恢复按钮仍可达', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    const exportButton = page.locator('button[data-setting-anchor="exportBackup"]')
    const restoreButton = page.locator('button[data-setting-anchor="restoreBackup"]')
    await search.fill('backup')
    await page.locator('[data-settings-search-id="exportBackup"]').click()
    await expect(exportButton).toBeFocused()
    await search.fill('backup')
    await page.locator('[data-settings-search-id="restoreBackup"]').click()
    await expect(restoreButton).toBeFocused()

    // Both buttons were search destinations. Shift+Tab and Tab must still visit
    // them in their native order; never activate export or restore in this test.
    await page.keyboard.press('Shift+Tab')
    await expect(exportButton).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(restoreButton).toBeFocused()
    await expect(exportButton).toHaveJSProperty('tabIndex', 0)
    await expect(restoreButton).toHaveJSProperty('tabIndex', 0)

    await page.locator('.settings-search-clear').click()
    await expect(search).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.locator('[data-setting-anchor="backupIncludeSecrets"] input[type="checkbox"]')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(exportButton).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(restoreButton).toBeFocused()
  })
})

test('命中设置后手动滚动，返回搜索再退出不会重放旧定位', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    const scroller = page.locator('.settings-subpage')
    for (const exit of ['escape', 'clear', 'whitespace'] as const) {
      await search.fill('content width')
      await page.locator('[data-settings-search-id="readerContentWidth"]').click()
      await expect(page.locator('[data-setting-anchor="readerContentWidth"]')).toBeFocused()
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(20)
      await scroller.hover({ position: { x: 10, y: 10 } })
      await page.mouse.wheel(0, -3000)
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)

      await page.locator('.settings-search-back').click()
      await expect(page.locator('.settings-search-results')).toBeVisible()
      if (exit === 'escape') await page.keyboard.press('Escape')
      else if (exit === 'clear') await page.locator('.settings-search-clear').click()
      else await search.fill('   ')
      await expect(page.locator('.settings-search-results')).toHaveCount(0)
      // Wait through the animation-frame focus/scroll work, so a transient
      // restored position cannot hide a stale destination being replayed.
      await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }))
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0)
      await expect(search).toBeFocused()
    }
  })
})


async function setReaderLayout(page: Page, layoutMode: 'two-pane' | 'three-pane', width = 1180): Promise<void> {
  await page.evaluate(async layout => {
    await window.origread.updateSettings({
      layoutMode: layout, workspaceCollapsed: false, sourcePaneCollapsed: false, articlePaneCollapsed: false
    })
  }, layoutMode)
  await page.reload()
  await page.setViewportSize({ width, height: 740 })
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', layoutMode)
}

test('Escape 先清空设置查询，再从普通输入返回，且长按和输入法不会跨层', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    await search.fill('Answer language')
    await page.locator('[data-settings-search-id="aiOutputLanguage"]').click()
    const input = page.locator('[data-setting-anchor="aiOutputLanguage"] input')
    await expect(input).toBeVisible()

    // The toolbar is outside SettingsPanel. Its Escape must still clear that
    // page's retained query before any page navigation is attempted.
    await page.locator('.settings-back-button').focus()
    await page.keyboard.down('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.keyboard.down('Escape')
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.keyboard.up('Escape')

    await input.focus()
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })
    await expect(page.locator('.settings-layout')).toBeVisible()
    await input.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true })
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-layout')).toHaveCount(0)
    await expect(page.locator('.settings-button')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.settings-layout')).toBeVisible()
  })
})

test('Escape 依次关闭设置帮助弹窗、清空查询、返回阅读，焦点回到原入口', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    await search.fill('user guide')
    await page.locator('[data-settings-search-id="userGuide"]').click()
    const guide = page.locator('[data-setting-anchor="userGuide"] button')
    await guide.click()
    await expect(page.locator('.rule-modal')).toBeVisible()
    // Even if focus is moved outside the dialog, its visible layer owns Escape.
    await page.locator('.settings-back-button').focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.rule-modal')).toHaveCount(0)
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(search).toHaveValue('user guide')
    await expect(guide).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-layout')).toHaveCount(0)
  })
})

test('Escape 返回设置继续确认未保存草稿，取消保留输入，接受才退出', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    const search = page.locator('.settings-search-input')
    await search.fill('instructions')
    await page.locator('[data-settings-search-id="customInstructions"]').click()
    const editor = page.locator('.llm-custom-instructions-editor textarea')
    const draft = 'Keep the unsaved Escape navigation draft.'
    await editor.fill(draft)
    await expect(page.locator('.llm-custom-instructions-editor button')).toBeEnabled()

    let confirmations = 0
    const dismiss = async (dialog: import('@playwright/test').Dialog): Promise<void> => {
      confirmations += 1
      await dialog.dismiss()
    }
    page.on('dialog', dismiss)
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    expect(confirmations).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => confirmations).toBe(1)
    await expect(editor).toHaveValue(draft)
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect(editor).toBeFocused()

    page.off('dialog', dismiss)
    page.once('dialog', dialog => { void dialog.accept() })
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-layout')).toHaveCount(0)
    expect(await page.evaluate(async () => (await window.origread.getLlmCustomizationSettings()).customInstructions))
      .not.toBe(draft)
  })
})

test('发现来源分类控件与 Escape 分层退出保持搜索及返回焦点', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    await setReaderLayout(page, 'two-pane')
    const discover = page.locator('.source-discovery-button:visible')
    await discover.click()
    await expect(page.locator('.source-discovery-page')).toBeVisible()
    const search = page.locator('.source-discovery-search input')
    await search.fill('read')

    const category = page.locator('.source-discovery-category select')
    await category.focus()
    if (process.platform === 'darwin') {
      // AppKit's open select popup is outside CDP keyboard control and can block
      // dispatchKeyEvent. Exercise selection with Playwright's supported API,
      // then test Escape on the focused, closed control below.
      await expect.poll(() => category.locator('option').count()).toBeGreaterThan(1)
      const [value] = await category.selectOption({ index: 1 })
      await expect(category).toHaveValue(value!)
    } else {
      // Windows/Linux additionally exercise dismissal of the native popup.
      await page.keyboard.press('Space')
      await page.keyboard.press('Escape')
    }
    await expect(page.locator('.source-discovery-page')).toBeVisible()
    await expect(search).toHaveValue('read')

    await category.focus()
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('.source-discovery-page')).toBeVisible()
    await search.focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.source-discovery-page')).toHaveCount(0)
    await expect(discover).toBeFocused()
  })
})

test('设置上方订阅菜单和添加弹窗各消费一次 Escape，不穿透页面搜索', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    await setReaderLayout(page, 'two-pane')
    await page.locator('.settings-button').click()
    const search = page.locator('.settings-search-input')
    await search.fill('font')
    const trigger = page.locator('.subscription-trigger:visible')
    await trigger.click()
    await expect(page.locator('.subscription-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.subscription-menu')).toHaveCount(0)
    await expect(search).toHaveValue('font')
    await expect(page.locator('.settings-layout')).toBeVisible()

    await trigger.click()
    await page.locator('.subscription-menu [role="menuitem"]').first().click()
    const dialog = page.locator('[aria-labelledby="add-source-title"]')
    await expect(dialog).toBeVisible()
    await dialog.locator('.dialog-field input').first().focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(search).toHaveValue('font')
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(page.locator('.settings-layout')).toBeVisible()
  })
})

test('规则模型下拉在焦点移出后仍先消费 Escape，父规则窗继续保留输入', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    await page.evaluate(async () => {
      const before = new Set((await window.origread.getAiSettings()).providers.map(provider => provider.id))
      const settings = await window.origread.addAiProvider()
      const provider = settings.providers.find(item => !before.has(item.id))
      if (!provider) throw new Error('Missing isolated test provider')
      await window.origread.updateAiProvider({
        id: provider.id, name: 'Escape test provider', enabled: true,
        defaultModel: 'escape-model', models: ['escape-model', 'escape-second']
      })
      await window.origread.updateAiSettings({ defaultProviderId: provider.id })
    })
    await page.locator('.settings-nav-button[aria-label="Website parsing rules"]').click()
    await page.getByRole('button', { name: /Generate website rule with AI/ }).click()
    const dialog = page.locator('.rule-modal')
    await expect(dialog).toBeVisible()
    const url = dialog.locator('.rule-dialog-field input').first()
    await url.fill('https://example.invalid/escape-fixture')
    const trigger = dialog.locator('.ai-rule-model-control button')
    await trigger.click()
    await expect(page.locator('.ai-rule-model-menu')).toBeVisible()
    await url.focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ai-rule-model-menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(url).toHaveValue('https://example.invalid/escape-fixture')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.settings-layout')).toBeVisible()
  })
})

test('Escape 按视觉堆叠先关抽屉上方右键菜单及管理层上方订阅菜单', async ({ userDataDir }) => {
  await withSettings(userDataDir, async page => {
    await setReaderLayout(page, 'three-pane', 1020)
    await page.locator('.collapsed-pane-restore').click()
    const overlay = page.locator('.adaptive-source-overlay')
    await expect(overlay).toBeVisible()
    await overlay.locator('.source-item').first().click({ button: 'right' })
    await expect(page.locator('.desktop-context-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.desktop-context-menu')).toHaveCount(0)
    await expect(overlay).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)

    await setReaderLayout(page, 'two-pane')
    await page.locator('.source-switcher-trigger').click()
    await page.locator('.source-switcher-manage').click()
    await expect(page.locator('.source-manager-overlay')).toBeVisible()
    await page.locator('.subscription-trigger:visible').click()
    await expect(page.locator('.subscription-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.subscription-menu')).toHaveCount(0)
    await expect(page.locator('.source-manager-overlay')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.source-manager-overlay')).toHaveCount(0)
  })
})

test('Escape 从设置返回同一原文页面，不重新请求网页且恢复键盘焦点', async ({ userDataDir }) => {
  let originalRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/original') originalRequests += 1
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end('<!doctype html><title>Escape original fixture</title><p>Original page stays open.</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local fixture port')
  const url = `http://127.0.0.1:${address.port}/original`
  try {
    await withSettings(userDataDir, async page => {
      await page.locator('.settings-back-button').click()
      await page.evaluate(async originalUrl => {
        const bounds = document.querySelector('.reader-stage')!.getBoundingClientRect()
        await window.origread.openOriginalArticle(originalUrl, {
          x: Math.round(bounds.x), y: Math.round(bounds.y),
          width: Math.round(bounds.width), height: Math.round(bounds.height)
        })
      }, url)
      await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-toolbar-mode', 'original')
      await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).title))
        .toBe('Escape original fixture')
      expect(originalRequests).toBe(1)
      await page.locator('.settings-button').click()
      await expect(page.locator('.settings-layout')).toBeVisible()
      expect(await page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
      await page.locator('.settings-search-input').focus()
      await page.keyboard.press('Escape')
      await expect(page.locator('.settings-layout')).toHaveCount(0)
      await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-toolbar-mode', 'original')
      await expect(page.locator('.settings-button')).toBeFocused()
      const state = await page.evaluate(() => window.origread.getOriginalArticleState())
      expect(state.open).toBe(true)
      expect(state.url).toBe(url)
      expect(originalRequests).toBe(1)
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
