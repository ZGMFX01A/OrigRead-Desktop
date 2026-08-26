import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('source and article dividers resize independently and persist only after drag ends', async () => {
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const sourcePane = page.locator('.source-pane')
    const articlePane = page.locator('.article-pane')
    const readerPane = page.locator('.reader-pane')
    const sourceDivider = page.locator('.pane-divider-source')
    const articleDivider = page.locator('.pane-divider-article')

    await expect(sourceDivider).toHaveAttribute('role', 'separator')
    await expect(articleDivider).toHaveAttribute('role', 'separator')
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(260, 0)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(380, 0)

    // pointermove 先只改变 Renderer 布局，持久化 Settings 必须仍保持拖动前值。
    await beginDividerDrag(page, sourceDivider, 40)
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(300, 0)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(380, 0)
    expect(await page.evaluate(async () => (await window.origread.getSettings()).sourcePaneWidth)).toBe(260)
    await page.mouse.up()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).sourcePaneWidth)).toBe(300)

    // Article Divider 只改变 Article Pane；Source Pane 宽度与已持久化值都不能串扰。
    await beginDividerDrag(page, articleDivider, 50)
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(300, 0)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(430, 0)
    expect(await page.evaluate(async () => (await window.origread.getSettings()).articlePaneWidth)).toBe(380)
    await page.mouse.up()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).articlePaneWidth)).toBe(430)
    expect(await page.evaluate(async () => (await window.origread.getSettings()).sourcePaneWidth)).toBe(300)

    // Source 最大 320；拖过边界也只停在合法上限。
    await dragDivider(page, sourceDivider, 500)
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(320, 0)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).sourcePaneWidth)).toBe(320)

    // Source 最小 220。
    await dragDivider(page, sourceDivider, -500)
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(220, 0)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).sourcePaneWidth)).toBe(220)

    // Article 最小 320；向左拖过边界不会压坏文章列表或 Reader。
    await dragDivider(page, articleDivider, -500)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(320, 0)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).articlePaneWidth)).toBe(320)

    // Article 最大 480。
    await dragDivider(page, articleDivider, 500)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(480, 0)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).articlePaneWidth)).toBe(480)
    expect((await requiredBox(readerPane)).width).toBeGreaterThan(400)

    // 重载后必须从持久化 Settings 恢复，而不是退回 260 / 380。
    await page.reload()
    await expect(sourcePane).toBeVisible()
    await expect(articlePane).toBeVisible()
    expect((await requiredBox(sourcePane)).width).toBeCloseTo(220, 0)
    expect((await requiredBox(articlePane)).width).toBeCloseTo(480, 0)
    await expect.poll(async () => page.evaluate(async () => {
      const settings = await window.origread.getSettings()
      return [settings.sourcePaneWidth, settings.articlePaneWidth]
    })).toEqual([220, 480])

    // UI-3P.8 起 1200 以下会进入 adaptive hidden；本测试只保留宽屏 resize 的 Divider/持久化职责。
    await testApp.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 760)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)
    const sourceAfterWindowResize = await requiredBox(sourcePane)
    const sourceDividerAfterWindowResize = await requiredBox(sourceDivider)
    const articleAfterWindowResize = await requiredBox(articlePane)
    const articleDividerAfterWindowResize = await requiredBox(articleDivider)
    const readerAfterWindowResize = await requiredBox(readerPane)
    expect(sourceAfterWindowResize.width).toBeCloseTo(220, 0)
    expect(articleAfterWindowResize.width).toBeCloseTo(480, 0)
    expect(sourceDividerAfterWindowResize.x).toBeGreaterThanOrEqual(sourceAfterWindowResize.x + sourceAfterWindowResize.width)
    expect(articleAfterWindowResize.x).toBeGreaterThanOrEqual(sourceDividerAfterWindowResize.x + sourceDividerAfterWindowResize.width)
    expect(articleDividerAfterWindowResize.x).toBeGreaterThanOrEqual(articleAfterWindowResize.x + articleAfterWindowResize.width)
    expect(readerAfterWindowResize.x).toBeGreaterThanOrEqual(articleDividerAfterWindowResize.x + articleDividerAfterWindowResize.width)
    expect(readerAfterWindowResize.width).toBeGreaterThan(550)
  } finally {
    await testApp.close()
  }
})

async function beginDividerDrag(page: Page, divider: Locator, deltaX: number): Promise<void> {
  const box = await requiredBox(divider)
  const x = box.x + box.width / 2
  // Article Divider 中央暂时保留 UI-3P.7 前的 legacy collapse handle；拖拽命中其上方纯 Divider 区域。
  const y = box.y + Math.min(80, box.height / 4)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX, y, { steps: 5 })
}

async function dragDivider(page: Page, divider: Locator, deltaX: number): Promise<void> {
  await beginDividerDrag(page, divider, deltaX)
  await page.mouse.up()
}

async function requiredBox(locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected visible pane/divider bounding box')
  return box
}
