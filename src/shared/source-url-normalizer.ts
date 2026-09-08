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
 * Comparison-only source URL normalization. Keep business query parameters and their order intact;
 * only remove transformations that cannot change source semantics. Mirrors Android SourceUrlNormalizer.
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

  const hostname = url.hostname.toLowerCase()
  const port = url.port && !((protocol === 'http:' && url.port === '80') || (protocol === 'https:' && url.port === '443'))
    ? `:${url.port}`
    : ''
  const auth = url.username || url.password
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : ''
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search
  const query = normalizeQuery(rawQuery)
  return `${protocol}//${auth}${hostname}${port}${path}${query ? `?${query}` : ''}`
}

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
