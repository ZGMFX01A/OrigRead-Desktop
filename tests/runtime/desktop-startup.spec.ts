import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, expect, test as base, type Page } from '@playwright/test'
import type { OrigReadDesktopApi } from '../../src/shared/contracts'

// 新本地账户包含默认分组和发行订阅，后台同步关闭时尚无文章。
const INITIAL_LIBRARY_COUNTS = { groups: 1, feeds: 1, articles: 0, unread: 0, starred: 0 }

interface DesktopSession {
  readonly page: Page
  readonly pageErrors: string[]
}

// 每个用例独立使用真实数据库，结束后仅删除自己创建的临时数据。
const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const userDataDir = await mkdtemp(join(resultsRoot, 'desktop-startup-'))
    try {
      await use(userDataDir)
    } finally {
      await rm(userDataDir, { recursive: true })
    }
  }
})

/** 使用实际生产构建启动 Electron；继承完整系统环境以支持原生窗口和系统路径。 */
async function withDesktop<T>(userDataDir: string, inspect: (session: DesktopSession) => Promise<T>): Promise<T> {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
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
    return await inspect({ page, pageErrors })
  } finally {
    await app.close()
  }
}

/** 窗口显示后通过正式 preload/IPC 读取真实 SQLite，避免仅有空白窗口也通过。 */
async function inspectStartup(session: DesktopSession) {
  await expect(session.page.locator('.app-shell')).toBeVisible()
  await expect(session.page.locator('.article-pane')).toBeVisible()
  await expect(session.page.locator('.reader-pane')).toBeVisible()
  const state = await session.page.evaluate(async () => {
    const api: OrigReadDesktopApi = window.origread
    return {
      info: await api.getAppInfo(),
      accounts: await api.getAccounts(),
      snapshot: await api.getLibrarySnapshot(),
      feeds: (await api.listFeeds()).map((feed) => ({ id: feed.id, url: feed.url, sourceType: feed.sourceType }))
    }
  })
  expect(state.info.platform).toBe(process.platform)
  expect(state.info.version).toMatch(/^\d+\.\d+\.\d+/)
  expect(state.snapshot).toEqual(INITIAL_LIBRARY_COUNTS)
  expect(session.pageErrors).toEqual([])
  return state
}

test('生产构建的窗口、preload、IPC 和真实数据库正常启动', async ({ userDataDir }) => {
  await withDesktop(userDataDir, inspectStartup)
})

test('实际关闭重启后账户和默认订阅身份保持且没有重复', async ({ userDataDir }) => {
  const before = await withDesktop(userDataDir, inspectStartup)
  const after = await withDesktop(userDataDir, inspectStartup)
  expect(after.accounts).toEqual(before.accounts)
  expect(after.snapshot).toEqual(before.snapshot)
  expect(after.feeds).toEqual(before.feeds)
})
