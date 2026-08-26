import { createServer, type Server } from 'node:http'
import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('add-source dialog discovers, ranks, subscribes and refreshes through the unified source flow', async () => {
  test.setTimeout(45_000)
  const fixture = await startFeedServer()
  const { server } = fixture
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const feedUrl = `${baseUrl}/feed.xml`
  const testApp = await launchIsolatedOrigRead()
  const electronApp = testApp.app

  try {
    const page = await electronApp.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await expect(page.locator('.source-dialog')).toBeVisible()
    await page.locator('.dialog-field input').fill(feedUrl)
    await page.locator('.dialog-submit').click()

    const candidate = page.locator('.source-candidate').first()
    await expect(candidate).toBeVisible({ timeout: 15_000 })
    await expect(candidate.locator('.candidate-kind')).toContainText('RSS')
    await expect(candidate.locator('.candidate-main strong')).toHaveText('OrigRead E2E Feed')
    await expect(candidate.locator('.candidate-stats')).toContainText(/30/)

    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    await expect.poll(async () => {
      const feeds = await page.evaluate(() => window.origread.listFeeds())
      return feeds.some((feed) => feed.url === feedUrl && feed.name === 'OrigRead E2E Feed')
    }).toBe(true)

    const articleList = page.locator('.article-list')
    await expect(articleList).toBeVisible()
    const listMetrics = await articleList.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))
    expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight)
    await articleList.evaluate((element) => { element.scrollTop = 240 })
    await expect.poll(() => articleList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await articleList.evaluate((element) => { element.scrollTop = 0 })

    const currentFixture = await page.evaluate(async (targetFeedUrl) => {
      const feeds = await window.origread.listFeeds()
      const feed = feeds.find((item) => item.url === targetFeedUrl)
      if (!feed) return null
      const articles = await window.origread.listArticles(1_000)
      const article = articles.find((item) => item.feedId === feed.id && item.title === 'OrigRead E2E Article 1')
      return article ? { feedId: feed.id, articleId: article.id } : null
    }, feedUrl)
    expect(currentFixture).not.toBeNull()

    await expect(page.locator('.source-scope-picker')).toBeVisible()
    await page.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' }).locator('.source-settings-button').click()
    const sourceSettings = page.locator('.source-settings-dialog')
    await expect(sourceSettings).toBeVisible()
    await expect(sourceSettings.locator('.source-type-badge')).toHaveText('RSS / Atom')
    await expect(sourceSettings.locator('.source-settings-tabs button')).toHaveCount(3)
    await expect(sourceSettings.getByRole('button', { name: '阅读' })).toHaveCount(0)
    await expect(sourceSettings.getByPlaceholder('新分组名称')).toHaveCount(0)
    await sourceSettings.getByRole('button', { name: '新建分组' }).click()
    await expect(sourceSettings.getByPlaceholder('新分组名称')).toBeVisible()
    await expect(sourceSettings.getByText('尝试抓取原网页全文', { exact: true })).toHaveCount(0)
    await sourceSettings.getByRole('button', { name: '过滤' }).click()
    await expect(sourceSettings).toContainText('在文章保存前按标题关键词或正则过滤当前来源。')
    await sourceSettings.getByRole('button', { name: '维护' }).click()
    await expect(sourceSettings).toContainText('重新获取图标')
    await sourceSettings.locator('.dialog-close').click()
    await expect(sourceSettings).toBeHidden()
    await expect(page.locator('.article-list')).toBeVisible()

    const sourceRow = page.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' })
    await sourceRow.click({ button: 'right' })
    const sourceContextMenu = page.locator('.desktop-context-menu')
    await expect(sourceContextMenu).toBeVisible()
    await expect(sourceContextMenu).toContainText('重新加载文章')
    await expect(sourceContextMenu).toContainText('来源设置')
    await expect(sourceContextMenu).toContainText('移动到分组')
    await expect(sourceContextMenu).toContainText('删除来源')
    await page.locator('.article-scope-bar').click()
    await expect(sourceContextMenu).toBeHidden()

    const article = page.locator(`.article-item[data-article-id="${currentFixture!.articleId}"]`)
    await expect(article).toBeVisible()
    await article.focus()
    await expect(article).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(page.locator('.original-button')).toBeEnabled()
    await expect(page.locator('.full-content-button')).toBeEnabled()
    await page.locator('.full-content-button').click()
    await expect(page.locator('.article-body')).toContainText('OrigRead extracted full text article 1', { timeout: 15_000 })
    await expect(page.locator('.full-content-button')).toBeEnabled()
    await expect(page.locator('.full-content-button')).toHaveClass(/active/)
    const readerContent = page.locator('.reader-content')
    const readerMetrics = await readerContent.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }))
    expect(readerMetrics.scrollHeight).toBeGreaterThan(readerMetrics.clientHeight)
    await readerContent.evaluate((element) => { element.scrollTop = 300 })
    await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await readerContent.evaluate((element) => { element.scrollTop = 0 })
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const arrowDownScrollTop = await readerContent.evaluate((element) => element.scrollTop)
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBeLessThan(arrowDownScrollTop)
    const articleImage = page.locator('.article-body img').first()
    await expect(articleImage).toBeVisible()
    await expect(articleImage).toHaveAttribute('src', `${baseUrl}/image/1.png`)
    await expect.poll(() => articleImage.evaluate((element) => {
      const image = element as HTMLImageElement
      return image.complete ? image.naturalWidth : 0
    })).toBeGreaterThan(0)

    await page.keyboard.press('Control+f')
    await expect(page.locator('.reader-search-bar')).toBeVisible()
    await page.locator('.reader-search-bar input').fill('OrigRead')
    await expect.poll(() => page.locator('mark.reader-search-match').count()).toBeGreaterThan(0)
    await expect(page.locator('mark.reader-search-match.current')).toHaveCount(1)
    await page.locator('.reader-search-bar input').press('Enter')
    await expect(page.locator('mark.reader-search-match.current')).toHaveCount(1)
    await page.locator('.reader-search-bar input').press('Escape')
    await expect(page.locator('.reader-search-bar')).toBeHidden()

    await page.keyboard.press('Control+Shift+f')
    await expect(page.locator('.global-search-dialog')).toBeVisible()
    await expect(page.locator('.global-search-input-shell kbd')).toContainText('Ctrl')
    await page.locator('.global-search-input-shell input').fill('OrigRead extracted full text article 1')
    await expect(page.locator('.global-search-result').first()).toBeVisible()
    await expect(page.locator('.global-search-result').first()).toContainText('正文命中')
    await page.locator('.global-search-result').first().click()
    await expect(page.locator('.global-search-dialog')).toBeHidden()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    const shortcutArticle = page.locator('.article-item').nth(10)
    await shortcutArticle.click()
    const shortcutArticleId = await shortcutArticle.getAttribute('data-article-id')
    expect(shortcutArticleId).not.toBeNull()
    await page.keyboard.press('j')
    await expect.poll(() => page.locator('.article-item.selected').getAttribute('data-article-id')).not.toBe(shortcutArticleId)
    await page.keyboard.press('k')
    await expect.poll(() => page.locator('.article-item.selected').getAttribute('data-article-id')).toBe(shortcutArticleId)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.locator('.article-item.selected').getAttribute('data-article-id')).not.toBe(shortcutArticleId)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => page.locator('.article-item.selected').getAttribute('data-article-id')).toBe(shortcutArticleId)

    await expect(page.locator('.article-item.selected')).not.toHaveClass(/unread/)
    await page.keyboard.press('m')
    await expect(page.locator('.article-item.selected')).toHaveClass(/unread/)
    await page.keyboard.press('m')
    await expect(page.locator('.article-item.selected')).not.toHaveClass(/unread/)

    const selectedStar = page.locator('.article-item.selected .star-button')
    const initiallyStarred = await selectedStar.evaluate((element) => element.classList.contains('active'))
    await expect(selectedStar).toHaveAttribute('aria-label', initiallyStarred ? '取消星标' : '添加星标')
    await page.keyboard.press('s')
    await expect.poll(() => selectedStar.evaluate((element) => element.classList.contains('active'))).toBe(!initiallyStarred)
    await expect(selectedStar).toHaveAttribute('aria-label', initiallyStarred ? '添加星标' : '取消星标')
    await page.keyboard.press('s')
    await expect.poll(() => selectedStar.evaluate((element) => element.classList.contains('active'))).toBe(initiallyStarred)
    await expect(selectedStar).toHaveAttribute('aria-label', initiallyStarred ? '取消星标' : '添加星标')

    await page.keyboard.press('[')
    await expect(page.locator('.app-shell')).toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toHaveCount(0)
    await page.keyboard.press('[')
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()

    await article.click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    const fullContentButton = page.locator('.full-content-button')
    if (await fullContentButton.evaluate((element) => element.classList.contains('active'))) {
      await fullContentButton.click()
    }
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(fullContentButton).not.toHaveClass(/active/)
    await fullContentButton.click()
    await expect(page.locator('.article-body')).toContainText('OrigRead extracted full text article 1', { timeout: 15_000 })
    await expect(fullContentButton).toHaveClass(/active/)
    await fullContentButton.click()
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(fullContentButton).not.toHaveClass(/active/)

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.locator('.theme-select').selectOption('dark')
    await page.locator('.reader-background-option.bg-warm').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.locator('.settings-close-button').click()
    await expect.poll(() => page.locator('.reader-content').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(37, 34, 29)')
    const darkToolbarBackground = await page.locator('.reader-toolbar').evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(darkToolbarBackground).not.toBe('rgb(255, 255, 255)')

    const originalViewMatchesReaderStage = async (): Promise<boolean> => {
      const stage = await page.locator('.reader-stage').boundingBox()
      const viewBounds = await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const child = window?.contentView.children.at(-1)
        return child?.getBounds() ?? null
      })
      if (!stage || !viewBounds) return false
      return (
        Math.abs(viewBounds.x - Math.round(stage.x)) <= 1 &&
        Math.abs(viewBounds.y - Math.round(stage.y)) <= 1 &&
        Math.abs(viewBounds.width - Math.round(stage.width)) <= 1 &&
        Math.abs(viewBounds.height - Math.round(stage.height)) <= 1
      )
    }

    const articleRequestsBeforeOriginal = fixture.articleRequests()
    await page.locator('.original-button').click()
    await expect.poll(() => fixture.articleRequests()).toBeGreaterThan(articleRequestsBeforeOriginal)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
    await expect(page.locator('.reader-title')).toBeVisible()
    await expect(page.locator('.reader-title')).not.toHaveText(/^(阅读|Reader)$/)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await expect.poll(() => page.locator('.reader-toolbar').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(darkToolbarBackground)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)

    // DL-5：原文 child WebContentsView 在 Settings 内切布局时保持打开；设置页期间仅隐藏 bounds，关闭后按新布局恢复。
    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
    await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1
    )).toBe(0)
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.workspace-pane')).toBeVisible()
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    // UI-3P.6：原文 WebContentsView 必须跟随 Article Divider 改变 Reader stage bounds。
    const readerStageBeforeResize = await page.locator('.reader-stage').boundingBox()
    if (!readerStageBeforeResize) throw new Error('Reader stage is not visible before divider resize')
    const articleDividerBox = await page.locator('.pane-divider-article').boundingBox()
    if (!articleDividerBox) throw new Error('Article divider is not visible')
    const dividerX = articleDividerBox.x + articleDividerBox.width / 2
    const dividerY = articleDividerBox.y + Math.min(80, articleDividerBox.height / 4)
    await page.mouse.move(dividerX, dividerY)
    await page.mouse.down()
    await page.mouse.move(dividerX + 40, dividerY, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).articlePaneWidth)).toBe(420)
    await expect.poll(async () => {
      const stage = await page.locator('.reader-stage').boundingBox()
      const viewBounds = await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const child = window?.contentView.children.at(-1)
        return child?.getBounds() ?? null
      })
      if (!stage || !viewBounds) return false
      return (
        stage.width < readerStageBeforeResize.width - 30 &&
        Math.abs(viewBounds.x - Math.round(stage.x)) <= 1 &&
        Math.abs(viewBounds.y - Math.round(stage.y)) <= 1 &&
        Math.abs(viewBounds.width - Math.round(stage.width)) <= 1 &&
        Math.abs(viewBounds.height - Math.round(stage.height)) <= 1
      )
    }).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    // UI-3P.7：独立 collapse / Focus 同样必须让原文 child WebContentsView 跟随 Reader stage，而不是残留旧 bounds。
    await page.locator('.pane-divider-source .collapse-handle').click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).sourcePaneCollapsed)).toBe(true)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    await page.locator('.pane-divider-article .collapse-handle').click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).articlePaneCollapsed)).toBe(true)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    // 两栏全收起后只保留统一“<<”入口；逐层恢复后再验证 Focus 不写入手动偏好。
    await expect(page.locator('.collapsed-pane-restore')).toHaveAttribute('data-hidden-count', '2')
    await page.locator('.collapsed-pane-restore').click()
    await expect(page.locator('.collapsed-pane-restore')).toHaveAttribute('data-hidden-count', '1')
    await page.locator('.collapsed-pane-restore').click()
    await expect.poll(async () => page.evaluate(async () => {
      const current = await window.origread.getSettings()
      return [current.sourcePaneCollapsed, current.articlePaneCollapsed]
    })).toEqual([false, false])
    await expect.poll(originalViewMatchesReaderStage).toBe(true)

    await page.locator('.focus-reading-button').click()
    await expect(page.locator('.app-shell')).toHaveClass(/focus-reading/)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(async () => page.evaluate(async () => {
      const current = await window.origread.getSettings()
      return [current.sourcePaneCollapsed, current.articlePaneCollapsed]
    })).toEqual([false, false])
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    await page.locator('.focus-reading-button').click()
    await expect(page.locator('.app-shell')).not.toHaveClass(/focus-reading/)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect.poll(originalViewMatchesReaderStage).toBe(true)

    // UI-3P.8：adaptive hidden / compact resize 也必须驱动原文 child WebContentsView 实时跟随 Reader stage。
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 760)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1100)
    await expect(page.locator('.source-pane')).toHaveCount(0)
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(async () => page.evaluate(async () => {
      const current = await window.origread.getSettings()
      return [current.sourcePaneCollapsed, current.articlePaneCollapsed]
    })).toEqual([false, false])

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(800, 640)
      window?.setContentSize(900, 760)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900)
    await expect(page.locator('.app-shell')).toHaveClass(/compact-layout/)
    await expect.poll(originalViewMatchesReaderStage).toBe(true)
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(true)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(960, 640)
      window?.setContentSize(1440, 900)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.article-pane')).toBeVisible()
    await expect.poll(originalViewMatchesReaderStage).toBe(true)

    await expect(page.locator('.reader-mode-button')).toBeVisible()
    await page.locator('.reader-mode-button').click()
    await expect.poll(() => page.evaluate(async () => (await window.origread.getOriginalArticleState()).open)).toBe(false)
    await expect(page.locator('.article-body')).toContainText('Article 1 summary')
    await expect(page.locator('.full-content-button')).not.toHaveClass(/active/)

    await page.evaluate(async (feedId) => {
      const groups = await window.origread.addGroup('E2E 分组')
      const group = groups.find((item) => item.name === 'E2E 分组')
      if (!group) throw new Error('E2E group was not created')
      await window.origread.updateFeedSettings(feedId, { groupId: group.id })
    }, currentFixture!.feedId)
    await page.reload()
    await expect(page.locator('.app-shell')).toBeVisible()
    await expect(page.locator('.source-group-header').filter({ hasText: 'E2E 分组' })).toBeVisible()
    await expect(page.locator('.source-destination-nav')).toHaveCount(0)
    const e2eGroup = page.locator('.source-group-section').filter({ hasText: 'E2E 分组' })
    const e2eGroupToggle = e2eGroup.locator('.source-group-collapse')
    await expect(e2eGroupToggle).toHaveAttribute('aria-expanded', 'true')
    await e2eGroupToggle.click()
    await expect(e2eGroupToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(e2eGroup.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' })).toHaveCount(0)
    await e2eGroupToggle.click()
    await expect(e2eGroupToggle).toHaveAttribute('aria-expanded', 'true')
    const sourceItem = page.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' })
    await sourceItem.click()
    await expect(page.locator('.article-scope-bar')).toContainText('OrigRead E2E Feed')
    const expectedScopeStats = await page.evaluate(async (feedId) => {
      const feedArticles = await window.origread.listArticlesByFeed(feedId)
      return {
        total: feedArticles.length,
        unread: feedArticles.filter((item) => item.isUnread).length,
        starred: feedArticles.filter((item) => item.isStarred).length
      }
    }, currentFixture!.feedId)
    const scopeStats = page.locator('.article-scope-stats > button')
    await expect(scopeStats).toHaveCount(3)
    await expect(scopeStats.nth(0)).toContainText(String(expectedScopeStats.total))
    await expect(scopeStats.nth(1)).toContainText(String(expectedScopeStats.unread))
    await expect(scopeStats.nth(2)).toContainText(String(expectedScopeStats.starred))
    await expect(page.locator('.article-list')).toBeVisible()
    await expect.poll(async () => page.locator('.article-item').evaluateAll((items, feedId) => items.length > 0 && items.every((item) => item.getAttribute('data-feed-id') === feedId), currentFixture!.feedId)).toBe(true)

    const articleMenuTarget = page.locator('.article-item').first()
    await articleMenuTarget.click({ button: 'right' })
    const articleContextMenu = page.locator('.desktop-context-menu')
    await expect(articleContextMenu.getByRole('menuitem', { name: /标记为(已读|未读)/ })).toBeVisible()
    await expect(articleContextMenu.getByRole('menuitem', { name: /(收藏文章|取消收藏)/ })).toBeVisible()
    await page.locator('.article-scope-bar').click()
    await expect(articleContextMenu).toBeHidden()

    await expect(page.locator(`.article-item[data-article-id="${currentFixture!.articleId}"]`)).toHaveClass(/read/)
    await expect(page.locator('.article-item.unread').first()).toBeVisible()

    await page.locator('.article-destination-item').filter({ hasText: '未读' }).click()
    await expect(page.locator('.article-scope-bar')).toContainText('OrigRead E2E Feed')
    await expect.poll(async () => page.locator('.article-item').evaluateAll((items, feedId) => items.length > 0 && items.every((item) => item.getAttribute('data-feed-id') === feedId && item.classList.contains('unread')), currentFixture!.feedId)).toBe(true)

    const unreadToStar = page.locator('.article-item.unread').first()
    await unreadToStar.locator('.star-button').click()
    await page.locator('.article-destination-item').filter({ hasText: '星标' }).click()
    await expect(page.locator('.article-scope-bar')).toContainText('OrigRead E2E Feed')
    await expect.poll(async () => page.locator('.article-item').evaluateAll((items, feedId) => items.length > 0 && items.every((item) => item.getAttribute('data-feed-id') === feedId), currentFixture!.feedId)).toBe(true)

    const sourceRefresh = page
      .locator('.source-item')
      .filter({ hasText: 'OrigRead E2E Feed' })
      .locator('.source-refresh-button')
    await expect(sourceRefresh).toBeVisible()

    const requestsAfterSubscribe = fixture.feedRequests()
    await sourceRefresh.click()
    await expect.poll(() => fixture.feedRequests()).toBeGreaterThan(requestsAfterSubscribe)

    const requestsAfterSingleRefresh = fixture.feedRequests()
    await page.locator('.refresh-all-button').click()
    await expect.poll(() => fixture.feedRequests()).toBeGreaterThan(requestsAfterSingleRefresh)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

test('reader selection survives source and article filter changes', async () => {
  test.setTimeout(45_000)
  const fixture = await startFeedServer()
  const { server } = fixture
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await page.locator('.dialog-field input').fill(feedUrl)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-candidate').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    const article = page.locator('.article-item').filter({ hasText: 'OrigRead E2E Article 1' }).first()
    await expect(article).toBeVisible()
    const selectedArticleId = await article.getAttribute('data-article-id')
    expect(selectedArticleId).not.toBeNull()
    await article.click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // DL-3：真实数据下验证双栏 Source Picker Overlay 不重建 Article Workspace，也不替换 Reader。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    const twoPaneArticleSearch = page.locator('.two-pane-workspace-base .article-pane .search-field input')
    await twoPaneArticleSearch.fill('Article 1')
    await page.locator('.two-pane-source-picker-button').click()
    const sourcePicker = page.locator('.two-pane-source-picker-overlay')
    const sourcePickerSearch = sourcePicker.locator('.search-field input')
    const sourcePickerGroupToggle = sourcePicker.locator('.source-group-collapse').first()
    await expect(sourcePickerSearch).toBeFocused()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await expect(twoPaneArticleSearch).toHaveValue('Article 1')

    // 手动折叠分组后，来源搜索临时展开命中分组；清空搜索后恢复原折叠状态。
    await sourcePickerGroupToggle.click()
    await expect(sourcePickerGroupToggle).toHaveAttribute('aria-expanded', 'false')
    await sourcePickerSearch.fill('OrigRead E2E Feed')
    await expect(sourcePickerGroupToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(sourcePickerGroupToggle).toBeDisabled()
    await expect(sourcePicker.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' })).toBeVisible()
    await expect(twoPaneArticleSearch).toHaveValue('Article 1')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    await sourcePickerSearch.fill('')
    await expect(sourcePickerGroupToggle).toHaveAttribute('aria-expanded', 'false')
    await expect(sourcePicker.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' })).toHaveCount(0)
    await sourcePickerGroupToggle.click()
    await sourcePicker.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' }).click()
    await expect(sourcePicker).toHaveCount(0)
    await expect(page.locator('.article-scope-bar')).toContainText('OrigRead E2E Feed')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await expect(twoPaneArticleSearch).toHaveValue('')

    // Group / All 与 Feed 使用同一条关闭链；每次只改变 Article Scope，不替换 Reader。
    await page.locator('.two-pane-source-picker-button').click()
    await page.locator('.two-pane-source-picker-overlay .source-group-scope').first().click()
    await expect(sourcePicker).toHaveCount(0)
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await page.locator('.two-pane-source-picker-button').click()
    await page.locator('.two-pane-source-picker-overlay .source-scope-all').click()
    await expect(sourcePicker).toHaveCount(0)
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // 回到三栏继续原有筛选回归；两种布局共享同一 Article / Reader 状态链。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // UI-3P.3：Source / Article 搜索框同时存在且状态独立，操作任一左侧 Pane 都不能清空 Reader。
    const articleSearch = page.locator('.article-pane .search-field input')
    const sourceSearch = page.locator('.source-pane .search-field input')
    await articleSearch.fill('Article 1')
    await expect(sourceSearch).toHaveValue('')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await sourceSearch.fill('OrigRead E2E Feed')
    await expect(page.locator('.article-list')).toBeVisible()
    await expect(articleSearch).toHaveValue('Article 1')
    await expect(sourceSearch).toHaveValue('OrigRead E2E Feed')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    await articleSearch.fill('__origread_missing_article__')
    await expect(page.locator('.article-list-empty')).toContainText('没有匹配的文章')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await page.getByRole('button', { name: '清除搜索' }).click()
    await expect(articleSearch).toHaveValue('')
    await expect(page.locator('.article-list')).toBeVisible()

    // Destination 只存在于 Article Pane；切换过滤仍不能替换 Reader 当前文章。
    await page.locator('.article-destination-item').filter({ hasText: '未读' }).click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await expect(page.locator(`.article-item[data-article-id="${selectedArticleId!}"]`)).toHaveCount(0)
    await page.locator('.article-destination-item').filter({ hasText: '全部文章' }).click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // Group Scope 与 Feed Scope 一样，只替换 Article Pane 数据范围；当前 Reader 不应被清空。
    const groupScope = page.locator('.source-group-scope').first()
    await expect(groupScope).toBeVisible()
    await groupScope.click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // Feed Scope 只替换 Article Pane 的数据范围，不替换 Reader 当前文章。
    await page.locator('.source-item').filter({ hasText: 'OrigRead E2E Feed' }).click()
    await expect(page.locator('.article-scope-bar')).toContainText('OrigRead E2E Feed')
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // Starred Destination 也必须只过滤 Article Pane。先收藏当前文章，确保切入星标后它仍可见且 Reader 保持。
    const selectedArticle = page.locator(`.article-item[data-article-id="${selectedArticleId!}"]`)
    await selectedArticle.locator('.star-button').click()
    await page.locator('.article-destination-item').filter({ hasText: '星标' }).click()
    await expect(selectedArticle).toBeVisible()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')
    await page.locator('.article-destination-item').filter({ hasText: '全部文章' }).click()

    // 只有显式点击另一篇文章才允许替换 Reader。
    const nextArticle = page.locator('.article-item').filter({ hasText: 'OrigRead E2E Article 2' }).first()
    await expect(nextArticle).toBeVisible()
    await nextArticle.click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 2')
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

test('reader share copies Markdown and account change clears the previous reader', async () => {
  test.setTimeout(45_000)
  const fixture = await startFeedServer()
  const { server } = fixture
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    await page.locator('.subscription-menu-anchor .primary-action').click()
    await page.getByRole('menuitem', { name: '添加来源' }).click()
    await page.locator('.dialog-field input').fill(feedUrl)
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-candidate').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('.dialog-submit').click()
    await expect(page.locator('.source-dialog')).toBeHidden({ timeout: 10_000 })

    const article = page.locator('.article-item').filter({ hasText: 'OrigRead E2E Article 1' }).first()
    await expect(article).toBeVisible()
    await article.click()
    await expect(page.locator('.article-heading h1')).toContainText('OrigRead E2E Article 1')

    // UI-3P.10：首次分享走真实 Renderer -> clipboard 链路，默认格式至少包含标题与原文 URL。
    await page.locator('.reading-share-button').click()
    const shareDialog = page.locator('.reading-share-dialog')
    await expect(shareDialog).toBeVisible()
    await shareDialog.locator('.dialog-submit').click()
    await expect(page.locator('.reading-share-status')).toBeVisible()
    const copiedMarkdown = await testApp.app.evaluate(({ clipboard }) => clipboard.readText())
    expect(copiedMarkdown).toContain('# OrigRead E2E Article 1')
    expect(copiedMarkdown).toContain('/article/1')
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getSettings()).readingShareConfigured)).toBe(true)

    // DL-5：先切到双栏，再切换账户；旧 Reader 必须在双栏立即清空，切回三栏后也不能复活。
    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="two-pane"]').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await page.getByRole('button', { name: '账户' }).click()
    const addAccountSection = page.locator('.settings-section').filter({ hasText: '添加账户' }).last()
    await expect(addAccountSection).toBeVisible()
    await addAccountSection.locator('input').first().fill('UI-3P.10 Second Local')
    await addAccountSection.getByRole('button', { name: '添加账户' }).click()
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getAccounts()).accounts.length)).toBe(2)
    await expect.poll(async () => page.evaluate(async () => (await window.origread.getAccounts()).accounts.find((item) => item.name === 'UI-3P.10 Second Local')?.id === (await window.origread.getAccounts()).currentAccountId)).toBe(true)

    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'two-pane')
    await expect(page.locator('.reader-empty-state')).toBeVisible()
    await expect(page.locator('.article-heading')).toHaveCount(0)
    await expect(page.locator('.article-item')).toHaveCount(0)

    await page.locator('.settings-button').click()
    await page.locator('.layout-mode-option[data-layout-mode="three-pane"]').click()
    await page.locator('.settings-close-button').click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', 'three-pane')
    await expect(page.locator('.reader-empty-state')).toBeVisible()
    await expect(page.locator('.article-heading')).toHaveCount(0)
    await expect(page.locator('.article-item')).toHaveCount(0)
  } finally {
    await testApp.close()
    await closeServer(server)
  }
})

async function startFeedServer(): Promise<{ server: Server; feedRequests: () => number; articleRequests: () => number }> {
  let feedRequests = 0
  let articleRequests = 0
  const server = createServer((request, response) => {
    if (request.url === '/feed.xml') {
      feedRequests += 1
      response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      response.end(rssXml(`http://${request.headers.host}`))
      return
    }
    const articleMatch = request.url?.match(/^\/article\/(\d+)$/)
    if (articleMatch) {
      articleRequests += 1
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(articleHtml(Number(articleMatch[1])))
      return
    }
    const imageMatch = request.url?.match(/^\/image\/(\d+)\.png$/)
    if (imageMatch) {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, feedRequests: () => feedRequests, articleRequests: () => articleRequests }
}

function rssXml(baseUrl: string): string {
  const items = Array.from({ length: 30 }, (_, index) => `
    <item>
      <guid>e2e-${index + 1}</guid>
      <title>OrigRead E2E Article ${index + 1}</title>
      <link>${baseUrl}/article/${index + 1}</link>
      <pubDate>${new Date(Date.UTC(2026, 7, 14, 5, 0 - index)).toUTCString()}</pubDate>
      <description>Article ${index + 1} summary</description>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>OrigRead E2E Feed</title>
        <link>https://example.com/e2e</link>
        <description>OrigRead unified discovery fixture</description>
        ${items}
      </channel>
    </rss>`
}

function articleHtml(id: number): string {
  return `<!doctype html>
    <html>
      <head>
        <title>OrigRead E2E Article ${id}</title>
        <meta property="og:title" content="OrigRead E2E Article ${id}">
        <meta name="author" content="OrigRead E2E Author">
      </head>
      <body>
        <nav>Home · Archive · Categories</nav>
        <article>
          <h1>OrigRead E2E Article ${id}</h1>
          <img src="/image/${id}.png" alt="OrigRead E2E image ${id}">
          <p>OrigRead extracted full text article ${id}. ${'This paragraph contains useful full article text for deterministic Readability extraction and desktop reader validation. '.repeat(18)}</p>
          <p>${'The second paragraph keeps the fixture article-like, long enough for content scoring, sanitizing, caching, rendering, and real reader scrolling checks. '.repeat(18)}</p>
          <a href="/related/${id}">Related reading</a>
        </article>
      </body>
    </html>`
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

