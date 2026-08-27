import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('two-pane layout restores a resizable Workspace + Reader while keeping three-pane state independent', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(page.locator('.app-shell')).toBeVisible()

    expect(await page.evaluate(() => window.origread.getSettings())).toMatchObject({ layoutMode: 'three-pane' })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-source-switcher-open', 'false')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-source-switcher-recent-count', '0')

    // SS-1：三栏 Source Pane 与双栏 Source Switcher 必须使用独立搜索状态。
    const threePaneSourceSearch = page.locator('.source-pane .search-field input')
    await threePaneSourceSearch.fill('three-pane-query')

    await page.locator('.settings-button').click()
    const layoutControl = page.locator('.layout-mode-segmented')
    await expect(layoutControl).toBeVisible()
    const twoPane = layoutControl.locator('[data-layout-mode="two-pane"]')
    const threePane = layoutControl.locator('[data-layout-mode="three-pane"]')
    await expect(twoPane).toHaveAttribute('aria-pressed', 'false')
    await expect(threePane).toHaveAttribute('aria-pressed', 'true')

    await twoPane.click()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).layoutMode).toBe('two-pane')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect(twoPane).toHaveAttribute('aria-pressed', 'true')

    // DL-2：切换后立即进入真正的 Workspace + Reader，不再同时挂载 Source / Article 两栏。
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.reader-pane')).toBeVisible()
    await expect(page.locator('.pane-divider-workspace')).toBeVisible()

    const initialGeometry = await page.evaluate(() => ({
      workspace: document.querySelector('.workspace-pane')!.getBoundingClientRect().width,
      reader: document.querySelector('.reader-pane')!.getBoundingClientRect().width,
      viewport: window.innerWidth
    }))
    expect(initialGeometry.workspace).toBeGreaterThanOrEqual(419)
    expect(initialGeometry.workspace).toBeLessThanOrEqual(421)
    expect(initialGeometry.reader).toBeGreaterThan(700)

    // SS-2：双栏来源切换改成锚定 Trigger 的局部 Popover，Article Pane 始终保持可见和可交互。
    const sourcePickerTrigger = page.locator('.two-pane-source-picker-button')
    const sourcePickerOverlay = page.locator('.source-switcher-popover')
    const sourcePickerSearch = sourcePickerOverlay.locator('.source-switcher-search input')
    await expect(sourcePickerTrigger).toHaveAttribute('title', /选择来源|Choose source/)
    await expect(sourcePickerTrigger).toHaveAttribute('aria-haspopup', 'listbox')
    await expect(sourcePickerTrigger).not.toContainText(/选择来源|Choose source/)
    await expect(sourcePickerTrigger.locator('.article-scope-copy strong')).toBeVisible()
    await sourcePickerTrigger.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.app-shell')).toHaveAttribute('data-source-switcher-open', 'true')
    await expect(sourcePickerOverlay).toBeVisible()
    await expect(page.locator('.source-pane.embedded-source-pane')).toHaveCount(0)
    await expect(page.locator('.two-pane-workspace-base .article-pane')).toHaveCount(1)
    await expect(page.locator('.two-pane-workspace-base')).not.toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('.two-pane-workspace-base')).not.toHaveAttribute('inert', '')
    await expect(sourcePickerTrigger).toHaveAttribute('aria-expanded', 'true')
    await expect(sourcePickerSearch).toBeFocused()
    await expect(sourcePickerSearch).toHaveValue('')
    await sourcePickerSearch.fill('switcher-query')
    await expect(sourcePickerSearch).toHaveValue('switcher-query')

    const overlayGeometry = await page.evaluate(() => {
      const workspace = document.querySelector('.workspace-pane')!.getBoundingClientRect()
      const overlay = document.querySelector('.source-switcher-popover')!.getBoundingClientRect()
      const trigger = document.querySelector('.two-pane-source-picker-button')!.getBoundingClientRect()
      const reader = document.querySelector('.reader-pane')!.getBoundingClientRect()
      return {
        workspaceLeft: workspace.left,
        workspaceRight: workspace.right,
        workspaceWidth: workspace.width,
        overlayLeft: overlay.left,
        overlayRight: overlay.right,
        overlayTop: overlay.top,
        overlayWidth: overlay.width,
        triggerBottom: trigger.bottom,
        readerLeft: reader.left
      }
    })
    expect(overlayGeometry.overlayLeft).toBeGreaterThanOrEqual(overlayGeometry.workspaceLeft + 10)
    expect(overlayGeometry.overlayRight).toBeLessThanOrEqual(overlayGeometry.workspaceRight - 10)
    expect(overlayGeometry.overlayRight).toBeLessThanOrEqual(overlayGeometry.readerLeft + 1)
    expect(overlayGeometry.overlayWidth).toBeLessThan(overlayGeometry.workspaceWidth - 20)
    expect(overlayGeometry.overlayTop).toBeGreaterThanOrEqual(overlayGeometry.triggerBottom + 4)

    // Escape 关闭 Popover 并把焦点还给来源 Trigger。
    await page.keyboard.press('Escape')
    await expect(sourcePickerOverlay).toHaveCount(0)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-source-switcher-open', 'false')
    await expect(sourcePickerTrigger).toBeFocused()
    await expect(page.locator('.two-pane-workspace-base')).not.toHaveAttribute('aria-hidden', 'true')

    // Trigger 自身可以开 / 关，不再依赖整栏 Overlay 的关闭按钮。
    await sourcePickerTrigger.click()
    await expect(sourcePickerSearch).toBeFocused()
    await sourcePickerTrigger.click()
    await expect(sourcePickerOverlay).toHaveCount(0)
    await expect(sourcePickerTrigger).toBeFocused()

    // 点击 Popover 外部会关闭；Article Workspace 本身保持挂载且没有被 inert。
    await sourcePickerTrigger.click()
    await expect(sourcePickerSearch).toBeFocused()
    await page.locator('.reader-pane').click({ position: { x: 30, y: 120 } })
    await expect(sourcePickerOverlay).toHaveCount(0)

    await sourcePickerTrigger.click()
    await sourcePickerOverlay.locator('.source-switcher-all').click()
    await expect(sourcePickerOverlay).toHaveCount(0)
    await expect(sourcePickerTrigger).toBeFocused()

    // 双栏搜索关闭时只清理 Switcher Query；三栏 Source Query 在布局往返后必须原样恢复。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.source-pane .search-field input')).toHaveValue('three-pane-query')

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await page.locator('.settings-close-button').click()
    await sourcePickerTrigger.click()
    await expect(sourcePickerSearch).toHaveValue('')
    await page.keyboard.press('Escape')

    // 离开普通阅读上下文时强制关闭 Overlay，不把焦点拉回已经不应成为当前操作目标的 Trigger。
    await sourcePickerTrigger.click()
    await page.locator('.source-discovery-button').click()
    await expect(sourcePickerOverlay).toHaveCount(0)
    await expect(page.locator('.source-discovery-page, .source-discovery-state')).toBeVisible()
    await page.locator('.settings-close-button').click()

    await sourcePickerTrigger.click()
    await page.locator('.settings-button').click()
    await expect(sourcePickerOverlay).toHaveCount(0)
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.two-pane-workspace-base .article-pane')).toBeVisible()

    // Workspace 使用独立的 workspaceWidth；键盘 End 直接走与拖拽相同的最大宽度约束并持久化。
    const workspaceDivider = page.locator('.pane-divider-workspace')
    await workspaceDivider.focus()
    await page.keyboard.press('End')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).workspaceWidth).toBe(560)
    const resizedWorkspace = await page.locator('.workspace-pane').boundingBox()
    expect(resizedWorkspace).not.toBeNull()
    expect(resizedWorkspace!.width).toBeGreaterThanOrEqual(559)
    expect(resizedWorkspace!.width).toBeLessThanOrEqual(561)

    // 收起 Workspace 不保留独立 rail；Reader 直接占满，仅留下边缘恢复按钮。
    await page.locator('.workspace-collapse-handle').click()
    await expect(page.locator('.workspace-pane')).toHaveCount(0)
    await expect(page.locator('.workspace-restore')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).workspaceCollapsed).toBe(true)
    const collapsedReader = await page.locator('.reader-pane').boundingBox()
    expect(collapsedReader).not.toBeNull()
    expect(collapsedReader!.width).toBeGreaterThan(initialGeometry.viewport * 0.98)

    await page.locator('.workspace-restore').click()
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).workspaceCollapsed).toBe(false)

    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    expect(await page.evaluate(() => window.origread.getSettings())).toMatchObject({
      layoutMode: 'two-pane',
      workspaceWidth: 560,
      workspaceCollapsed: false,
      sourcePaneWidth: 260,
      articlePaneWidth: 380
    })
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)

    await page.locator('.settings-button').click()
    const reloadedThreePane = page.locator('.layout-mode-option[data-layout-mode="three-pane"]')
    await reloadedThreePane.focus()
    await page.keyboard.press('Space')
    await expect.poll(async () => (await page.evaluate(() => window.origread.getSettings())).layoutMode).toBe('three-pane')
    await expect(reloadedThreePane).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.workspace-pane')).toHaveCount(0)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    expect(await page.evaluate(() => window.origread.getSettings())).toMatchObject({
      workspaceWidth: 560,
      sourcePaneWidth: 260,
      articlePaneWidth: 380
    })
  } finally {
    await testApp.close()
  }
})
