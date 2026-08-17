import { createServer, type Server, type ServerResponse } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('desktop update flow handles available, latest and private repository states', async () => {
  const fixture = await startUpdateServer()
  const address = fixture.server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a port')
  const base = `http://127.0.0.1:${address.port}`
  const testApp = await launchIsolatedOrigRead({
    ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '0',
    ORIGREAD_UPDATE_API_BASE: base
  })

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    // 默认与 Android 一致：启动自动检查开启，发现新版本后显示非阻塞弹窗。
    const updateDialog = page.locator('.update-available-dialog')
    await expect(updateDialog).toBeVisible({ timeout: 10_000 })
    await expect(updateDialog).toContainText('v1.0.0')
    await expect(updateDialog.getByRole('button', { name: /下载安装包|Download installer/ })).toBeVisible()
    await updateDialog.locator('.dialog-close').click()

    await page.locator('.settings-button').click()
    await page.getByRole('button', { name: /软件更新|Software update/ }).click()
    await expect(page.locator('.update-status-card')).toContainText(/发现新版本|New version available/)
    await expect(page.locator('.update-release-asset')).toContainText('OrigRead-1.0.0-Windows-x64.exe')
    await expect(page.locator('.setting-switch input').last()).toBeChecked()

    // 同一 Release body 使用不可见注释分段；Main 可按当前软件语言选择英文段。
    const english = await page.evaluate(async () => window.origread.checkForUpdates('en'))
    expect(english.release?.notes).toBe('- New update flow')

    fixture.setMode('latest')
    await page.locator('.update-check-button').click()
    await expect(page.locator('.update-status-card')).toContainText(/已是最新版本|You are up to date/)

    fixture.setMode('private')
    await page.locator('.update-check-button').click()
    await expect(page.locator('.update-status-card')).toContainText(/私有仓库|private/)
    await expect(page.locator('.update-status-card')).not.toContainText(/已是最新版本|You are up to date/)
  } finally {
    await testApp.close()
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()))
  }
})

async function startUpdateServer(): Promise<{ server: Server; setMode(mode: 'available' | 'latest' | 'private'): void }> {
  let mode: 'available' | 'latest' | 'private' = 'available'
  const server = createServer((request, response) => {
    if (request.url !== '/repos/ZGMFX01A/OrigRead-Desktop/releases/latest') {
      response.writeHead(404).end('not found')
      return
    }
    if (mode === 'private') {
      json(response, { message: 'Not Found' }, 404)
      return
    }
    const version = mode === 'latest' ? '0.1.0' : '1.0.0'
    json(response, {
      tag_name: `v${version}`,
      name: `OrigRead Desktop ${version}`,
      body: '<!-- lang:zh -->\n- 新的更新流程\n\n<!-- lang:en -->\n- New update flow',
      published_at: '2026-08-17T02:00:00Z',
      html_url: `https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v${version}`,
      assets: [{
        id: 100,
        name: `OrigRead-${version}-Windows-x64.exe`,
        size: 1024 * 1024 * 80,
        browser_download_url: `https://github.com/ZGMFX01A/OrigRead-Desktop/releases/download/v${version}/OrigRead-${version}-Windows-x64.exe`
      }]
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, setMode(next) { mode = next } }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

