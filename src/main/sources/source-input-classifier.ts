export type SourceInputHint = 'RSS_LIKELY' | 'JSON_LIKELY' | 'GENERIC'

export function sourceInputHint(url: string): SourceInputHint {
  const rssScore = rssHintScore(url)
  const jsonScore = jsonHintScore(url)
  if (rssScore > jsonScore) return 'RSS_LIKELY'
  if (jsonScore > rssScore) return 'JSON_LIKELY'
  return 'GENERIC'
}

export function isKnownRssHubEndpoint(url: string, knownInstances: readonly string[] = []): boolean {
  try {
    const trimmed = url.trim().replace(/\/+$/, '')
    if (!trimmed) return false
    const bases = [...new Set([
      'https://rsshub.app',
      'http://rsshub.app',
      ...knownInstances.map((item) => item.trim().replace(/\/+$/, '')).filter(Boolean)
    ])]
    return bases.some((base) => {
      if (trimmed.toLowerCase() === base.toLowerCase()) return false
      if (!trimmed.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return false
      const routePart = trimmed.slice(base.length).replace(/^\/+/, '')
      return Boolean(routePart)
        && routePart.toLowerCase() !== 'healthz'
        && routePart.toLowerCase() !== 'favicon.ico'
    })
  } catch {
    return false
  }
}

function rssHintScore(value: string): number {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.toLowerCase().replace(/\/+$/, '')
    const query = url.searchParams.toString().toLowerCase()
    let score = 0
    if (host === 'feeds.feedburner.com' || host === 'feedproxy.google.com') score += 5
    if (/\.(?:xml|rss|atom|rdf)$/.test(path)) score += 4
    if (path.includes('/feeds/posts/default')) score += 4
    if (/(?:^|&)(?:format|output|type)=(?:rss|atom|xml)(?:&|$)/.test(query)) score += 4
    if (['/feed', '/rss', '/atom'].some((suffix) => path === suffix || path.endsWith(suffix))) score += 1
    return score
  } catch {
    return 0
  }
}

function jsonHintScore(value: string): number {
  try {
    const url = new URL(value)
    const path = url.pathname.toLowerCase()
    const query = url.searchParams.toString().toLowerCase()
    let score = 0
    if (path.includes('/wp-json/')) score += 5
    if (path.endsWith('.json')) score += 4
    if (/(?:^|&)(?:format|output)=json(?:&|$)/.test(query)) score += 4
    if (path.startsWith('/api/') || path.includes('/api/')) score += 2
    return score
  } catch {
    return 0
  }
}
