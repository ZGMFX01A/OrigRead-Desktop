import { expect, test, type Locator } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('reader toolbar responds to Reader pane width and keeps Settings visible', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()
    // 先固定中文作为基线；翻译动作图标本身必须保持系统级固定 glyph，不再本地化变形。
    await page.evaluate(async () => { await window.origread.updateSettings({ language: 'zh' }) })
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()

    const readerPane = page.locator('.reader-pane')
    const readerToolbar = page.locator('.reader-toolbar')
    const settingsButton = page.locator('.settings-button')
    const aiLabel = page.locator('.ai-summary-button > span:not(.ai-summary-accent-icon)')
    const aiSplit = page.locator('.reader-tool-split-ai')
    const translationSplit = page.locator('.reader-tool-split-translation')
    const translationIcon = page.locator('.translation-button .lucide-languages')
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

    // AI / 翻译主操作与扩展入口必须形成两套一致的 split-action，而不是四个独立图标。
    await expect(aiSplit).toBeVisible()
    await expect(translationSplit).toBeVisible()
    await expectSplitAction(aiSplit)
    await expectSplitAction(translationSplit)
    expect(Math.abs((await requiredBox(aiSplit)).width - (await requiredBox(translationSplit)).width)).toBeLessThanOrEqual(1)
    await expect(aiSplit.locator('.reader-tool-split-options')).toHaveAttribute('title', /摘要选项|Summary options/)
    await expect(translationSplit.locator('.reader-tool-split-options')).toHaveAttribute('title', /翻译目标|Translation target/)

    // 翻译恢复项目最初使用的 Lucide Languages 中英文翻译图标，并保持固定，不随 UI 语言变形。
    await expect(translationIcon).toHaveCount(1)
    await expect(page.locator('.localized-translation-icon')).toHaveCount(0)
    await expect(page.locator('.reader-translate-icon')).toHaveCount(0)

    // “下一篇”使用明确的 step-forward 语义，不再退化为普通 ChevronRight。
    await expect(page.locator('.reader-next-article-button .lucide-step-forward')).toHaveCount(1)
    await expect(page.locator('.reader-next-article-button .lucide-chevron-right')).toHaveCount(0)

    // Settings / Source Discovery 仍显示语义标题；普通阅读标题删除不影响这些特殊页面。
    await settingsButton.click()
    await expect(page.locator('.reader-title')).toContainText(/设置|Settings/)
    await page.locator('.settings-close-button').click()
    await page.locator('.source-discovery-button').click()
    await expect(page.locator('.reader-title')).toContainText(/发现来源|来源发现|Source Discovery/)
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.reader-title')).toHaveCount(0)

    // 切成英文后无需重启，翻译动作仍保持同一枚 Lucide Languages 图标。
    await settingsButton.click()
    await page.locator('.language-select').selectOption('en')
    await expect(page.locator('.reader-title')).toContainText('Settings')
    await page.locator('.settings-close-button').click()
    await expect(translationIcon).toHaveCount(1)

    // Reader 再宽也只保留图标；文字仅通过 title / aria-label 提示，避免双栏宽屏重新撑满工具栏。
    await page.setViewportSize({ width: 1800, height: 900 })
    expect((await requiredBox(readerPane)).width).toBeGreaterThan(1000)
    await expect(aiLabel).toHaveCSS('display', 'none')
    await expect(page.locator('.ai-summary-button')).toHaveAttribute('title', /AI 助手|AI assistant/i)
    await expect(page.locator('.translation-button')).toHaveAttribute('title', /翻译|Translation|Translate/i)
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

async function expectSplitAction(group: Locator): Promise<void> {
  const main = group.locator('.reader-tool-split-main')
  const options = group.locator('.reader-tool-split-options')
  const [groupBox, mainBox, optionsBox] = await Promise.all([
    requiredBox(group),
    requiredBox(main),
    requiredBox(options)
  ])
  expect(mainBox.x + mainBox.width).toBeCloseTo(optionsBox.x, 0)
  expect(groupBox.width).toBeGreaterThanOrEqual(54)
  expect(groupBox.width).toBeLessThanOrEqual(58)
  expect(mainBox.height).toBeCloseTo(optionsBox.height, 0)
}
