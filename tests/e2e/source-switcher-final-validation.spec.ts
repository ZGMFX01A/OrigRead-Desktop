import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

type Theme = 'light' | 'dark'

const CONTENT_WIDTHS = [1440, 1200, 960] as const
const THEMES: Theme[] = ['light', 'dark']

for (const scaleFactor of [1, 1.25, 1.5]) {
  test(`SS-5 Source Switcher remains anchored and readable at ${Math.round(scaleFactor * 100)}% device scale`, async () => {
    test.setTimeout(90_000)
    const testApp = await launchIsolatedOrigRead({}, [`--force-device-scale-factor=${scaleFactor}`])

    try {
      const page = await testApp.app.firstWindow()
      await expect(page.locator('.app-shell')).toBeVisible()

      // 960px 属于发布级矩阵的一部分；仅测试进程放宽最小尺寸，产品默认最小尺寸保持不变。
      await testApp.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setMinimumSize(800, 640)
      })

      await switchToTwoPane(page)

      for (const width of CONTENT_WIDTHS) {
        await resizeContent(testApp.app, page, width, 800)

        for (const theme of THEMES) {
          await setTheme(page, theme)
          await openAndValidateSwitcher(page, width, theme)

          // 只保存两个最有代表性的真实 Electron 基线，避免把 18 张重复截图长期留在仓库文档目录。
          if (scaleFactor === 1 && ((width === 1440 && theme === 'light') || (width === 960 && theme === 'dark'))) {
            const baselineDir = join(process.cwd(), '..', 'docs', 'ui-baselines')
            await mkdir(baselineDir, { recursive: true })
            const suffix = width === 1440 ? 'light-1440' : 'dark-960'
            await page.screenshot({
              path: join(baselineDir, `desktop-source-switcher-ss5-${suffix}.png`),
              fullPage: true
            })
          }

          await page.keyboard.press('Escape')
          await expect(page.locator('.source-switcher-popover')).toHaveCount(0)
          await expect(page.locator('.source-switcher-trigger')).toBeFocused()
        }
      }

      // SS-4/SS-5 边界：Source Manager 只能覆盖 Workspace，不能侵入 Reader，也不能与 Quick Switcher 同时存在。
      await resizeContent(testApp.app, page, 1200, 800)
      await setTheme(page, 'dark')
      await page.locator('.source-switcher-trigger').click()
      await page.locator('.source-switcher-manage').click()
      const manager = page.locator('.source-manager-overlay')
      await expect(page.locator('.source-switcher-popover')).toHaveCount(0)
      await expect(manager).toBeVisible()
      await expect(page.locator('.reader-pane')).toBeVisible()

      const managerGeometry = await page.evaluate(() => {
        const workspace = document.querySelector('.workspace-pane')!.getBoundingClientRect()
        const managerElement = document.querySelector('.source-manager-overlay')!.getBoundingClientRect()
        const reader = document.querySelector('.reader-pane')!.getBoundingClientRect()
        return {
          workspaceLeft: workspace.left,
          workspaceRight: workspace.right,
          managerLeft: managerElement.left,
          managerRight: managerElement.right,
          readerLeft: reader.left
        }
      })
      expect(managerGeometry.managerLeft).toBeGreaterThanOrEqual(managerGeometry.workspaceLeft)
      expect(managerGeometry.managerRight).toBeLessThanOrEqual(managerGeometry.workspaceRight + 1)
      expect(managerGeometry.managerRight).toBeLessThanOrEqual(managerGeometry.readerLeft + 1)

      await page.keyboard.press('Escape')
      await expect(manager).toHaveCount(0)
      await expect(page.locator('.source-switcher-trigger')).toBeFocused()
    } finally {
      await testApp.close()
    }
  })
}

async function switchToTwoPane(page: Page): Promise<void> {
  await page.locator('.settings-button').click()
  await expect(page.locator('.settings-layout')).toBeVisible()
  await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
  await page.locator('.settings-close-button').click()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
  await expect(page.locator('.workspace-pane')).toBeVisible()
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.locator('.settings-button').click()
  await expect(page.locator('.settings-layout')).toBeVisible()
  await page.locator('.theme-select').selectOption(theme)
  await page.locator('.settings-close-button').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
}

/**
 * 验证 Popover 始终锚定在双栏 Workspace 内，不覆盖 Reader；同时锁定 Light/Dark 的真实 surface。
 */
async function openAndValidateSwitcher(page: Page, expectedWidth: number, theme: Theme): Promise<void> {
  const trigger = page.locator('.source-switcher-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()

  const popover = page.locator('.source-switcher-popover')
  await expect(popover).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.source-switcher-search input')).toBeFocused()
  await expect(page.locator('.article-pane')).toBeVisible()
  await expect(page.locator('.reader-pane')).toBeVisible()

  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace-pane')!.getBoundingClientRect()
    const overlay = document.querySelector('.source-switcher-popover')!.getBoundingClientRect()
    const triggerElement = document.querySelector('.source-switcher-trigger')!.getBoundingClientRect()
    const reader = document.querySelector('.reader-pane')!.getBoundingClientRect()
    const overlayStyle = getComputedStyle(document.querySelector('.source-switcher-popover')!)
    const searchStyle = getComputedStyle(document.querySelector('.source-switcher-search')!)
    return {
      viewportWidth: window.innerWidth,
      workspaceLeft: workspace.left,
      workspaceRight: workspace.right,
      workspaceWidth: workspace.width,
      overlayLeft: overlay.left,
      overlayRight: overlay.right,
      overlayTop: overlay.top,
      overlayWidth: overlay.width,
      overlayHeight: overlay.height,
      triggerBottom: triggerElement.bottom,
      readerLeft: reader.left,
      overlayBackground: overlayStyle.backgroundColor,
      searchBackground: searchStyle.backgroundColor
    }
  })

  // Windows 非整数 DPI 下 CSS viewport 可能出现相邻 2px 量化，几何行为仍必须保持一致。
  expect(Math.abs(geometry.viewportWidth - expectedWidth)).toBeLessThanOrEqual(2)
  expect(geometry.overlayLeft).toBeGreaterThanOrEqual(geometry.workspaceLeft + 10)
  expect(geometry.overlayRight).toBeLessThanOrEqual(geometry.workspaceRight - 10)
  expect(geometry.overlayRight).toBeLessThanOrEqual(geometry.readerLeft + 1)
  expect(geometry.overlayWidth).toBeGreaterThanOrEqual(279)
  expect(geometry.overlayWidth).toBeLessThanOrEqual(361)
  expect(geometry.overlayWidth).toBeLessThan(geometry.workspaceWidth - 20)
  expect(geometry.overlayHeight).toBeGreaterThan(80)
  expect(geometry.overlayTop).toBeGreaterThanOrEqual(geometry.triggerBottom + 4)

  expect(geometry.overlayBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(geometry.searchBackground).not.toBe('rgba(0, 0, 0, 0)')
  if (theme === 'dark') {
    expect(isNearWhite(geometry.overlayBackground)).toBe(false)
    expect(isNearWhite(geometry.searchBackground)).toBe(false)
  }
}

function isNearWhite(color: string): boolean {
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!rgb) return false
  return Number(rgb[1]) >= 245 && Number(rgb[2]) >= 245 && Number(rgb[3]) >= 245
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
