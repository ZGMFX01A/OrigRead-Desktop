import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { _electron, expect, test as base, type ElectronApplication, type JSHandle, type Locator, type Page } from '@playwright/test'
import type { BrowserWindow } from 'electron'
import { SOURCE_PANE_WIDTH_MIN, SOURCE_PANE_WIDTH_MAX, ARTICLE_PANE_WIDTH_MAX, WORKSPACE_PANE_WIDTH_MIN, WORKSPACE_PANE_WIDTH_MAX, type DesktopSettingsPatch } from '../../src/shared/settings'

const runFile = promisify(execFile)
const test = base.extend<{ userDataDir: string }>({
  userDataDir: async ({}, use) => {
    const directory = join(process.cwd(), 'test-results')
    await mkdir(directory, { recursive: true })
    const userData = await mkdtemp(join(directory, 'desktop-window-chrome-'))
    try { await use(userData) } finally { await rm(userData, { recursive: true }) }
  }
})

interface Desktop {
  app: ElectronApplication
  page: Page
  window: JSHandle<BrowserWindow>
}
interface Point { x: number; y: number }
interface Rect extends Point { width: number; height: number }

async function withDesktop(userDataDir: string, inspect: (desktop: Desktop) => Promise<void>): Promise<void> {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const app = await _electron.launch({
    args: [process.cwd()], cwd: process.cwd(),
    env: { ...inheritedEnv, ORIGREAD_E2E_USER_DATA_DIR: userDataDir,
      ORIGREAD_DISABLE_AUTO_UPDATE_CHECK: '1', ORIGREAD_DISABLE_PERIODIC_SYNC: '1' }
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const window = await app.browserWindow(page)
    await window.evaluate(window => window.setContentSize(1440, 900))
    await expect(page.locator('.app-shell')).toBeVisible()
    try {
      await inspect({ app, page, window })
      expect(errors).toEqual([])
    } catch (error) {
      const geometry = await page.evaluate(() => {
        const selectors = ['html', 'body', '#root', '.app-shell', '.source-pane', '.two-pane-workspace', '.brand-row',
          '.brand-lockup', '.source-brand-copy', '.brand-name', '.brand-tagline', '.brand-actions',
          '.subscription-anchor', '.subscription-trigger', '.source-discovery-button', '.article-pane', '.article-scope-bar',
          '.reader-pane', '.reader-toolbar', '.reader-title', '.reader-actions', '.reader-stage']
        return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, elements: selectors.map(selector => {
          const element = document.querySelector<HTMLElement>(selector)
          if (!element) return { selector, missing: true }
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
          return { selector, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
            style: Object.fromEntries(['display', 'grid-template-columns', 'padding', 'font-size', 'min-width', 'width', 'gap',
              'flex', 'overflow', '-webkit-app-region', 'container-type', 'container-name'].map(key => [key, style.getPropertyValue(key)])) }
        }) }
      })
      const native = await window.evaluate(window => ({ bounds: window.getBounds(), content: window.getContentBounds(),
        maximized: window.isMaximized(), fullscreen: window.isFullScreen(), zoom: window.webContents.getZoomFactor(),
        hwnd: window.getNativeWindowHandle().toString('hex') }))
      const snapshot = { geometry, native }
      console.log('WINDOW_CHROME_FAILURE_GEOMETRY ' + JSON.stringify(snapshot))
      await test.info().attach('window-chrome-geometry', { body: JSON.stringify(snapshot, null, 2), contentType: 'application/json' })
      await page.screenshot({ path: 'test-results/desktop-window-chrome-failure-' + test.info().line + '.png' })
      throw error
    }
  } finally { await app.close() }
}

async function frames(page: Page, count = 3): Promise<void> {
  await page.evaluate(count => new Promise<void>(resolve => {
    const tick = (): void => { if (--count <= 0) resolve(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  }), count)
}

async function configure(page: Page, patch: DesktopSettingsPatch): Promise<void> {
  await page.evaluate(patch => window.origread.updateSettings(patch), patch)
  await page.reload()
  await expect(page.locator('.app-shell')).toBeVisible()
  if (patch.layoutMode) await expect(page.locator('.app-shell')).toHaveAttribute('data-layout-mode', patch.layoutMode)
  if (patch.theme && patch.theme !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme', patch.theme)
  if (patch.uiFontScale) {
    await expect.poll(() => page.locator('.brand-name').first().evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize)))
      .toBeCloseTo(17 * patch.uiFontScale / 100, 2)
  }
  await frames(page)
}

async function expectUnclippedControl(control: Locator, boundarySelector: string): Promise<void> {
  await expect(control).toBeVisible()
  const geometry = await control.evaluate((element, boundarySelector) => {
    const boundary = element.closest(boundarySelector)
    if (!boundary) throw new Error('Missing control boundary: ' + boundarySelector)
    const rect = element.getBoundingClientRect()
    const pane = boundary.getBoundingClientRect()
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
      [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3]
    ]
    return {
      width: rect.width, height: rect.height,
      inside: rect.left >= pane.left - 0.5 && rect.right <= pane.right + 0.5
        && rect.top >= pane.top - 0.5 && rect.bottom <= pane.bottom + 0.5
        && rect.left >= 0 && rect.right <= innerWidth + 0.5 && rect.top >= 0 && rect.bottom <= innerHeight + 0.5,
      hittable: points.every(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return hit !== null && element.contains(hit) })
    }
  }, boundarySelector)
  expect(geometry.inside, 'The entire button must fit its pane and viewport').toBe(true)
  expect(geometry.hittable, 'The center and four interior corners must not be clipped or covered').toBe(true)
  expect(geometry.width).toBeGreaterThanOrEqual(30)
  expect(geometry.height).toBeGreaterThanOrEqual(30)
}

async function exerciseBrandHeader(page: Page, layout: 'three-pane' | 'two-pane', scale: number): Promise<void> {
  const boundary = layout === 'three-pane' ? '.source-pane' : '.two-pane-workspace'
  const header = page.locator(boundary + ' > .brand-row')
  const discovery = header.locator('.source-discovery-button')
  const subscription = header.locator('.subscription-trigger')
  await expectUnclippedControl(discovery, boundary)
  await expectUnclippedControl(subscription, boundary)
  const layoutState = await header.evaluate(element => {
    const brand = element.querySelector('.brand-lockup')!.getBoundingClientRect()
    const actions = element.querySelector('.brand-actions')!.getBoundingClientRect()
    const name = element.querySelector('.brand-name')!
    const style = getComputedStyle(name)
    return { overlap: brand.right > actions.left + 0.5, nameWidth: name.getBoundingClientRect().width,
      fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight), overflow: style.textOverflow }
  })
  expect(layoutState.overlap).toBe(false)
  expect(layoutState.nameWidth).toBeGreaterThan(0)
  expect(layoutState.fontSize).toBeCloseTo(17 * scale / 100, 2)
  expect(layoutState.lineHeight).toBeGreaterThanOrEqual(layoutState.fontSize)
  expect(layoutState.overflow).toBe('ellipsis')

  // Prove both the pointer path and the keyboard path still execute their original actions.
  await discovery.click()
  await expect(page.locator('.reader-toolbar .reader-title')).toHaveText((await discovery.getAttribute('aria-label'))!)
  await page.locator('.reader-toolbar .source-catalog-back-button').click()
  await subscription.focus()
  await expect(subscription).toBeFocused()
  await subscription.press('Enter')
  await expect(subscription).toHaveAttribute('aria-expanded', 'true')
  const menu = header.locator('.subscription-menu')
  await expect(menu).toBeVisible()
  const add = menu.getByRole('menuitem').first()
  await add.focus()
  await expect(add).toBeFocused()
  await add.press('Enter')
  const dialog = page.locator('.source-dialog[aria-labelledby="add-source-title"]')
  await expect(dialog).toBeVisible()
  await dialog.locator('.dialog-close').click()
  await expect(dialog).toHaveCount(0)
  await discovery.focus()
  await expect(discovery).toBeFocused()
}

test('中英、100/150%和真实最窄侧栏下，品牌动作完整可见且可点击和键盘访问', async ({ userDataDir }) => {
  test.setTimeout(120_000)
  await withDesktop(userDataDir, async ({ page }) => {
    for (const language of ['en', 'zh'] as const) {
      for (const uiFontScale of [100, 150] as const) {
        for (const layoutMode of ['three-pane', 'two-pane'] as const) {
          await test.step(language + '/' + uiFontScale + '/' + layoutMode, async () => {
            await configure(page, { language, uiFontScale, layoutMode, sourcePaneWidth: SOURCE_PANE_WIDTH_MIN,
              workspaceWidth: WORKSPACE_PANE_WIDTH_MIN, sourcePaneCollapsed: false, articlePaneCollapsed: false, workspaceCollapsed: false })
            // A narrower window would hide the three-pane source sidebar automatically.
            expect(await page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(1200)
            await exerciseBrandHeader(page, layoutMode, uiFontScale)
            if (uiFontScale === 150 && layoutMode === 'three-pane') {
              await page.screenshot({ path: 'test-results/desktop-window-chrome-source-220-' + language + '-150.png' })
            }
          })
        }
      }
    }
    // Catch the old fixed-width breakpoint and the normal widths users actually keep.
    for (const sourcePaneWidth of [245, 246, 260]) {
      await configure(page, { language: 'en', uiFontScale: 150, layoutMode: 'three-pane', sourcePaneWidth })
      await exerciseBrandHeader(page, 'three-pane', 150)
      if (sourcePaneWidth === 260) await page.screenshot({ path: 'test-results/desktop-window-chrome-source-260-en-150.png' })
    }
    await configure(page, { language: 'zh', uiFontScale: 150, layoutMode: 'three-pane', sourcePaneWidth: 260 })
    await exerciseBrandHeader(page, 'three-pane', 150)
    await page.screenshot({ path: 'test-results/desktop-window-chrome-source-260-zh-150.png' })
    for (const workspaceWidth of [420, 560]) {
      await configure(page, { language: 'en', uiFontScale: 150, layoutMode: 'two-pane', workspaceWidth })
      await exerciseBrandHeader(page, 'two-pane', 150)
    }
    await page.screenshot({ path: 'test-results/desktop-window-chrome-sidebar-150.png' })
  })
})

async function overlayGeometry(page: Page) {
  return page.evaluate(() => {
    const overlay = (navigator as Navigator & {
      windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect }
    }).windowControlsOverlay
    const rect = overlay?.getTitlebarAreaRect()
    const area = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
    const blocked = overlay?.visible && area ? [
      { x: 0, y: area.y, width: area.x, height: area.height },
      { x: area.x + area.width, y: area.y, width: Math.max(0, innerWidth - area.x - area.width), height: area.height }
    ] : []
    const overlaps: string[] = []
    for (const element of document.querySelectorAll<HTMLElement>('.reader-toolbar button:not(.reader-more-backdrop), .reader-toolbar input, .reader-toolbar select')) {
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (!bounds.width || !bounds.height || style.visibility === 'hidden' || style.display === 'none') continue
      if (blocked.some(control => control.width > 0 && Math.min(bounds.right, control.x + control.width) > Math.max(bounds.left, control.x) + 0.5
        && Math.min(bounds.bottom, control.y + control.height) > Math.max(bounds.top, control.y) + 0.5)) {
        overlaps.push(element.getAttribute('aria-label') || element.className)
      }
    }
    return { available: !!overlay, visible: overlay?.visible ?? false, area, overlaps,
      shellTop: document.querySelector('.app-shell')!.getBoundingClientRect().top,
      toolbarTop: document.querySelector('.reader-toolbar')!.getBoundingClientRect().top,
      brandTop: document.querySelector('.brand-row')?.getBoundingClientRect().top ?? null,
      toolbarHeight: document.querySelector('.reader-toolbar')!.getBoundingClientRect().height }
  })
}

async function expectReaderControls(page: Page, openMore = false): Promise<void> {
  await expectOverlayGeometry(page)
  const inspect = async (): Promise<void> => {
    const outside = await page.locator('.reader-toolbar').evaluate(toolbar => {
      const pane = toolbar.closest('.reader-pane')!.getBoundingClientRect()
      return [...toolbar.querySelectorAll<HTMLElement>('button:not(.reader-more-backdrop), input, select')].flatMap(element => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return []
        return rect.left < pane.left - 0.5 || rect.right > pane.right + 0.5 || rect.top < pane.top - 0.5
          || rect.bottom > pane.bottom + 0.5 || rect.left < 0 || rect.right > innerWidth + 0.5
          ? [{ label: element.getAttribute('aria-label') || element.className, x: rect.x, width: rect.width, pane: { x: pane.x, width: pane.width } }]
          : []
      })
    })
    expect(outside, 'Every visible toolbar control must fit the reader pane').toEqual([])
    await expectOverlayGeometry(page)
  }
  await inspect()
  const more = page.locator('.reader-more-button')
  if (openMore && await more.isVisible()) {
    await more.click()
    await expect(page.locator('.reader-secondary-actions.open')).toBeVisible()
    await inspect()
    await page.keyboard.press('Escape')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
  }
}

async function openOriginal(page: Page): Promise<void> {
  const original = page.locator('.original-button')
  const label = (await original.getAttribute('aria-label'))!
  if (!await original.isVisible()) await page.locator('.reader-more-button').click()
  await page.locator('.reader-toolbar').getByRole('button', { name: label, exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.origread.getOriginalArticleState())).toMatchObject({ open: true, loading: false })
}

async function expectOverlayGeometry(page: Page, visible: boolean | null = true): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-window-chrome', 'overlay')
  await expect(page.locator('.app-shell')).toHaveAttribute('data-window-chrome', 'overlay')
  await expect.poll(async () => (await overlayGeometry(page)).overlaps).toEqual([])
  const geometry = await overlayGeometry(page)
  expect(geometry.available).toBe(true)
  if (visible !== null) expect(geometry.visible).toBe(visible)
  expect(Math.abs(geometry.shellTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.toolbarTop)).toBeLessThanOrEqual(1)
  if (geometry.brandTop !== null) expect(Math.abs(geometry.brandTop)).toBeLessThanOrEqual(1)
  await expect(page.locator('html')).toHaveAttribute('data-window-controls-visible', String(geometry.visible))
  const divider = await page.locator('.reader-toolbar').evaluate(toolbar => {
    const style = getComputedStyle(toolbar, '::after')
    return { content: style.content, right: Number.parseFloat(style.right), width: Number.parseFloat(style.width),
      borderWidth: Number.parseFloat(style.borderLeftWidth), borderStyle: style.borderLeftStyle, borderColor: style.borderLeftColor,
      boxSizing: style.boxSizing, pointerEvents: style.pointerEvents, viewportWidth: innerWidth,
      theme: document.documentElement.dataset.theme, toolbarBackground: getComputedStyle(toolbar).backgroundColor }
  })
  expect(divider.toolbarBackground).toBe(divider.theme === 'dark' ? 'rgb(32, 34, 40)' : 'rgb(255, 255, 255)')
  if (geometry.visible) {
    expect(divider.content).not.toBe('none')
    expect(divider.width).toBe(1)
    // Chromium quantizes the CSS border to device pixels at fractional display scaling.
    expect(divider.borderWidth).toBeGreaterThan(0)
    expect(divider.borderWidth).toBeLessThanOrEqual(1)
    expect(divider.borderStyle).toBe('solid')
    expect(divider.borderColor).toBe(divider.theme === 'dark' ? 'rgb(69, 72, 82)' : 'rgb(211, 213, 222)')
    expect(divider.boxSizing).toBe('border-box')
    expect(divider.pointerEvents).toBe('none')
    expect(divider.right).toBeCloseTo(divider.viewportWidth - geometry.area!.x - geometry.area!.width, 0)
    expect(geometry.area!.height).toBeCloseTo(56, 0)
    expect(geometry.area!.width).toBeGreaterThan(0)
    expect(geometry.toolbarHeight).toBeGreaterThanOrEqual(geometry.area!.height)
  } else {
    expect(divider.content).toBe('none')
  }
}

test('集成标题栏在浅深色、最大化和全屏往返时不新增全局行或遮挡工具按钮', async ({ userDataDir }) => {
  test.skip(process.platform !== 'win32', 'Native title bar overlay is enabled only on Windows')
  await withDesktop(userDataDir, async desktop => {
    const { page, window: nativeWindow } = desktop
    for (const theme of ['light', 'dark'] as const) {
      await configure(page, { language: 'en', theme, uiFontScale: 150, layoutMode: 'two-pane', workspaceWidth: 320 })
      await expectOverlayGeometry(page)
      await nativeWindow.evaluate(window => window.maximize())
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(true)
      await frames(page)
      await expectOverlayGeometry(page)
      await nativeWindow.evaluate(window => window.unmaximize())
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(false)
      await nativeWindow.evaluate(window => window.setContentSize(1280, 780))
      await frames(page)
      await expectOverlayGeometry(page)
    }
    // Exercise the actual smallest reader, not a narrow viewport that automatically hides its sidebar.
    await configure(page, { language: 'en', uiFontScale: 150, layoutMode: 'three-pane',
      sourcePaneWidth: SOURCE_PANE_WIDTH_MAX, articlePaneWidth: ARTICLE_PANE_WIDTH_MAX })
    await nativeWindow.evaluate(window => window.setContentSize(1200, 800))
    await frames(page)
    expect(await page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(1200)
    await expect(page.locator('.source-pane')).toBeVisible()
    await page.screenshot({ path: 'test-results/desktop-window-chrome-reader-three-pane-min.png' })
    await expectReaderControls(page, true)
    await configure(page, { layoutMode: 'two-pane', workspaceWidth: WORKSPACE_PANE_WIDTH_MAX })
    await nativeWindow.evaluate(window => window.setSize(960, 800))
    await frames(page)
    expect((await nativeWindow.evaluate(window => window.getBounds())).width).toBeGreaterThanOrEqual(960)
    // Windows may round the requested outer size by one DIP at 150% display scaling.
    expect((await nativeWindow.evaluate(window => window.getBounds())).width).toBeLessThanOrEqual(961)
    await page.screenshot({ path: 'test-results/desktop-window-chrome-reader-two-pane-min.png' })
    await expectReaderControls(page, true)
    await nativeWindow.evaluate(window => window.setFullScreen(true))
    await expect.poll(() => nativeWindow.evaluate(window => window.isFullScreen())).toBe(true)
    await frames(page)
    // Electron may hide the native controls and report a zero area in fullscreen.
    await expectOverlayGeometry(page, null)
    await nativeWindow.evaluate(window => window.setFullScreen(false))
    await expect.poll(() => nativeWindow.evaluate(window => window.isFullScreen())).toBe(false)
    await frames(page)
    await expectOverlayGeometry(page)
    await page.screenshot({ path: 'test-results/desktop-window-chrome-dark.png' })
  })
})

/** Query only this isolated Electron HWND; never move the real desktop cursor or send a click. */
async function nativeHitTests(desktop: Desktop, points: Point[], screenshotPath?: string): Promise<number[]> {
  const native = await desktop.window.evaluate(window => {
    const handle = window.getNativeWindowHandle()
    return { handle: handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE()),
      content: window.getContentBounds(), zoom: window.webContents.getZoomFactor() }
  })
  expect(native.zoom).toBe(1)
  const physical = await desktop.app.evaluate(({ screen }, points) => points.map(point => screen.dipToScreenPoint(point)),
    points.map(point => ({ x: Math.round(native.content.x + point.x), y: Math.round(native.content.y + point.y) })))
  const calls = physical.map(point => '[OrigReadChromeHitTest]::At(' + native.handle + ', ' + point.x + ', ' + point.y + ')').join('; ')
  const script = [
    screenshotPath ? "Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'" : "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class OrigReadChromeHitTest {',
    '  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, IntPtr l, uint f, uint t, out UIntPtr r);',
    '  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);',
    '  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);',
    '  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }',
    '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);',
    '  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);',
    '  public static int At(long handle, int x, int y) {',
    '    IntPtr h = new IntPtr(handle); if (!IsWindow(h)) throw new Exception("Test window is unavailable");',
    '    IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));',
    '    if (previousDpi == IntPtr.Zero) throw new Exception("Unable to enter physical-coordinate DPI context");',
    '    try {',
    '      long position = (x & 65535L) | ((y & 65535L) << 16); UIntPtr result;',
    '      if (SendMessageTimeout(h, 0x0084, UIntPtr.Zero, new IntPtr(position), 3, 2000, out result) == IntPtr.Zero)',
    '        throw new Exception("WM_NCHITTEST timed out");',
    '      return unchecked((int)result.ToUInt64());',
    '    } finally { SetThreadDpiAwarenessContext(previousDpi); }',
    '  }',
    ...(screenshotPath ? [
    '  public static bool Capture(long handle, string path) {',
    '    IntPtr h = new IntPtr(handle), previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));',
    '    if (previousDpi == IntPtr.Zero) return false;',
    '    try {',
    '      RECT rect; if (!IsWindow(h) || !GetWindowRect(h, out rect)) return false;',
    '      using (var bitmap = new System.Drawing.Bitmap(rect.Right - rect.Left, rect.Bottom - rect.Top)) {',
    '        using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {',
    '          IntPtr dc = graphics.GetHdc();',
    '          try { if (!PrintWindow(h, dc, 2)) return false; } finally { graphics.ReleaseHdc(dc); }',
    '        }',
    '        bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);',
    '      }',
    '      return true;',
    '    } finally { SetThreadDpiAwarenessContext(previousDpi); }',
    '  }',
    ] : []),
    '}',
    "'@",
    '$probeResults = @(' + calls + ')',
    '$captureSucceeded = ' + (screenshotPath ? "[OrigReadChromeHitTest]::Capture(" + native.handle + ", '" + screenshotPath.replaceAll("'", "''") + "')" : '$null'),
    '@{ hits = @($probeResults); captured = $captureSucceeded } | ConvertTo-Json -Compress'
  ].join('\n')
  try {
    const result = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: screenshotPath ? 5_000 : 15_000, windowsHide: true, maxBuffer: 100_000 })
    const { hits, captured } = JSON.parse(result.stdout.trim()) as { hits: number[]; captured: boolean | null }
    console.log('WINDOW_CHROME_NATIVE_COORDINATES ' + JSON.stringify({ physical, hits, ...(screenshotPath ? { screenshotPath, captured } : {}) }))
    return hits
  } catch (error) {
    if (!screenshotPath) throw error
    // A compositor that cannot print its window must not bypass the required native hit test.
    console.warn('WINDOW_CHROME_NATIVE_CAPTURE_UNAVAILABLE ' + screenshotPath)
    return nativeHitTests(desktop, points)
  }
}

async function center(locator: Locator): Promise<Point> {
  const rect = await locator.boundingBox()
  if (!rect) throw new Error('Expected a visible control')
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

async function emptyHeaderPoint(header: Locator): Promise<Point> {
  return header.evaluate(element => {
    const rect = element.getBoundingClientRect()
    for (let y = rect.top + 12; y < rect.bottom - 6; y += 8) {
      for (let x = rect.left + 8; x < rect.right - 8; x += 12) {
        const hit = document.elementFromPoint(x, y)
        if (hit && element.contains(hit) && !hit.closest('button, input, select, textarea, a, [role="button"], [contenteditable="true"]')) {
          return { x, y }
        }
      }
    }
    throw new Error('No unobstructed header drag point')
  })
}

test('Windows原生命中测试区分标题拖拽、应用按钮与系统窗口控件', async ({ userDataDir }) => {
  test.skip(process.platform !== 'win32', 'WM_NCHITTEST is Windows-only')
  await withDesktop(userDataDir, async desktop => {
    const { page } = desktop
    await configure(page, { language: 'en', theme: 'light', uiFontScale: 150, layoutMode: 'three-pane', sourcePaneWidth: 220 })
    await expectOverlayGeometry(page)
    const points = [
      await emptyHeaderPoint(page.locator('.source-pane > .brand-row')),
      await emptyHeaderPoint(page.locator('.article-scope-bar')),
      await emptyHeaderPoint(page.locator('.reader-toolbar')),
      await center(page.locator('.source-pane .source-discovery-button')),
      await center(page.locator('.source-pane .subscription-trigger')),
      await center(page.locator('.reader-toolbar .focus-reading-button')),
      await center(page.locator('.source-pane .search-field input'))
    ]
    const hits = await nativeHitTests(desktop, points)
    const geometry = await overlayGeometry(page)
    const viewportWidth = await page.evaluate(() => innerWidth)
    const controlStart = geometry.area!.x + geometry.area!.width
    const controlWidth = viewportWidth - controlStart
    expect(controlWidth).toBeGreaterThan(60)
    const y = geometry.area!.y + geometry.area!.height / 2
    const captionHits = await nativeHitTests(desktop, [
      { x: controlStart + controlWidth / 6, y },
      { x: controlStart + controlWidth / 2, y },
      { x: controlStart + controlWidth * 5 / 6, y }
    ])
    console.log('WINDOW_CHROME_NATIVE_HITS ' + JSON.stringify({ points, hits, captionHits, area: geometry.area,
      display: await desktop.app.evaluate(({ screen }) => ({ primaryScaleFactor: screen.getPrimaryDisplay().scaleFactor })),
      native: await desktop.window.evaluate(window => ({ bounds: window.getBounds(), content: window.getContentBounds(), zoom: window.webContents.getZoomFactor() })) }))
    expect(hits.slice(0, 3), 'Blank existing headers must be genuine native caption drag regions').toEqual([2, 2, 2])
    expect(hits.slice(3), 'Buttons and the search input must remain native client regions').toEqual([1, 1, 1, 1])
    expect(captionHits, 'The reserved area belongs to native minimize/maximize/close controls').toEqual([8, 9, 20])
    await page.locator('.source-pane .subscription-trigger').click()
    await page.locator('.source-pane .subscription-menu [role="menuitem"]').first().click()
    const dialog = page.locator('.source-dialog[aria-labelledby="add-source-title"]')
    await expect(dialog).toBeVisible()
    expect(await nativeHitTests(desktop, [await center(dialog.locator('input').first()), await center(dialog.locator('.dialog-close'))])).toEqual([1, 1])
    await dialog.locator('.dialog-close').click()
    for (const theme of ['light', 'dark'] as const) {
      await configure(page, { language: 'zh', theme })
      await page.locator('.settings-button').click()
      const back = page.locator('.settings-back-button')
      await expect(back).toBeVisible()
      // PrintWindow receives only this test's HWND; it never copies the desktop or another application.
      const screenshot = join(process.cwd(), 'test-results', 'desktop-window-chrome-settings-native-' + theme + '.png')
      expect(await nativeHitTests(desktop, [await center(back)], screenshot)).toEqual([1])
      await back.click()
      await expect(page.locator('.settings-layout')).toHaveCount(0)
    }
  })
})

async function originalFixture() {
  let baseUrl = ''
  const server = createServer((request, response) => {
    if (request.url === '/feed') {
      response.writeHead(200, { 'Content-Type': 'application/rss+xml' }).end(
        '<rss version="2.0"><channel><title>Chrome bounds fixture</title><link>' + baseUrl + '</link><description>Local window fixture</description>' +
        '<item><guid>chrome-bounds</guid><title>Chrome bounds article</title><link>' + baseUrl + '/article</link>' +
        '<description><![CDATA[<p>Cached reader body.</p>]]></description></item></channel></rss>')
    } else if (request.url === '/article') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<!doctype html><html><head><title>Original chrome fixture</title></head><body><h1>Local original article</h1><a href="/second">Second page</a></body></html>')
    } else response.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture HTTP port')
  baseUrl = 'http://127.0.0.1:' + address.port
  return { baseUrl, close: async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}

async function originalViews(desktop: Desktop, url: string) {
  return desktop.window.evaluate((window, url) => window.contentView.children.flatMap(view => {
    const candidate = view as typeof view & { webContents?: { id: number; getURL(): string } }
    return candidate.webContents?.getURL() === url ? [{ id: candidate.webContents.id, bounds: view.getBounds() }] : []
  }), url)
}

async function expectOriginalBounds(desktop: Desktop, url: string): Promise<number> {
  await frames(desktop.page)
  const stage = (await desktop.page.locator('.reader-stage').boundingBox())!
  const expected: Rect = { x: Math.round(stage.x), y: Math.round(stage.y), width: Math.round(stage.width), height: Math.round(stage.height) }
  await expect.poll(async () => (await originalViews(desktop, url)).map(view => view.bounds)).toEqual([expected])
  const toolbar = (await desktop.page.locator('.reader-toolbar').boundingBox())!
  expect(expected.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1)
  await expectOverlayGeometry(desktop.page, null)
  return (await originalViews(desktop, url))[0]!.id
}

test('设置以标题左侧返回恢复文章，150%中英文窄布局不会混淆原生关窗', async ({ userDataDir }) => {
  test.skip(process.platform !== 'win32', 'This regression targets the Windows native overlay')
  test.setTimeout(90_000)
  const fixture = await originalFixture()
  try {
    await withDesktop(userDataDir, async desktop => {
      const { page, window: nativeWindow } = desktop
      await page.evaluate(url => window.origread.addRssSource(url), fixture.baseUrl + '/feed')
      const windowId = await nativeWindow.evaluate(window => window.id)
      for (const language of ['en', 'zh'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          for (const layoutMode of ['three-pane', 'two-pane'] as const) {
            await test.step(language + '/' + theme + '/' + layoutMode, async () => {
              await nativeWindow.evaluate(window => window.setContentSize(1440, 900))
              await configure(page, { language, theme, uiFontScale: 150, layoutMode,
                sourcePaneWidth: SOURCE_PANE_WIDTH_MAX, articlePaneWidth: ARTICLE_PANE_WIDTH_MAX,
                workspaceWidth: WORKSPACE_PANE_WIDTH_MAX, sourcePaneCollapsed: false, articlePaneCollapsed: false, workspaceCollapsed: false })
              await nativeWindow.evaluate((window, threePane) => {
                if (threePane) window.setContentSize(1200, 800)
                else window.setSize(960, 800)
              }, layoutMode === 'three-pane')
              await frames(page)
              if (layoutMode === 'three-pane') {
                expect(await page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(1200)
                await expect(page.locator('.source-pane')).toBeVisible()
              } else {
                const width = (await nativeWindow.evaluate(window => window.getBounds())).width
                expect(width).toBeGreaterThanOrEqual(960)
                expect(width).toBeLessThanOrEqual(961)
              }
              const article = page.locator('.article-item', { hasText: 'Chrome bounds article' })
              await article.click()
              const selectedId = await article.getAttribute('data-article-id')
              await expect(page.locator('.article-body')).toContainText('Cached reader body.')
              await page.locator('.settings-button').click()
              await expect(page.locator('.settings-layout')).toBeVisible()
              const back = page.locator('.settings-back-button')
              await expect(back).toHaveAttribute('aria-label', language === 'zh' ? '返回阅读' : 'Back to reader')
              await expect(back.locator('span')).toHaveText(language === 'zh' ? '返回' : 'Back')
              await expect(back.locator('.lucide-arrow-left')).toHaveCount(1)
              await expectUnclippedControl(back, '.reader-pane')
              const placement = await back.evaluate(button => {
                const toolbar = button.parentElement!, title = toolbar.querySelector('.reader-title')!
                return { first: toolbar.firstElementChild === button,
                  beforeTitle: button.getBoundingClientRect().right <= title.getBoundingClientRect().left + 0.5 }
              })
              expect(placement).toEqual({ first: true, beforeTitle: true })
              await expect(page.locator('.reader-toolbar .reader-actions')).toHaveCount(0)
              await expect(page.locator('.reader-toolbar .lucide-x, .reader-toolbar .settings-close-button')).toHaveCount(0)
              await expectReaderControls(page)
              await page.screenshot({ path: 'test-results/desktop-window-chrome-settings-' + language + '-' + theme + '-' + layoutMode + '-150.png' })
              if (language === 'zh') {
                await back.focus()
                await expect(back).toBeFocused()
                await back.press('Enter')
              } else await back.click()
              expect(page.isClosed()).toBe(false)
              expect(await nativeWindow.evaluate(window => ({ id: window.id, destroyed: window.isDestroyed() })))
                .toEqual({ id: windowId, destroyed: false })
              await expect(page.locator('.settings-layout')).toHaveCount(0)
              await expect(page.locator('.article-item.selected')).toHaveAttribute('data-article-id', selectedId!)
              await expect(page.locator('.article-body')).toContainText('Cached reader body.')
            })
          }
        }
      }
    })
  } finally { await fixture.close() }
})

test('原文WebContentsView在新标题栏、缩放、最大化和设置遮罩下始终对齐reader-stage', async ({ userDataDir }) => {
  test.skip(process.platform !== 'win32', 'This regression targets the Windows native overlay')
  test.setTimeout(90_000)
  const fixture = await originalFixture()
  try {
    await withDesktop(userDataDir, async desktop => {
      const { page, window: nativeWindow } = desktop
      await configure(page, { language: 'en', theme: 'dark', uiFontScale: 150, layoutMode: 'three-pane', sourcePaneWidth: SOURCE_PANE_WIDTH_MAX, articlePaneWidth: ARTICLE_PANE_WIDTH_MAX })
      await page.evaluate(url => window.origread.addRssSource(url), fixture.baseUrl + '/feed')
      await page.reload()
      await page.locator('.source-item[title="Chrome bounds fixture"]').click()
      await page.locator('.article-item', { hasText: 'Chrome bounds article' }).click()
      await expect(page.locator('.article-body')).toContainText('Cached reader body.')
      await openOriginal(page)
      let originalId = await expectOriginalBounds(desktop, fixture.baseUrl + '/article')
      for (const width of [1280, 1200, 1050, 1440]) {
        await nativeWindow.evaluate((window, width) => window.setContentSize(width, 800), width)
        await frames(page)
        if (width === 1200) await page.screenshot({ path: 'test-results/desktop-window-chrome-original-three-pane-min.png' })
        expect(await expectOriginalBounds(desktop, fixture.baseUrl + '/article')).toBe(originalId)
        await expectReaderControls(page)
      }
      await nativeWindow.evaluate(window => window.maximize())
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(true)
      expect(await expectOriginalBounds(desktop, fixture.baseUrl + '/article')).toBe(originalId)
      await nativeWindow.evaluate(window => window.unmaximize())
      await expect.poll(() => nativeWindow.evaluate(window => window.isMaximized())).toBe(false)
      await page.locator('.reader-mode-button').click()
      await expect.poll(() => originalViews(desktop, fixture.baseUrl + '/article')).toEqual([])
      await configure(page, { layoutMode: 'two-pane', workspaceWidth: WORKSPACE_PANE_WIDTH_MAX })
      await nativeWindow.evaluate(window => window.setSize(960, 800))
      await frames(page)
      expect((await nativeWindow.evaluate(window => window.getBounds())).width).toBeGreaterThanOrEqual(960)
      // Windows may round the requested outer size by one DIP at 150% display scaling.
      expect((await nativeWindow.evaluate(window => window.getBounds())).width).toBeLessThanOrEqual(961)
      await page.locator('.article-item', { hasText: 'Chrome bounds article' }).click()
      await openOriginal(page)
      await page.screenshot({ path: 'test-results/desktop-window-chrome-original-two-pane-min.png' })
      originalId = await expectOriginalBounds(desktop, fixture.baseUrl + '/article')
      await expectReaderControls(page)
      await nativeWindow.evaluate(window => window.setContentSize(1440, 800))
      await frames(page)
      await page.locator('.settings-button').click()
      await expect(page.locator('.settings-layout')).toBeVisible()
      await expect.poll(() => originalViews(desktop, fixture.baseUrl + '/article')).toEqual([])
      await expect(page.locator('.settings-back-button')).toBeVisible()
      await page.locator('.settings-back-button').click()
      expect(await expectOriginalBounds(desktop, fixture.baseUrl + '/article')).toBe(originalId)
      await page.locator('.reader-mode-button').click()
      await expect.poll(() => originalViews(desktop, fixture.baseUrl + '/article')).toEqual([])
      await expect(page.locator('.article-body')).toContainText('Cached reader body.')
    })
  } finally { await fixture.close() }
})
