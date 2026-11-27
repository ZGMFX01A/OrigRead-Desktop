export interface RendererTrustPolicy {
  developmentUrl?: string | null
  productionUrl: string
}

export interface DesktopRuntimeOverrides {
  isDevelopment: boolean
  rendererUrl: string | null
  e2eUserDataDir: string | null
  e2eDownloadDir: string | null
  updateApiBase: string
  disableAutoUpdateCheck: boolean
  disablePeriodicSync: boolean
}

function httpUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value?.trim() ?? '')
    return url.protocol === 'http:' || url.protocol === 'https:' ? value!.trim() : null
  } catch {
    return null
  }
}

export function resolveRuntimeOverrides(isPackaged: boolean, env: NodeJS.ProcessEnv): DesktopRuntimeOverrides {
  // 打包产物不接受任何开发/E2E 环境覆盖。
  const rendererUrl = isPackaged ? null : httpUrl(env.ELECTRON_RENDERER_URL)
  return {
    isDevelopment: Boolean(rendererUrl),
    rendererUrl,
    e2eUserDataDir: isPackaged ? null : env.ORIGREAD_E2E_USER_DATA_DIR?.trim() || null,
    e2eDownloadDir: isPackaged ? null : env.ORIGREAD_E2E_DOWNLOAD_DIR?.trim() || null,
    updateApiBase: isPackaged ? 'https://api.github.com' : httpUrl(env.ORIGREAD_UPDATE_API_BASE) ?? 'https://api.github.com',
    disableAutoUpdateCheck: !isPackaged && env.ORIGREAD_DISABLE_AUTO_UPDATE_CHECK === '1',
    disablePeriodicSync: !isPackaged && env.ORIGREAD_DISABLE_PERIODIC_SYNC === '1'
  }
}

function hasUnsafeFilePath(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0] ?? ''
  return /\\|%2e|%2f|%5c/i.test(path) || path.split('/').some((part) => part === '.' || part === '..')
}

export function isAllowedRendererUrl(value: string, policy: RendererTrustPolicy, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const sender = new URL(value)
    const developmentUrl = policy.developmentUrl?.trim()
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return (expected.protocol === 'http:' || expected.protocol === 'https:')
        && (sender.protocol === 'http:' || sender.protocol === 'https:')
        && sender.origin === expected.origin
    }

    const expected = new URL(policy.productionUrl)
    if (sender.protocol !== 'file:' || expected.protocol !== 'file:'
      || hasUnsafeFilePath(value) || hasUnsafeFilePath(policy.productionUrl)) return false
    const normalize = (text: string): string => platform === 'win32' ? text.toLowerCase() : text
    return normalize(sender.host) === normalize(expected.host)
      && normalize(decodeURIComponent(sender.pathname)) === normalize(decodeURIComponent(expected.pathname))
  } catch {
    return false
  }
}

export function isTrustedIpcSender(
  event: { sender: unknown; senderFrame?: { url?: string } | null },
  mainWebContents: { isDestroyed(): boolean; mainFrame?: unknown } | null,
  policy: RendererTrustPolicy,
  platform: NodeJS.Platform = process.platform
): boolean {
  return mainWebContents !== null && !mainWebContents.isDestroyed()
    && event.sender === mainWebContents
    && event.senderFrame != null && event.senderFrame === mainWebContents.mainFrame
    && isAllowedRendererUrl(event.senderFrame.url ?? '', policy, platform)
}
