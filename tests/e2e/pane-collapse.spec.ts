import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('source and article panes collapse independently while focus reading stays temporary', async () => {
  const testApp = await launchIsolatedOrigRead()
  const backupPath = join(process.cwd(), 'test-results', `pane-collapse-${Date.now()}.json`)

  try {
    const page = await testApp.app.firstWindow()
    const sourcePane = page.locator('.source-pane')
    const articlePane = page.locator('.article-pane')
    const sourceDivider = page.locator('.pane-divider-source')
    const articleDivider = page.locator('.pane-divider-article')
    const sourceToggle = sourceDivider.locator('.collapse-handle')
    const articleToggle = articleDivider.locator('.collapse-handle')
    const restoreToggle = page.locator('.collapsed-pane-restore')

    await expect(page.locator('.app-shell')).toBeVisible()
    await expectManualPaneState(page, false, false)
    await expect(sourcePane).toBeVisible()
    await expect(articlePane).toBeVisible()

    // 组合 1 -> 组合 2：只收 Source，Article/Reader 保持。
    await sourceToggle.click()
    await expect(sourcePane).toHaveCount(0)
    await expect(articlePane).toBeVisible()
    await expect(sourceDivider).toHaveAttribute('data-collapsed', 'true')
    await expect(articleDivider).toHaveAttribute('data-collapsed', 'false')
    await expectManualPaneState(page, true, false)
    await expect(sourceToggle).toHaveCount(0)
    await expect(restoreToggle).toHaveCount(1)
    await expect(restoreToggle).toHaveAttribute('data-hidden-count', '1')
    expect(await sourceDivider.evaluate((element) => element.getBoundingClientRect().width)).toBe(0)

    // 单一恢复按钮恢复 Source，不额外保留一条 collapsed rail。
    await restoreToggle.click()
    await expect(sourcePane).toBeVisible()
    await expect(articlePane).toBeVisible()
    await expect(restoreToggle).toHaveCount(0)
    await expectManualPaneState(page, false, false)

    // 组合 1 -> 组合 3：只收 Article。
    await articleToggle.click()
    await expect(sourcePane).toBeVisible()
    await expect(articlePane).toHaveCount(0)
    await expect(sourceDivider).toHaveAttribute('data-collapsed', 'false')
    await expect(articleDivider).toHaveAttribute('data-collapsed', 'true')
    await expectManualPaneState(page, false, true)
    const sourceHandleBox = await sourceToggle.boundingBox()
    const restoreHandleBox = await restoreToggle.boundingBox()
    expect(sourceHandleBox).not.toBeNull()
    expect(restoreHandleBox).not.toBeNull()
    await expect(articleToggle).toHaveCount(0)
    await expect(restoreToggle).toHaveAttribute('data-hidden-count', '1')
    expect(await articleDivider.evaluate((element) => element.getBoundingClientRect().width)).toBe(0)
    // Source 仍可继续独立收起；Article 的恢复入口与它共用边界但不重叠，也不再占一列。
    expect(sourceHandleBox!.x + sourceHandleBox!.width).toBeLessThanOrEqual(restoreHandleBox!.x + 0.5)

    // Focus 只做临时覆盖：进入时两个 Pane 都不可见，但手动状态仍是 Source 展开 / Article 收起。
    await page.locator('.focus-reading-button').click()
    await expect(page.locator('.app-shell')).toHaveClass(/focus-reading/)
    await expect(sourcePane).toHaveCount(0)
    await expect(articlePane).toHaveCount(0)
    await expect(sourceDivider).toHaveAttribute('data-collapsed', 'true')
    await expect(articleDivider).toHaveAttribute('data-collapsed', 'true')
    await expectManualPaneState(page, false, true)
    await expect(restoreToggle).toHaveAttribute('data-hidden-count', '2')

    // 退出 Focus 必须恢复进入前的手动组合，而不是强制恢复双展开。
    await page.locator('.focus-reading-button').click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(sourcePane).toBeVisible()
    await expect(articlePane).toHaveCount(0)
    await expectManualPaneState(page, false, true)

    // 恢复 Article 后，再分别收起两栏，形成组合 4；隐藏两栏时只保留一个“<<”恢复按钮。
    await restoreToggle.click()
    await sourceToggle.click()
    await articleToggle.click()
    await expect(sourcePane).toHaveCount(0)
    await expect(articlePane).toHaveCount(0)
    await expect(sourceDivider).toHaveAttribute('data-collapsed', 'true')
    await expect(articleDivider).toHaveAttribute('data-collapsed', 'true')
    await expect(sourceToggle).toHaveCount(0)
    await expect(articleToggle).toHaveCount(0)
    await expect(restoreToggle).toHaveCount(1)
    await expect(restoreToggle).toHaveAttribute('data-hidden-count', '2')
    await expect(restoreToggle.locator('svg')).toHaveCount(2)
    await expectManualPaneState(page, true, true)
    const readerBox = await page.locator('.reader-pane').boundingBox()
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(readerBox).not.toBeNull()
    expect(readerBox!.width).toBeGreaterThan(viewportWidth * 0.98)

    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    const darkRestoreBackground = await restoreToggle.evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(darkRestoreBackground).not.toBe('rgb(255, 255, 255)')
    await page.emulateMedia({ colorScheme: 'light' })

    // 手动折叠必须持久化；reload 后仍是双收起，但只有一个统一恢复入口。
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toHaveCount(0)
    await expect(page.locator('.pane-divider-source .collapse-handle')).toHaveCount(0)
    await expect(page.locator('.pane-divider-article .collapse-handle')).toHaveCount(0)
    await expect(page.locator('.collapsed-pane-restore')).toHaveAttribute('data-hidden-count', '2')
    await expectManualPaneState(page, true, true)

    // “<<”每次只恢复一层：先恢复更靠近 Reader 的 Article，再以“<”恢复 Source。
    await page.locator('.collapsed-pane-restore').click()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect(page.locator('.collapsed-pane-restore')).toHaveAttribute('data-hidden-count', '1')
    await expectManualPaneState(page, true, false)
    await page.locator('.collapsed-pane-restore').click()
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expectManualPaneState(page, false, false)

    // '[' 正式定义为 Focus Reading toggle，并且绝不污染持久化手动状态。
    await page.keyboard.press('[')
    await expect(page.locator('.app-shell')).toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toHaveCount(0)
    await expectManualPaneState(page, false, false)
    await page.keyboard.press('[')
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expectManualPaneState(page, false, false)

    // Focus 中统一“<<”恢复按钮先退出 Focus；手动偏好仍保持原值。
    await page.keyboard.press('[')
    await expect(page.locator('.collapsed-pane-restore')).toHaveAttribute('data-hidden-count', '2')
    await page.locator('.collapsed-pane-restore').click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expectManualPaneState(page, false, false)

    // 配置恢复必须走真实 Settings UI / Backup service / onConfigurationRestored 链，当前页面无需 reload 即刷新 Pane。
    await testApp.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, backupPath)

    // 先进入临时 Focus；恢复成功后 handleConfigurationRestored 还必须主动退出这个临时覆盖。
    await page.keyboard.press('[')
    await expect(page.locator('.app-shell')).toHaveClass(/focus-reading/)
    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.getByRole('button', { name: '备份与恢复' }).click()
    await page.getByRole('button', { name: /导出完整配置/ }).click()
    await expect.poll(async () => {
      try {
        return (await readFile(backupPath, 'utf8')).length > 0
      } catch {
        return false
      }
    }).toBe(true)

    const backup = JSON.parse(await readFile(backupPath, 'utf8')) as { preferences: Record<string, unknown> }
    backup.preferences['origread.desktop.sourcePaneCollapsed'] = true
    backup.preferences['origread.desktop.articlePaneCollapsed'] = false
    await writeFile(backupPath, JSON.stringify(backup, null, 2), 'utf8')

    await page.getByRole('button', { name: /恢复配置/ }).click()
    await expectManualPaneState(page, true, false)
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toBeVisible()
  } finally {
    await testApp.close()
    await rm(backupPath, { force: true }).catch(() => undefined)
  }
})

async function expectManualPaneState(page: Page, sourcePaneCollapsed: boolean, articlePaneCollapsed: boolean): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const settings = await window.origread.getSettings()
    return {
      sourcePaneCollapsed: settings.sourcePaneCollapsed,
      articlePaneCollapsed: settings.articlePaneCollapsed
    }
  })).toEqual({ sourcePaneCollapsed, articlePaneCollapsed })
}
