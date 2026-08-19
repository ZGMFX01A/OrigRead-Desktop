import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

const BUILTIN_RELEASE_FEED = 'https://github.com/ZGMFX01A/OrigRead-Desktop/releases.atom'

test('built-in project Release feed exposes platform-specific download and Release page actions', async () => {
  const server = await startReleaseFixtureServer()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port')
  const feedUrl = `http://127.0.0.1:${address.port}/release.xml`
  const testApp = await launchIsolatedOrigRead()

  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const state = await page.evaluate(async ({ builtInUrl, fixtureUrl }) => {
      const initialFeeds = await window.origread.listFeeds()
      const builtIn = initialFeeds.find((feed) => feed.url === builtInUrl)
      const added = await window.origread.addRssSource(fixtureUrl)
      const articles = await window.origread.listArticlesByFeed(added.feedId)
      const article = articles.find((item) => item.title === 'OrigRead Desktop v1.2.3')
      const appInfo = await window.origread.getAppInfo()
      return {
        builtIn: builtIn ? { name: builtIn.name, sourceType: builtIn.sourceType } : null,
        articleId: article?.id ?? null,
        platform: appInfo.platform,
        arch: appInfo.arch
      }
    }, { builtInUrl: BUILTIN_RELEASE_FEED, fixtureUrl: feedUrl })

    expect(state.builtIn).toEqual({ name: 'OrigRead Desktop Releases', sourceType: 'rss' })
    expect(state.articleId).not.toBeNull()

    await page.reload()
    const releaseArticle = page.locator(`.article-item[data-article-id="${state.articleId}"]`)
    await expect(releaseArticle).toBeVisible()
    await releaseArticle.click()

    const actions = page.locator('.origread-release-actions')
    await expect(actions).toBeVisible()
    await expect(actions.getByRole('button', { name: /下载安装包|Download installer/ })).toBeVisible()
    await expect(actions.getByRole('button', { name: /打开 Release 页面|Open Release page/ })).toBeVisible()

    const expectedAsset = assetNameFor(state.platform, state.arch)
    if (expectedAsset) await expect(actions).toContainText(expectedAsset)
  } finally {
    await testApp.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function assetNameFor(platform: string, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'OrigRead-1.2.3-x64.exe'
  if (platform === 'darwin' && arch === 'arm64') return 'OrigRead-1.2.3-arm64.dmg'
  if (platform === 'linux' && arch === 'x64') return 'OrigRead-1.2.3-x64.AppImage'
  return null
}

async function startReleaseFixtureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url !== '/release.xml') {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
    response.end(`<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Release action fixture</title>
          <link>https://github.com/ZGMFX01A/OrigRead-Desktop</link>
          <item>
            <guid>origread-desktop-v1.2.3</guid>
            <title>OrigRead Desktop v1.2.3</title>
            <link>https://github.com/ZGMFX01A/OrigRead-Desktop/releases/tag/v1.2.3</link>
            <pubDate>Wed, 19 Aug 2026 06:00:00 GMT</pubDate>
            <description>Release fixture</description>
            <content:encoded><![CDATA[<p>Release notes fixture for platform-specific download actions.</p>]]></content:encoded>
          </item>
        </channel>
      </rss>`)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}
