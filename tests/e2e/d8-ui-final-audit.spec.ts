import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

type LayoutMode = 'two-pane' | 'three-pane'
type Theme = 'light' | 'dark'
type Language = 'zh' | 'en'

const WIDTHS = [1024, 1280, 1440, 1800] as const
const LAYOUTS: LayoutMode[] = ['three-pane', 'two-pane']
const THEMES: Theme[] = ['light', 'dark']
const LANGUAGES: Language[] = ['zh', 'en']

test('D8.5 final desktop UI stays readable, named and focusable across target widths, themes and languages', async () => {
  test.setTimeout(90_000)
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await testApp.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setMinimumSize(800, 640)
    })

    for (const language of LANGUAGES) {
      await page.evaluate((value) => window.origread.updateSettings({ language: value }), language)
      await page.reload()

      for (const width of WIDTHS) {
        await resizeContent(testApp.app, page, width, 800)

        for (const layoutMode of LAYOUTS) {
          await page.evaluate((value) => window.origread.updateSettings({ layoutMode: value }), layoutMode)
          await page.reload()

          for (const theme of THEMES) {
            await page.evaluate((value) => window.origread.updateSettings({ theme: value }), theme)
            await page.reload()
            await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', layoutMode)
            await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
            await expectBaseGeometry(page, width, layoutMode)
            await expectVisibleControlsNamed(page)
          }
        }
      }
    }

    // Focus rings are a keyboard contract, not a hover treatment. Lock representative top-level,
    // Settings and compact Reader controls so later CSS cleanup cannot silently remove them.
    await resizeContent(testApp.app, page, 1024, 800)
    await page.evaluate(() => window.origread.updateSettings({ language: 'zh', layoutMode: 'two-pane', theme: 'light' }))
    await page.reload()
    await expectVisibleFocusRing(page.locator('.settings-button'))

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expectVisibleControlsNamed(page)
    await expectVisibleFocusRing(page.locator('.layout-mode-option').first())
    await page.locator('.settings-close-button').click()

    const more = page.locator('.reader-more-button')
    if (await more.isVisible()) await expectVisibleFocusRing(more)

    // Empty-state audits cannot see controls rendered only for persisted user data. Seed one
    // rule and verify the custom hidden checkbox plus icon-only delete action remain named and
    // keyboard-visible once the dynamic row exists.
    await page.evaluate(() => window.origread.addArticleFilter('D8 accessibility', 'KEYWORD', null))
    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: '文章过滤' }).click()
    const filterRow = page.locator('.rule-row').filter({ hasText: 'D8 accessibility' })
    await expect(filterRow).toBeVisible()
    const filterToggle = filterRow.getByRole('checkbox', { name: 'D8 accessibility' })
    await expectCustomInputFocusRing(filterToggle)
    await expect(filterRow.getByRole('button', { name: '删除' })).toBeVisible()
    await expectVisibleControlsNamed(page)
    await filterRow.getByRole('button', { name: '删除' }).click()

    // Every Settings destination participates in the same accessibility contract. Walking the
    // nav catches form controls that only exist in Accounts / Translation / rules / RSSHub /
    // Backup / About / Update instead of letting the audit pass on General + AI alone.
    const settingsNavButtons = page.locator('.settings-nav-button')
    const settingsNavCount = await settingsNavButtons.count()
    for (let index = 0; index < settingsNavCount; index += 1) {
      await settingsNavButtons.nth(index).click()
      await expect(page.locator('.settings-page')).toBeVisible()
      await expect.poll(async () => page.locator('.settings-page .article-body-status').count()).toBe(0)
      await expectVisibleControlsNamed(page)
    }

    // Empty integrations must degrade into actionable Settings copy instead of blank panels or
    // raw implementation errors. A fresh isolated profile has no Dedicated Search or MCP servers.
    await page.locator('.settings-nav-button').filter({ hasText: 'AI 阅读' }).click()
    await page.getByRole('tab', { name: '模型服务' }).click()
    const addAiProvider = page.locator('.ai-provider-workspace-head .mini-action.icon-only')
    await expect(addAiProvider).toHaveAttribute('aria-label', /添加.*AI 服务/)
    await expect(addAiProvider).toHaveText('')
    await page.getByRole('tab', { name: '网络搜索' }).click()
    await expect(page.locator('.llm-settings-empty')).toContainText('还没有搜索服务')
    await expectVisibleControlsNamed(page)
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()
    const mcpEmptyStates = page.locator('.llm-settings-empty')
    await expect(mcpEmptyStates.filter({ hasText: '还没有 MCP Server' })).toBeVisible()
    await expect(mcpEmptyStates.filter({ hasText: '还没有本地 MCP Server' })).toBeVisible()
    await expectVisibleControlsNamed(page)
  } finally {
    await testApp.close()
  }
})

test('D8.6.5 reduced motion collapses movement tokens without breaking keyboard focus', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.app-shell')).toBeVisible()

    const motion = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        instant: style.getPropertyValue('--motion-duration-instant').trim(),
        fast: style.getPropertyValue('--motion-duration-fast').trim(),
        normal: style.getPropertyValue('--motion-duration-normal').trim(),
        emphasized: style.getPropertyValue('--motion-duration-emphasized').trim(),
        distanceXs: style.getPropertyValue('--motion-distance-xs').trim(),
        distanceSm: style.getPropertyValue('--motion-distance-sm').trim(),
        distanceMd: style.getPropertyValue('--motion-distance-md').trim()
      }
    })

    expect(motion).toEqual({
      instant: '1ms',
      fast: '1ms',
      normal: '1ms',
      emphasized: '1ms',
      distanceXs: '0px',
      distanceSm: '0px',
      distanceMd: '0px'
    })

    await expectVisibleFocusRing(page.locator('.settings-button'))
    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expectVisibleControlsNamed(page)
  } finally {
    await testApp.close()
  }
})

async function expectBaseGeometry(page: Page, expectedWidth: number, layoutMode: LayoutMode): Promise<void> {
  const geometry = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    readerWidth: document.querySelector('.reader-pane')?.getBoundingClientRect().width ?? 0
  }))
  expect(Math.abs(geometry.width - expectedWidth)).toBeLessThanOrEqual(2)
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width)
  expect(geometry.readerWidth).toBeGreaterThan(300)
  await expect(page.locator('.settings-button')).toBeVisible()

  if (layoutMode === 'two-pane') {
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.source-switcher-trigger')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
  } else {
    await expect(page.locator('.workspace-pane')).toHaveCount(0)
    if (expectedWidth >= 1200) await expect(page.locator('.source-pane')).toBeVisible()
    else await expect(page.locator('.source-pane')).toHaveCount(0)
  }
}

async function expectVisibleControlsNamed(page: Page): Promise<void> {
  const unnamed = await page.locator('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="slider"], [role="combobox"], [role="separator"]').evaluateAll((elements) => {
    const visible = (element: Element): boolean => {
      const html = element as HTMLElement
      const style = getComputedStyle(html)
      const box = html.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
    }
    const labelText = (element: Element): string => {
      const html = element as HTMLElement
      const ariaLabel = html.getAttribute('aria-label')?.trim() ?? ''
      if (ariaLabel) return ariaLabel
      const labelledBy = html.getAttribute('aria-labelledby')?.trim() ?? ''
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim()
        if (text) return text
      }
      if (html instanceof HTMLInputElement || html instanceof HTMLSelectElement || html instanceof HTMLTextAreaElement) {
        const text = Array.from(html.labels ?? []).map((label) => label.textContent?.trim() ?? '').join(' ').trim()
        if (text) return text
        return html.getAttribute('title')?.trim() ?? ''
      }
      const text = html.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      if (text) return text
      return html.getAttribute('title')?.trim() ?? ''
    }
    return elements
      .filter(visible)
      .filter((element) => !labelText(element))
      .map((element) => {
        const html = element as HTMLElement
        return `${element.tagName.toLowerCase()}${html.className ? `.${String(html.className).replace(/\s+/g, '.')}` : ''}`
      })
  })
  expect(unnamed).toEqual([])
}

async function expectVisibleFocusRing(locator: ReturnType<Page['locator']>): Promise<void> {
  // Chromium intentionally suppresses :focus-visible after pointer interaction. Establish
  // keyboard modality first, then move focus to the representative control under audit.
  await locator.page().keyboard.press('Tab')
  await locator.focus()
  await expect(locator).toBeFocused()
  await expect.poll(async () => locator.evaluate((element) => {
    const style = getComputedStyle(element as HTMLElement)
    const outlineVisible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
    const shadowVisible = style.boxShadow !== 'none'
    return (element as HTMLElement).matches(':focus-visible') && (outlineVisible || shadowVisible)
  })).toBe(true)
}

async function expectCustomInputFocusRing(locator: ReturnType<Page['locator']>): Promise<void> {
  await locator.page().keyboard.press('Tab')
  await locator.focus()
  await expect(locator).toBeFocused()
  await expect.poll(async () => locator.evaluate((element) => {
    const indicator = element.nextElementSibling as HTMLElement | null
    if (!indicator) return false
    const style = getComputedStyle(indicator)
    return (element as HTMLElement).matches(':focus-visible')
      && style.outlineStyle !== 'none'
      && parseFloat(style.outlineWidth) > 0
  })).toBe(true)
}

async function resizeContent(
  electronApp: Awaited<ReturnType<typeof launchIsolatedOrigRead>>['app'],
  page: Page,
  width: number,
  height: number
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width)).toBeLessThanOrEqual(2)
}
