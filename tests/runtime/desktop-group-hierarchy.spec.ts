import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import type { OrigReadDesktopApi } from '../../src/shared/contracts'

interface DesktopSession {
  readonly app: ElectronApplication
  readonly page: Page
  readonly pageErrors: string[]
}

const test = base.extend<{ userDataDir: string; tempDir: string }>({
  userDataDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const userDataDir = await mkdtemp(join(resultsRoot, 'desktop-group-hierarchy-'))
    try {
      await use(userDataDir)
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  },
  tempDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const dir = await mkdtemp(join(resultsRoot, 'desktop-hierarchy-temp-'))
    try {
      await use(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function withDesktop<T>(userDataDir: string, inspect: (session: DesktopSession) => Promise<T>): Promise<T> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const app = await _electron.launch({
    args: [process.cwd()],
    cwd: process.cwd(),
    env: {
      ...inheritedEnv,
      ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1',
      ORIGREAD_DISABLE_PERIODIC_SYNC: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await expect(page.locator('.app-shell')).toBeVisible()
    return await inspect({ app, page, pageErrors })
  } finally {
    await app.close()
  }
}

function createFeedXml(feedTitle: string, itemGuid: string, itemTitle: string): string {
  const pubDate = new Date().toUTCString()
  return `<rss version="2.0">
    <channel>
      <title>${feedTitle}</title>
      <link>https://fixture.invalid</link>
      <description>Fixture feed for group hierarchy test</description>
      <item>
        <guid>${itemGuid}</guid>
        <title>${itemTitle}</title>
        <link>https://fixture.invalid/${itemGuid}</link>
        <pubDate>${pubDate}</pubDate>
        <description>${itemTitle} description</description>
      </item>
    </channel>
  </rss>`
}

test('层级分组桌面专项验收：UI新建子组/重命名/移动父目录、作用域汇聚、子树定向刷新、重启持久化与OPML层级往返', async ({
  userDataDir,
  tempDir
}) => {
  test.setTimeout(120_000)

  let parentHits = 0
  let childHits = 0
  let otherHits = 0

  const server: Server = createServer((req, res) => {
    if (req.url === '/parent-feed.xml') {
      parentHits++
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
      res.end(createFeedXml('Parent Feed', 'guid-parent-1', 'Parent Direct Article'))
    } else if (req.url === '/child-feed.xml') {
      childHits++
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
      res.end(createFeedXml('Child Feed', 'guid-child-1', 'Child Subgroup Article'))
    } else if (req.url === '/other-feed.xml') {
      otherHits++
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
      res.end(createFeedXml('Other Feed', 'guid-other-1', 'Other Group Article'))
    } else {
      res.writeHead(404).end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const parentUrl = `http://127.0.0.1:${address.port}/parent-feed.xml`
  const childUrl = `http://127.0.0.1:${address.port}/child-feed.xml`
  const otherUrl = `http://127.0.0.1:${address.port}/other-feed.xml`

  const exportedOpmlPath = join(tempDir, 'desktop-hierarchy-export.opml')
  let childGroupId = ''
  let otherGroupId = ''

  try {
    // 阶段一：建源建组、UI 新建子组、UI 重命名、作用域范围验证、子树定向刷新、UI 移动父目录、OPML 导出
    await withDesktop(userDataDir, async ({ app, page, pageErrors }) => {
      // 1. IPC 种子创建根级 Parent 分组与独立 Other 分组，并添加 3 条本地 RSS 来源
      const seedResult = await page.evaluate(
        async ({ parentUrl, childUrl, otherUrl }) => {
          const api: OrigReadDesktopApi = window.origread
          for (const feed of await api.listFeeds()) await api.deleteFeed(feed.id)
          const groupsAfterParent = await api.addGroup('Parent')
          const parent = groupsAfterParent.find((g) => g.name === 'Parent')!
          const groupsAfterOther = await api.addGroup('Other')
          const other = groupsAfterOther.find((g) => g.name === 'Other')!

          const feedParent = await api.addRssSource(parentUrl)
          const feedChild = await api.addRssSource(childUrl)
          const feedOther = await api.addRssSource(otherUrl)

          return {
            parentGroupId: parent.id,
            otherGroupId: other.id,
            parentFeedId: feedParent.feedId,
            childFeedId: feedChild.feedId,
            otherFeedId: feedOther.feedId
          }
        },
        { parentUrl, childUrl, otherUrl }
      )

      const { parentGroupId, parentFeedId, childFeedId, otherFeedId } = seedResult
      otherGroupId = seedResult.otherGroupId

      // 重新载入以更新 UI 树状视图
      await page.reload()
      await expect(page.locator('.app-shell')).toBeVisible()

      // 2. UI 交互：打开 Parent 分组操作菜单，新建子分组 Child
      const parentMenuBtn = page.locator(
        `.source-group-section[data-group-id="${parentGroupId}"] > .source-group-header .source-group-menu-button`
      )
      await parentMenuBtn.scrollIntoViewIfNeeded()
      await parentMenuBtn.click({ force: true })

      const contextMenu = page.locator('.desktop-context-menu')
      await expect(contextMenu).toBeVisible()
      await contextMenu
        .locator('[role="menuitem"]')
        .filter({ hasText: /新建子分组|New sub-group/i })
        .click()

      // 填写新建子分组对话框
      const createDialog = page.locator('.create-subgroup-dialog')
      await expect(createDialog).toBeVisible()
      await createDialog.locator('input:not([readonly])').fill('Child')
      await createDialog.locator('button.dialog-submit').click()
      await expect(createDialog).toBeHidden()

      // 通过 listGroups 确认 Child 分组已创建且 parentId 为 parentGroupId
      const groupsAfterCreate = await page.evaluate(async () => window.origread.listGroups())
      const childGroupRecord = groupsAfterCreate.find((g) => g.name === 'Child')
      expect(childGroupRecord).toBeDefined()
      expect(childGroupRecord?.parentId).toBe(parentGroupId)
      childGroupId = childGroupRecord!.id

      // 3. UI 交互：重命名 Parent 分组为 "Parent Renamed"
      await parentMenuBtn.click({ force: true })
      await expect(contextMenu).toBeVisible()
      await contextMenu
        .locator('[role="menuitem"]')
        .filter({ hasText: /重命名分组|Rename group/i })
        .click()

      const renameDialog = page.locator('.group-rename-dialog')
      await expect(renameDialog).toBeVisible()
      await renameDialog.locator('input').fill('Parent Renamed')
      await renameDialog.locator('button.dialog-submit').click()
      await expect(renameDialog).toBeHidden()

      // 验证侧栏分组名称更新
      await expect(
        page.locator(`.source-group-section[data-group-id="${parentGroupId}"] > .source-group-header .source-group-name strong`)
      ).toHaveText('Parent Renamed')

      // 4. Setup：将来源分别归入 Parent、Child 与 Other
      await page.evaluate(
        async ({ parentFeedId, childFeedId, otherFeedId, parentGroupId, childGroupId, otherGroupId }) => {
          const api: OrigReadDesktopApi = window.origread
          await api.updateFeedSettings(parentFeedId, { groupId: parentGroupId })
          await api.updateFeedSettings(childFeedId, { groupId: childGroupId })
          await api.updateFeedSettings(otherFeedId, { groupId: otherGroupId })
        },
        { parentFeedId, childFeedId, otherFeedId, parentGroupId, childGroupId, otherGroupId }
      )

      await page.reload()
      await expect(page.locator('.app-shell')).toBeVisible()

      // 5. 点击父分组：文章列表必须包含父直属文章 + Child 子分组文章，排除 Other
      const parentScopeButton = page.locator(`.source-group-section[data-group-id="${parentGroupId}"] > .source-group-header .source-group-scope`)
      await parentScopeButton.click()

      await expect(page.locator('.article-item', { hasText: 'Parent Direct Article' })).toBeVisible()
      await expect(page.locator('.article-item', { hasText: 'Child Subgroup Article' })).toBeVisible()
      await expect(page.locator('.article-item', { hasText: 'Other Group Article' })).toBeHidden()
      await expect(page.locator('.article-item')).toHaveCount(2)

      // 6. 刷新父分组：父来源和 Child 来源各请求 +1，Other 来源不增加
      const baselineParentHits = parentHits
      const baselineChildHits = childHits
      const baselineOtherHits = otherHits

      await page.locator('.refresh-all-button').click()

      await expect.poll(() => parentHits).toBe(baselineParentHits + 1)
      await expect.poll(() => childHits).toBe(baselineChildHits + 1)
      expect(otherHits).toBe(baselineOtherHits)

      // 7. UI 交互：移动 Child 子分组到 Other 分组
      const childMenuBtn = page.locator(
        `.source-group-section[data-group-id="${childGroupId}"] > .source-group-header .source-group-menu-button`
      )
      await childMenuBtn.scrollIntoViewIfNeeded()
      await childMenuBtn.click({ force: true })

      await expect(contextMenu).toBeVisible()
      await contextMenu
        .locator('[role="menuitem"]')
        .filter({ hasText: /移动分组|Move group/i })
        .click()

      const moveDialog = page.locator('.move-group-dialog')
      await expect(moveDialog).toBeVisible()
      await moveDialog.locator('select').selectOption(otherGroupId)
      await moveDialog.locator('button.dialog-submit').click()
      await expect(moveDialog).toBeHidden()

      // 8. 验证移动后父分组 scope 不再包含 Child 的文章，Child 的 ID 保持不变
      await parentScopeButton.click()
      await expect(page.locator('.article-item', { hasText: 'Parent Direct Article' })).toBeVisible()
      await expect(page.locator('.article-item', { hasText: 'Child Subgroup Article' })).toBeHidden()
      await expect(page.locator('.article-item')).toHaveCount(1)

      const groupsAfterMove = await page.evaluate(async () => window.origread.listGroups())
      const movedChild = groupsAfterMove.find((g) => g.id === childGroupId)
      expect(movedChild).toBeDefined()
      expect(movedChild?.id).toBe(childGroupId)
      expect(movedChild?.parentId).toBe(otherGroupId)

      // 9. 真实 IPC 往返：mock showSaveDialog 并导出 OPML
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath
        })
      }, exportedOpmlPath)

      const exportResult = await page.evaluate(async () => window.origread.exportOpml(true))
      expect(exportResult.ok).toBe(true)
      expect(exportResult.path).toBe(exportedOpmlPath)

      const exportedXml = await readFile(exportedOpmlPath, 'utf8')
      expect(exportedXml).toContain('Parent Renamed')
      expect(exportedXml).toContain('Other')
      expect(exportedXml).toContain('Child')

      expect(pageErrors).toEqual([])
    })

    // 阶段二：真实重启应用，验证移动后的 parentId 严格持久化保留
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      const groupsOnRestart = await page.evaluate(async () => window.origread.listGroups())
      const restartedChild = groupsOnRestart.find((g) => g.id === childGroupId)
      expect(restartedChild).toBeDefined()
      expect(restartedChild?.id).toBe(childGroupId)
      expect(restartedChild?.parentId).toBe(otherGroupId)
      expect(pageErrors).toEqual([])
    })

    // 阶段三：在干净隔离的全新 profile 中，通过 IPC mock showOpenDialog 导入 OPML，验证层级完全还原
    const resultsRoot = join(process.cwd(), 'test-results')
    const userDataDirImport = await mkdtemp(join(resultsRoot, 'desktop-hierarchy-import-'))
    try {
      await withDesktop(userDataDirImport, async ({ app, page, pageErrors }) => {
        await app.evaluate(({ dialog }, filePath) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [filePath]
          })
        }, exportedOpmlPath)

        const importResult = await page.evaluate(async () => {
          for (const feed of await window.origread.listFeeds()) await window.origread.deleteFeed(feed.id)
          return window.origread.importOpml()
        })
        expect(importResult.ok).toBe(true)

        const importedGroups = await page.evaluate(async () => window.origread.listGroups())
        const importedOther = importedGroups.find((g) => g.name === 'Other')
        const importedChild = importedGroups.find((g) => g.name === 'Child')
        expect(importedOther).toBeDefined()
        expect(importedChild).toBeDefined()
        expect(importedChild?.parentId).toBe(importedOther?.id)

        expect(pageErrors).toEqual([])
      })
    } finally {
      await rm(userDataDirImport, { recursive: true, force: true })
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})


test('sidebar blank menu creates root groups and opens add-source; default rename survives restart', async ({ userDataDir }) => {
  let defaultGroupId = ''
  let sourceGroups: Array<{ id: string; groupId: string }> = []
  await withDesktop(userDataDir, async ({ page, pageErrors }) => {
    const seed = await page.evaluate(async () => {
      await window.origread.updateSettings({ language: 'en', layoutMode: 'three-pane' })
      return {
        defaultGroup: (await window.origread.listGroups()).find(group => group.isDefault)!,
        sourceGroups: (await window.origread.listFeeds()).map(({ id, groupId }) => ({ id, groupId }))
      }
    })
    defaultGroupId = seed.defaultGroup.id
    sourceGroups = seed.sourceGroups
    await page.reload()
    const sidebar = page.locator('.source-pane').first()
    const openBlankMenu = async () => {
      const box = await sidebar.boundingBox()
      if (!box) throw new Error('Sidebar is not visible')
      await page.mouse.click(box.x + box.width - 3, box.y + box.height - 25, { button: 'right' })
      await expect(page.locator('.desktop-context-menu')).toBeVisible()
      await expect(page.locator('.desktop-context-menu [role="menuitem"]')).toHaveCount(2)
    }
    await openBlankMenu()
    await page.getByRole('menuitem', { name: 'Add group', exact: true }).click()
    const createDialog = page.getByRole('dialog')
    await createDialog.getByRole('textbox').fill('Sidebar Group')
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(createDialog).toBeHidden()
    await expect(sidebar.locator('.source-group-name strong').filter({ hasText: 'Sidebar Group' })).toBeVisible()
    const rootGroup = await page.evaluate(async () => (await window.origread.listGroups()).find(group => group.name === 'Sidebar Group'))
    expect(rootGroup?.parentId ?? null).toBeNull()

    const defaultHeader = sidebar.locator('.source-group-section').filter({ has: page.locator(`.source-group-header button[title="${seed.defaultGroup.name}"]`) }).first().locator('.source-group-header').first()
    await defaultHeader.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click()
    const renameDialog = page.getByRole('dialog')
    await renameDialog.getByRole('textbox').fill('Personal Sources')
    await renameDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(renameDialog).toBeHidden()
    await expect(sidebar.locator('.source-group-name strong').filter({ hasText: 'Personal Sources' })).toBeVisible()

    await openBlankMenu()
    await page.getByRole('menuitem', { name: 'Add source', exact: true }).click()
    await expect(page.locator('[aria-labelledby="add-source-title"]')).toBeVisible()
    expect(pageErrors).toEqual([])
  })
  await withDesktop(userDataDir, async ({ page, pageErrors }) => {
    const state = await page.evaluate(async () => ({
      group: (await window.origread.listGroups()).find(group => group.isDefault),
      sourceGroups: (await window.origread.listFeeds()).map(({ id, groupId }) => ({ id, groupId }))
    }))
    expect(state.group).toMatchObject({ id: defaultGroupId, name: 'Personal Sources', isDefault: true })
    expect(state.sourceGroups).toEqual(sourceGroups)
    expect(pageErrors).toEqual([])
  })
})
