import { expect, test, type Locator } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('reader toolbar responds to Reader pane width and keeps Settings visible', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    const readerPane = page.locator('.reader-pane')
    const readerToolbar = page.locator('.reader-toolbar')
    const settingsButton = page.locator('.settings-button')
    const aiLabel = page.locator('.ai-summary-button > span:not(.ai-summary-accent-icon)')
    const voiceControl = page.locator('.reader-voice-control')
    const voiceSelect = page.locator('.reader-voice-select')
    const moreButton = page.locator('.reader-more-button')

    // 默认三栏的 Reader 实际只有约 790px：普通阅读不再显示“阅读”，并应自动进入容器级紧凑模式。
    const mediumReader = await requiredBox(readerPane)
    expect(mediumReader.width).toBeGreaterThan(650)
    expect(mediumReader.width).toBeLessThan(1000)
    await expect(page.locator('.reader-title')).toHaveCount(0)
    await expect(aiLabel).toHaveCSS('display', 'none')
    await expect(voiceSelect).toHaveCSS('opacity', '0')
    expect((await requiredBox(voiceControl)).width).toBeLessThanOrEqual(36)
    await expect(moreButton).toBeHidden()
    await expect(settingsButton).toBeVisible()
    await expectInside(settingsButton, readerToolbar)

    // Settings / Source Discovery 仍显示语义标题；普通阅读标题删除不影响这些特殊页面。
    await settingsButton.click()
    await expect(page.locator('.reader-title')).toContainText(/设置|Settings/)
    await page.locator('.settings-close-button').click()
    await page.locator('.source-discovery-button').click()
    await expect(page.locator('.reader-title')).toContainText(/发现来源|来源发现|Source Discovery/)
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.reader-title')).toHaveCount(0)

    // Reader 再宽也只保留图标；文字仅通过 title / aria-label 提示，避免双栏宽屏重新撑满工具栏。
    await page.setViewportSize({ width: 1800, height: 900 })
    expect((await requiredBox(readerPane)).width).toBeGreaterThan(1000)
    await expect(aiLabel).toHaveCSS('display', 'none')
    await expect(page.locator('.ai-summary-button')).toHaveAttribute('title', /AI 摘要|AI Summary/)
    await expect(page.locator('.translation-button')).toHaveAttribute('title', /翻译|Translation/)
    await expect(voiceSelect).toHaveCSS('opacity', '0')
    expect((await requiredBox(voiceControl)).width).toBeLessThanOrEqual(36)
    await expectInside(settingsButton, readerToolbar)

    // 切双栏并压到最小支持窗口：<650px 的 Reader 只把低频操作收入 More，Settings 仍固定可见。
    await settingsButton.click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await page.locator('.settings-close-button').click()
    await page.setViewportSize({ width: 960, height: 800 })
    expect((await requiredBox(readerPane)).width).toBeLessThan(650)
    await expect(moreButton).toBeVisible()
    await expect(page.locator('.reader-secondary-actions')).toBeHidden()
    await expect(settingsButton).toBeVisible()
    await expectInside(settingsButton, readerToolbar)

    await moreButton.click()
    await expect(page.locator('.reader-secondary-actions')).toBeVisible()
    await expect(voiceSelect).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.reader-secondary-actions')).toBeHidden()
    await expect(moreButton).toBeFocused()
  } finally {
    await testApp.close()
  }
})

async function requiredBox(locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected locator to have a bounding box')
  return box
}

async function expectInside(child: Locator, parent: Locator): Promise<void> {
  const [childBox, parentBox] = await Promise.all([requiredBox(child), requiredBox(parent)])
  expect(childBox.x).toBeGreaterThanOrEqual(parentBox.x - 0.5)
  expect(childBox.x + childBox.width).toBeLessThanOrEqual(parentBox.x + parentBox.width + 0.5)
}
