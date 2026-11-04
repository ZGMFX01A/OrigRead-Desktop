import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { _electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'

interface DesktopSession {
  app: ElectronApplication
  page: Page
  pageErrors: string[]
}

const test = base.extend<{ userDataDir: string; tempFontDir: string }>({
  userDataDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const userDataDir = await mkdtemp(join(resultsRoot, 'desktop-lifecycle-'))
    try {
      await use(userDataDir)
    } finally {
      await rm(userDataDir, { recursive: true })
    }
  },
  tempFontDir: async ({}, use) => {
    const resultsRoot = join(process.cwd(), 'test-results')
    await mkdir(resultsRoot, { recursive: true })
    const dir = await mkdtemp(join(resultsRoot, 'desktop-font-fixture-'))
    try {
      await use(dir)
    } finally {
      await rm(dir, { recursive: true })
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

test('连续打开关闭隔离本地原网页视图至少20次无残留与崩溃且WebContents数量回归基线', async ({ userDataDir }) => {
  test.setTimeout(90_000)
  let serverHits = 0
  const server = createServer((req, res) => {
    if (req.url === '/original-page') {
      serverHits += 1
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html><body><h1>Local Fixture Page</h1></body></html>')
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const fixtureUrl = `http://127.0.0.1:${port}/original-page`

  try {
    await withDesktop(userDataDir, async ({ app, page, pageErrors }) => {
      const bounds = { x: 50, y: 50, width: 600, height: 400 }

      // 记录初始 WebContents 基线
      const baselineWebContents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)

      for (let i = 0; i < 20; i++) {
        const previousHits = serverHits
        await page.evaluate(async ({ url, bounds }) => {
          await window.origread.openOriginalArticle(url, bounds)
        }, { url: fixtureUrl, bounds })

        // 至少等待本地原网页实际完成网络请求与加载，避免在 load 之前就 close
        await expect.poll(() => serverHits).toBe(previousHits + 1)

        const stateOpen = await page.evaluate(async () => {
          return await window.origread.getOriginalArticleState()
        })
        expect(stateOpen.open).toBe(true)

        // 打开时 WebContents 数量必须大于基线
        const activeCount = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
        expect(activeCount).toBeGreaterThan(baselineWebContents)

        // 关闭原网页视图
        await page.evaluate(async () => {
          await window.origread.closeOriginalArticle()
        })

        const stateClosed = await page.evaluate(async () => {
          return await window.origread.getOriginalArticleState()
        })
        expect(stateClosed.open).toBe(false)

        // 验证 WebContents 实际回收，回归到基线数量
        await expect.poll(async () => {
          return await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
        }).toBe(baselineWebContents)
      }

      // 20次循环全部结束后，最终 WebContents 严格回归基线
      const finalCount = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
      expect(finalCount).toBe(baselineWebContents)
      expect(pageErrors).toEqual([])
    })
  } finally {
    server.close()
  }
})

test('受控本地字体协议流式加载、FontFace生效、非法路径拒绝与重启恢复', async ({ userDataDir, tempFontDir }) => {
  const winFontPath = 'C:/Windows/Fonts/arial.ttf'
  if (!existsSync(winFontPath)) {
    test.skip(!existsSync(winFontPath), 'Windows 系统字体 arial.ttf 不存在，跳过本地字体协议集成测试')
    return
  }

  // 复制系统字体到临时测试目录，绝不修改系统文件或使用用户真实配置
  const tempFontPath = join(tempFontDir, 'test-arial.ttf')
  await copyFile(winFontPath, tempFontPath)

  let importedFontId = ''

  // 第一次运行：mock 对话框导入字体、验证协议 URL、测试 FontFace 加载及非法 ID 拒绝
  await withDesktop(userDataDir, async ({ app, page, pageErrors }) => {
    // 在主进程 mock dialog.showOpenDialog 返回临时字体文件路径
    await app.evaluate(({ dialog }, fontPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [fontPath]
      })
    }, tempFontPath)

    const result = await page.evaluate(async () => {
      return await window.origread.importReaderFont()
    })

    expect(result.ok).toBe(true)
    expect(result.font).not.toBeNull()
    const font = result.font!
    importedFontId = font.id
    expect(font.id).toBeTruthy()
    expect(font.dataUrl).toMatch(/^origread-font:\/\/custom\/[a-zA-Z0-9_%-]+$/)
    // 验证不包含 Base64 大字符串
    expect((font as unknown as { base64?: string }).base64).toBeUndefined()
    expect(font.dataUrl.startsWith('data:')).toBe(false)

    // 在页面环境使用 FontFace 真正通过受控协议加载字体
    const loadResult = await page.evaluate(async (fontUrl) => {
      try {
        const fontFace = new FontFace('TestArialCustom', `url(${fontUrl})`)
        const loaded = await fontFace.load()
        document.fonts.add(loaded)
        return { ok: true, status: loaded.status }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }, font.dataUrl)

    expect(loadResult.ok).toBe(true)
    expect(loadResult.status).toBe('loaded')

    // 验证非法路径穿越与非法 ID 被协议安全拒绝（非 200）
    const securityCheck = await page.evaluate(async () => {
      const results: number[] = []
      try {
        const res1 = await fetch('origread-font://custom/../secrets.json')
        results.push(res1.status)
      } catch {
        results.push(0)
      }
      try {
        const res2 = await fetch('origread-font://custom/non-existent-font-id-12345')
        results.push(res2.status)
      } catch {
        results.push(0)
      }
      return results
    })

    // 非法请求应返回 403 / 404 或 fetch 失败（0），绝不允许成功返回 200
    expect(securityCheck.every((status) => status !== 200)).toBe(true)
    expect(pageErrors).toEqual([])
  })

  // 第二次运行：关闭后重启，验证同一个 userDataDir 下字体持久化与恢复
  await withDesktop(userDataDir, async ({ page, pageErrors }) => {
    const fonts = await page.evaluate(async () => {
      return await window.origread.listReaderFonts()
    })

    const found = fonts.find((f) => f.id === importedFontId)
    expect(found).toBeDefined()
    expect(found?.dataUrl).toMatch(/^origread-font:\/\/custom\//)

    // 删除该字体
    await page.evaluate(async (fontId) => {
      await window.origread.deleteReaderFont(fontId)
    }, importedFontId)

    const fontsAfterDelete = await page.evaluate(async () => {
      return await window.origread.listReaderFonts()
    })
    expect(fontsAfterDelete.some((f) => f.id === importedFontId)).toBe(false)
    expect(pageErrors).toEqual([])
  })
})

test('真实全文阅读请求取消契约与并发取消隔离集成测试', async ({ userDataDir }) => {
  test.setTimeout(60_000)

  let slowRequestReceived = 0
  let slowRequestAborted = false

  const server = createServer((req, res) => {
    if (req.url === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' })
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Cancel Test RSS Feed</title>
    <link>http://127.0.0.1</link>
    <description>Cancel Test</description>
    <item>
      <guid>article-cancel-test-1</guid>
      <title>Article with slow full content</title>
      <link>http://127.0.0.1:${port}/slow-article</link>
      <description>Preview</description>
    </item>
  </channel>
</rss>`)
      return
    }

    if (req.url === '/slow-article') {
      slowRequestReceived += 1
      req.on('close', () => {
        slowRequestAborted = true
      })
      // 故意保持连接不返回，等待外部取消触发连接关闭
      return
    }

    if (req.url === '/fast-article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!DOCTYPE html><html><body><article><p>Fast article content succeeded.</p></article></body></html>')
      return
    }

    res.writeHead(404).end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    await withDesktop(userDataDir, async ({ page, pageErrors }) => {
      // 1. 实测验证：无活跃请求时直接调用 cancelFullContent，必须存在 IPC Handler 且正常返回 false，绝不能报错
      const noActiveResult = await page.evaluate(async () => {
        return await window.origread.cancelFullContent('audit-no-active-article', 'audit-no-active-request')
      })
      expect(noActiveResult).toBe(false)

      // 2. 订阅本地包含慢响应的 RSS 源，拿到文章 ID
      const feedPayload = await page.evaluate(async (feedUrl) => {
        const source = await window.origread.addRssSource(feedUrl)
        const articles = await window.origread.listArticlesByFeed(source.feedId)
        return { feedId: source.feedId, articleId: articles[0]?.id }
      }, `http://127.0.0.1:${port}/feed.xml`)

      expect(feedPayload.articleId).toBeTruthy()
      const targetArticleId = feedPayload.articleId!

      // 3. 发起全文抓取请求（携带 requestId: req-slow-1）
      const fetchPromiseHandle = page.evaluate(async ({ articleId, reqId }) => {
        try {
          return await window.origread.fetchFullContent(articleId, reqId)
        } catch (error) {
          return { error: String(error) }
        }
      }, { articleId: targetArticleId, reqId: 'req-slow-1' })

      // 等待本地服务器确认已经收到了针对 /slow-article 的 HTTP 请求
      await expect.poll(() => slowRequestReceived).toBe(1)
      expect(slowRequestAborted).toBe(false)

      // 4. 调用精准取消，传入匹配的 articleId 与 requestId
      const cancelResult = await page.evaluate(async ({ articleId, reqId }) => {
        return await window.origread.cancelFullContent(articleId, reqId)
      }, { articleId: targetArticleId, reqId: 'req-slow-1' })

      expect(cancelResult).toBe(true)

      // 验证本地 HTTP 服务的底层连接被取消中断
      await expect.poll(() => slowRequestAborted).toBe(true)

      // 5. 验证“取消旧 request 不杀新 request”：
      // 发起新请求 req-new-2
      const newFetchPromise = page.evaluate(async ({ articleId, reqId }) => {
        try {
          return await window.origread.fetchFullContent(articleId, reqId)
        } catch (error) {
          return { error: String(error) }
        }
      }, { articleId: targetArticleId, reqId: 'req-new-2' })

      // 故意用旧的 requestId 'req-slow-1' 再次调用 cancelFullContent
      const staleCancelResult = await page.evaluate(async ({ articleId, staleReqId }) => {
        return await window.origread.cancelFullContent(articleId, staleReqId)
      }, { articleId: targetArticleId, staleReqId: 'req-slow-1' })

      // 旧的取消请求不能命中当前已更新的新请求
      expect(staleCancelResult).toBe(false)

      // 清理未完成的 promise
      await page.evaluate(async ({ articleId, reqId }) => {
        await window.origread.cancelFullContent(articleId, reqId)
      }, { articleId: targetArticleId, reqId: 'req-new-2' })

      expect(pageErrors).toEqual([])
    })
  } finally {
    server.close()
  }
})
