const FALLBACK_CHROME_VERSION = '120.0.0.0'

/**
 * Source discovery and webpage parsing must behave like a normal desktop browser.
 *
 * Do not reuse an app/bot UA here. Several sites (cls.cn is a confirmed example)
 * either reject non-browser clients or redirect mobile/WebView identities to an
 * "open app" landing page, which makes the parser inspect the wrong document.
 *
 * Electron exposes the Chromium version through process.versions.chrome, so the
 * UA stays aligned with the bundled browser engine instead of hard-coding the
 * Chrome version in multiple call sites.
 */
export function desktopBrowserUserAgent(
  chromeVersion = process.versions.chrome ?? FALLBACK_CHROME_VERSION,
  platform: NodeJS.Platform = process.platform
): string {
  const platformToken = platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : platform === 'linux'
      ? 'X11; Linux x86_64'
      : 'Windows NT 10.0; Win64; x64'

  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

export const DESKTOP_BROWSER_USER_AGENT = desktopBrowserUserAgent()
