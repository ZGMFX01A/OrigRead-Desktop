export interface DynamicWebsiteRenderResult {
  finalUrl: string
  html: string
}

export interface DynamicWebsiteRenderer {
  render(url: string): Promise<DynamicWebsiteRenderResult>
}

export function requiresInteractiveVerification(targetUrl: string): boolean {
  try {
    const url = new URL(targetUrl)
    return url.hostname.toLowerCase() === 'mp.weixin.qq.com'
      && url.pathname.toLowerCase().includes('wappoc_appmsgcaptcha')
  } catch {
    return false
  }
}

export function isAllowedDynamicNavigation(initialUrl: string, targetUrl: string): boolean {
  try {
    const initial = new URL(initialUrl)
    const target = new URL(targetUrl)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    const initialHost = normalizeHost(initial.hostname)
    const targetHost = normalizeHost(target.hostname)
    return Boolean(initialHost && targetHost) && (
      initialHost === targetHost
      || initialHost.endsWith(`.${targetHost}`)
      || targetHost.endsWith(`.${initialHost}`)
    )
  } catch {
    return false
  }
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, '').toLowerCase().replace(/^www\./, '')
}

