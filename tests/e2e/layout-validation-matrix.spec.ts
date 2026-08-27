import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

type LayoutMode = 'two-pane' | 'three-pane'
type Theme = 'light' | 'dark'

const CONTENT_WIDTHS = [1440, 1200, 960] as const
const LAYOUT_MODES: LayoutMode[] = ['three-pane', 'two-pane']
const THEMES: Theme[] = ['light', 'dark']

for (const scaleFactor of [1, 1.25, 1.5]) {
  test(`DL-6 layout matrix stays usable at ${Math.round(scaleFactor * 100)}% device scale`, async () => {
    test.setTimeout(60_000)
    const testApp = await launchIsolatedOrigRead(
      {},
      [`--force-device-scale-factor=${scaleFactor}`]
    )

    try {
      const page = await testApp.app.firstWindow()
      await expect(page.locator('.app-shell')).toBeVisible()
      expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(scaleFactor, 1)

      // 960px 是 DL-6 的真实验收宽度；测试进程临时放宽 BrowserWindow 最小宽度，生产默认仍保持 960。
      await testApp.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setMinimumSize(800, 640)
      })

      // 默认首次启动仍是三栏；同时验证持久化为双栏/三栏后 reload 都能直接以目标布局启动。
      if (scaleFactor === 1) {
        await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
        await page.evaluate(() => window.origread.updateSettings({ layoutMode: 'two-pane' }))
        await page.reload()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
        await expect(page.locator('.workspace-pane')).toBeVisible()
        await page.evaluate(() => window.origread.updateSettings({ layoutMode: 'three-pane' }))
        await page.reload()
        await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
      }

      for (const width of CONTENT_WIDTHS) {
        await resizeContent(testApp.app, page, width, 800)

        for (const layoutMode of LAYOUT_MODES) {
          await setLayoutAndTheme(page, layoutMode, 'light')
          await expectLayoutGeometry(page, layoutMode, width)

          // Light / Dark 都必须在两种布局下可即时切换；Settings 在每个宽度下都必须能打开。
          for (const theme of THEMES) {
            await setTheme(page, theme)
            await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
            await expect(page.locator('.settings-button')).toBeVisible()
          }
        }
      }
    } finally {
      await testApp.close()
    }
  })
}

async function setLayoutAndTheme(page: Page, layoutMode: LayoutMode, theme: Theme): Promise<void> {
  await page.locator('.settings-button').click()
  const settings = page.locator('.settings-layout')
  await expect(settings).toBeVisible()
  const option = page.locator(`.layout-mode-option[data-layout-mode="${layoutMode}"]`)
  await option.click()
  await expect(option).toHaveAttribute('aria-pressed', 'true')
  await page.locator('.theme-select').selectOption(theme)
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', layoutMode)
  await page.locator('.settings-close-button').click()
  await expect(settings).toBeHidden()
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.locator('.settings-button').click()
  await expect(page.locator('.settings-layout')).toBeVisible()
  await page.locator('.theme-select').selectOption(theme)
  await page.locator('.settings-close-button').click()
}

async function expectLayoutGeometry(page: Page, layoutMode: LayoutMode, width: number): Promise<void> {
  await expect(page.locator('.reader-pane')).toBeVisible()
  await expect(page.locator('.article-pane')).toBeVisible()
  await expect(page.locator('.settings-button')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const readerWidth = await page.locator('.reader-pane').evaluate((element) => element.getBoundingClientRect().width)
  expect(readerWidth).toBeGreaterThan(300)

  if (layoutMode === 'two-pane') {
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.pane-divider-workspace')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.source-switcher-trigger')).toBeVisible()
    return
  }

  await expect(page.locator('.workspace-pane')).toHaveCount(0)
  if (width >= 1200) {
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.app-shell')).not.toHaveClass(/adaptive-source-hidden/)
  } else {
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.app-shell')).toHaveClass(/adaptive-source-hidden/)
  }
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
  // Windows 在 125% 等非整数缩放下会把 CSS viewport 量化到相邻的 2px；布局断点仍按实际 CSS 宽度判断。
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width)).toBeLessThanOrEqual(2)
}
