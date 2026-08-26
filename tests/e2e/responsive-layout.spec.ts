import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('responsive layout hides Source adaptively without overwriting manual pane preferences', async () => {
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.evaluate(async () => {
      await window.origread.updateSettings({
        sourcePaneWidth: 300,
        articlePaneWidth: 480,
        sourcePaneCollapsed: false,
        articlePaneCollapsed: false
      })
      window.location.reload()
    })
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()

    // ≥1200：完全遵守手动状态，三栏同时存在。
    await resizeContent(testApp.app, page, 1300, 760)
    await expect(page.locator('.app-shell')).not.toHaveClass(/adaptive-source-hidden/)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    expect((await requiredBox(page.locator('.source-pane'))).width).toBeCloseTo(300, 0)
    expect((await requiredBox(page.locator('.article-pane'))).width).toBeCloseTo(480, 0)

    await resizeContent(testApp.app, page, 1200, 760)
    await expect(page.locator('.app-shell')).not.toHaveClass(/adaptive-source-hidden/)
    await expect(page.locator('.source-pane')).toBeVisible()
    // 当前 Windows/DPI 组合的 CSS viewport 以 2px 粒度量化；精确 1199 由纯函数单测锁定，Electron 取可达的 1198。
    await resizeContent(testApp.app, page, 1198, 760)
    await expect(page.locator('.app-shell')).toHaveClass(/adaptive-source-hidden/)
    await expect(page.locator('.source-pane')).toHaveCount(0)

    // 960~1199：只临时隐藏 Source；Article/Reader 保持，Settings 绝不被 adaptive 改写。
    await resizeContent(testApp.app, page, 1100, 760)
    await expect(page.locator('.app-shell')).toHaveClass(/adaptive-source-hidden/)
    await expect(page.locator('.app-shell')).not.toHaveClass(/compact-layout/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.pane-divider-source')).toHaveAttribute('data-collapsed', 'true')
    await expect(page.locator('.pane-divider-article')).toHaveAttribute('data-collapsed', 'false')
    expect((await requiredBox(page.locator('.reader-pane'))).width).toBeGreaterThan(550)
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: false })

    // Adaptive Source 通过明确 overlay 临时打开；焦点进入可见关闭按钮，Escape 可关闭。
    await page.locator('.pane-divider-source .collapse-handle').click()
    await expect(page.locator('.adaptive-source-overlay')).toBeVisible()
    await expect(page.locator('.adaptive-source-overlay .source-pane')).toBeVisible()
    await expect(page.locator('.adaptive-source-overlay-close')).toBeFocused()
    expect((await requiredBox(page.locator('.adaptive-source-overlay'))).width).toBeCloseTo(300, 0)
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: false })
    await page.locator('.adaptive-source-overlay .subscription-trigger').click()
    await expect(page.locator('.adaptive-source-overlay .subscription-menu')).toBeVisible()
    await page.locator('.adaptive-source-overlay-close').click()
    await expect(page.locator('.adaptive-source-overlay')).toHaveCount(0)
    await page.locator('.pane-divider-source .collapse-handle').click()
    await expect(page.locator('.adaptive-source-overlay')).toBeVisible()
    await expect(page.locator('.adaptive-source-overlay .subscription-menu')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.adaptive-source-overlay')).toHaveCount(0)

    // <960：测试时临时降低 BrowserWindow minimum size；生产 minWidth 仍保持 960。
    await testApp.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(800, 640)
    })
    await resizeContent(testApp.app, page, 960, 760)
    await expect(page.locator('.app-shell')).not.toHaveClass(/compact-layout/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.pane-divider-article')).toHaveAttribute('role', 'separator')
    // 同理，精确 959 由 resolveResponsivePaneLayout 单测覆盖；Electron 验证真实可达的 958。
    await resizeContent(testApp.app, page, 958, 760)
    await expect(page.locator('.app-shell')).toHaveClass(/compact-layout/)
    await expect(page.locator('.pane-divider-article')).not.toHaveAttribute('role', 'separator')
    await resizeContent(testApp.app, page, 900, 760)
    await expect(page.locator('.app-shell')).toHaveClass(/compact-layout/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    const compactArticle = await requiredBox(page.locator('.article-pane'))
    const compactReader = await requiredBox(page.locator('.reader-pane'))
    expect(compactArticle.width).toBeCloseTo(445, 0)
    expect(compactReader.width).toBeGreaterThanOrEqual(420)
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    // compact 下手动收起 Article 仍是持久化操作；回到宽屏后该手动偏好必须保留。
    await page.locator('.pane-divider-article .collapse-handle').click()
    await expect(page.locator('.article-pane')).toHaveCount(0)
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: true })
    await testApp.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(960, 640)
    })
    await resizeContent(testApp.app, page, 1300, 760)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toHaveCount(0)
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: true })
    await page.locator('.pane-divider-article .collapse-handle').click()
    await expect(page.locator('.article-pane')).toBeVisible()

    // 手动 Source collapse 也必须跨 adaptive 往返保留；窄屏 rail 显式点击才恢复并打开 overlay。
    await page.locator('.pane-divider-source .collapse-handle').click()
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: true, articlePaneCollapsed: false })
    await resizeContent(testApp.app, page, 1100, 760)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await page.locator('.pane-divider-source .collapse-handle').click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).sourcePaneCollapsed)).toBe(false)
    await expect(page.locator('.adaptive-source-overlay')).toBeVisible()
    await page.locator('.adaptive-source-overlay-close').click()
    await resizeContent(testApp.app, page, 1300, 760)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expectPaneSettings(page, { sourcePaneWidth: 300, articlePaneWidth: 480, sourcePaneCollapsed: false, articlePaneCollapsed: false })
  } finally {
    await testApp.close()
  }
})

for (const scaleFactor of [1.25, 1.5]) {
  test(`responsive breakpoints remain stable at ${Math.round(scaleFactor * 100)}% device scale`, async () => {
    const testApp = await launchIsolatedOrigRead({}, [`--force-device-scale-factor=${scaleFactor}`])
    try {
      const page = await testApp.app.firstWindow()
      await expect(page.locator('.app-shell')).toBeVisible()
      await resizeContent(testApp.app, page, 1100, 760)
      expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(scaleFactor, 1)
      await expect(page.locator('.app-shell')).toHaveClass(/adaptive-source-hidden/)
      await expect(page.locator('.source-pane')).toHaveCount(0)
      await expect(page.locator('.article-pane')).toBeVisible()
      expect((await requiredBox(page.locator('.reader-pane'))).width).toBeGreaterThan(500)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await expectPaneSettings(page, { sourcePaneWidth: 260, articlePaneWidth: 380, sourcePaneCollapsed: false, articlePaneCollapsed: false })
    } finally {
      await testApp.close()
    }
  })
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

  // Windows / HiDPI 下 BrowserWindow content DIP 与 CSS viewport 可能有 1~2px 取整差。
  // 断点测试必须以真实 window.innerWidth 为准，所以根据实际差值反向修正到目标 CSS 宽度。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.waitForTimeout(40)
    const actual = await page.evaluate(() => window.innerWidth)
    if (actual === width) return
    await electronApp.evaluate(({ BrowserWindow }, adjustment) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) return
      const [currentWidth] = window.getContentSize()
      window.setContentSize(currentWidth + adjustment.delta, adjustment.height)
    }, { delta: width - actual, height })
  }
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

async function expectPaneSettings(
  page: Page,
  expected: { sourcePaneWidth: number; articlePaneWidth: number; sourcePaneCollapsed: boolean; articlePaneCollapsed: boolean }
): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const settings = await window.origread.getSettings()
    return {
      sourcePaneWidth: settings.sourcePaneWidth,
      articlePaneWidth: settings.articlePaneWidth,
      sourcePaneCollapsed: settings.sourcePaneCollapsed,
      articlePaneCollapsed: settings.articlePaneCollapsed
    }
  })).toEqual(expected)
}

async function requiredBox(locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected visible pane bounding box')
  return box
}
