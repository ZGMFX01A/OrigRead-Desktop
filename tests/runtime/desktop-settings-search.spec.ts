import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
