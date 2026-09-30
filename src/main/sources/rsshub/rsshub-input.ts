import type { RssHubExplicitRoute } from '../../../shared/rsshub'
import { normalizeRssHubInstanceUrl } from './rsshub-route-matcher'

/** Parse RSSHub logical input before the generic HTTP(S) URL normalizer touches it. */
export function parseExplicitRssHubInput(
  input: string,
  knownInstances: readonly string[] = []
): RssHubExplicitRoute | null {
  const trimmed = input.trim()
  if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed)) return null
  const logical = parseLogicalScheme(trimmed)
  if (logical) return logical
  return parseKnownInstanceUrl(trimmed, knownInstances)
}

export function normalizeRssHubRoutePath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('#') || /[\u0000-\u0020\u007f]/.test(trimmed) || /%(?![0-9a-f]{2})/i.test(trimmed)) return null
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const path = normalized.split('?')[0]!
  if (path.startsWith('//') || path.includes('\\')) return null
  if (/%5c/i.test(path) || path.includes('://')) return null
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0 || hasTraversal(path)) return null
  return normalized
}

export function buildRssHubFeedUrl(instanceBaseUrl: string, routePath: string): string {
  const instance = normalizeRssHubInstanceUrl(instanceBaseUrl)
  const route = normalizeRssHubRoutePath(routePath)
  if (!instance) throw new TypeError(`Invalid RSSHub instance: ${instanceBaseUrl}`)
  if (!route) throw new TypeError(`Invalid RSSHub route: ${routePath}`)
  return `${instance}${route}`
}

export function rssHubRouteFamily(routePath: string): string {
  const path = routePath.split('?')[0]!
  const segments = path.split('/').filter(Boolean)
  return segments.slice(0, 3).join('/') || 'root'
}

export function requiresBoundInstance(routePath: string): boolean {
  try {
    const url = new URL(`https://route.invalid${routePath.startsWith('/') ? routePath : `/${routePath}`}`)
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase()
      if (lower === 'key' || lower === 'code') return true
    }
    return false
  } catch {
    return false
  }
}

function hasTraversal(path: string): boolean {
  return path.split('/').some((segment) => {
    const dots = segment.replace(/%2e/gi, '.')
    return dots === '.' || dots === '..'
  })
}

function parseLogicalScheme(input: string): RssHubExplicitRoute | null {
  // Logical input is a route, not a network URL. Preserve the raw authority,
  // path and query so dot segments and control characters cannot disappear.
  const parts = /^rsshub:\/\/([^/?#]*)([^#]*)$/i.exec(input)
  const authority = parts?.[1]
  if (!authority || /[@:/?#\\\u0000-\u001f\u007f]/.test(authority)) return null
  const route = normalizeRssHubRoutePath(`/${authority}${parts![2]}`)
  return route ? { routePath: route, originalInput: input, preferredInstance: null } : null
}

function parseKnownInstanceUrl(input: string, knownInstances: readonly string[]): RssHubExplicitRoute | null {
  const completed = input.startsWith('//') ? `https:${input}` : input.includes('://') ? input : `https://${input}`
  const rawPath = /^[^:]+:\/\/[^/?#]*([^?#]*)/.exec(completed)?.[1] ?? ''
  // WHATWG URL removes dot segments before exposing pathname; validate them first.
  if (input.includes('#') || hasTraversal(rawPath) || rawPath.includes('\\')) return null
  let inputUrl: URL
  try {
    inputUrl = new URL(completed)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(inputUrl.protocol)) return null

  const bases = [...new Set([
    'https://rsshub.app',
    'http://rsshub.app',
    ...knownInstances
  ].map(normalizeRssHubInstanceUrl).filter((value): value is string => Boolean(value)))]
    .sort((a, b) => {
      const aPath = new URL(a).pathname.replace(/\/+$/, '')
      const bPath = new URL(b).pathname.replace(/\/+$/, '')
      return bPath.length - aPath.length
    })

  for (const base of bases) {
    const baseUrl = new URL(base)
    if (inputUrl.protocol !== baseUrl.protocol || inputUrl.hostname !== baseUrl.hostname || inputUrl.port !== baseUrl.port) continue
    const basePath = baseUrl.pathname.replace(/\/+$/, '') === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '')
    if (basePath && inputUrl.pathname !== basePath && !inputUrl.pathname.startsWith(`${basePath}/`)) continue
    const remainder = basePath ? inputUrl.pathname.slice(basePath.length) : inputUrl.pathname
    // 更具体的挂载路径匹配时，若无实际 route 则不能回退到更短根路径将挂载前缀当 route。
    if (!remainder || remainder === '/') return null
    const route = normalizeRssHubRoutePath(`${remainder.startsWith('/') ? remainder : `/${remainder}`}${inputUrl.search}`)
    if (!route) continue
    const routeOnly = route.split('?')[0]!.replace(/^\/+|\/+$/g, '').toLowerCase()
    if (routeOnly === 'healthz' || routeOnly === 'favicon.ico') continue
    return { routePath: route, originalInput: input, preferredInstance: base }
  }
  return null
}
