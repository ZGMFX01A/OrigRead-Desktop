// 这些广告跟踪参数不决定订阅内容，可在比较地址时移除。
const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'spm'
])

/**
 * 仅用于比较订阅地址；保留业务参数及非根路径的斜杠，避免合并服务器上的不同资源。
 */
export function sourceUrlComparisonKey(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') return trimmed

  // URL 本身已移除 HTTP / HTTPS 默认端口，host 同时保留 IPv6 方括号和非默认端口。
  const host = url.host.toLowerCase()
  const auth = authorityCredentials(url)
  const path = url.pathname === '/' ? '' : url.pathname
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search
  const query = normalizeQuery(rawQuery)
  return `${protocol}//${auth}${host}${path}${query ? `?${query}` : ''}`
}

/** 用户信息参与来源身份比较，不能把不同凭据的订阅合并。 */
function authorityCredentials(url: URL): string {
  if (!url.username && !url.password) return ''
  return `${url.username}${url.password ? `:${url.password}` : ''}@`
}

/** 只移除跟踪参数，业务参数及其顺序保持原样。 */
function normalizeQuery(rawQuery: string): string {
  if (!rawQuery.trim()) return ''
  return rawQuery
    .split('&')
    .filter((pair) => {
      const rawKey = pair.split('=', 1)[0]?.trim().toLowerCase() ?? ''
      return rawKey.length > 0 && !rawKey.startsWith('utm_') && !TRACKING_QUERY_KEYS.has(rawKey)
    })
    .join('&')
}
