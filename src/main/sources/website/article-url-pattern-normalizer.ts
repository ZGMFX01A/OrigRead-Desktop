export interface ArticleUrlPattern {
  key: string
  pathDepth: number
  dynamicPartCount: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_RE = /^[0-9a-f]{8,}$/i
const MIXED_TOKEN_RE = /^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{12,}$/i
const YEAR_RE = /^(?:19|20)\d{2}$/
const IGNORED_QUERY_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'spm', 'from', 'ref', 'source'])
const ARTICLE_ID_QUERY_KEYS = new Set(['id', 'aid', 'articleid', 'article_id', 'newsid', 'news_id', 'post', 'postid', 'post_id', 'contentid', 'content_id'])

export function normalizeArticleUrlPattern(url: string, expectedHost: string): ArticleUrlPattern | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const linkHost = normalizeHost(parsed.hostname)
  const sourceHost = normalizeHost(expectedHost)
  if (!linkHost || !sourceHost || !isSameSite(linkHost, sourceHost)) return null

  const normalizedSegments: string[] = []
  let dynamicPartCount = 0
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    const normalized = normalizePathSegment(segment, normalizedSegments)
    normalizedSegments.push(normalized)
    if (normalized.includes('{')) dynamicPartCount += 1
  }
  const normalizedPath = normalizedSegments.length > 0 ? `/${normalizedSegments.join('/')}` : '/'
  const normalizedQuery = normalizeQuery(parsed.search.length > 1 ? parsed.search.slice(1) : '')
  dynamicPartCount += [...normalizedQuery].filter((character) => character === '{').length

  return {
    key: `${sourceHost}${normalizedPath}${normalizedQuery ? `?${normalizedQuery}` : ''}`,
    pathDepth: normalizedSegments.length,
    dynamicPartCount
  }
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.$/, '').toLowerCase().replace(/^www\./, '')
}

function isSameSite(linkHost: string, sourceHost: string): boolean {
  return linkHost === sourceHost || linkHost.endsWith(`.${sourceHost}`) || sourceHost.endsWith(`.${linkHost}`)
}

function normalizePathSegment(segment: string, previousSegments: string[]): string {
  const lastDot = segment.lastIndexOf('.')
  const extensionIndex = lastDot > 0 && lastDot < segment.length - 1 ? lastDot : -1
  const base = extensionIndex >= 0 ? segment.slice(0, extensionIndex) : segment
  const extension = extensionIndex >= 0 ? segment.slice(extensionIndex).toLowerCase() : ''
  return `${normalizeDynamicValue(base, previousSegments)}${extension}`
}

function normalizeDynamicValue(value: string, previousSegments: string[] = []): string {
  const lower = value.toLowerCase()
  if (!lower) return ''
  if (UUID_RE.test(lower)) return '{uuid}'
  if (YEAR_RE.test(lower)) return '{year}'
  if (/^\d+$/.test(lower)) return normalizeNumber(lower, previousSegments)
  if (HEX_RE.test(lower)) return '{hash}'
  if (MIXED_TOKEN_RE.test(lower)) return '{token}'
  if (looksLikeSlug(lower)) return '{slug}'
  return lower
}

function normalizeNumber(value: string, previousSegments: string[]): string {
  const number = Number(value)
  if (previousSegments.at(-1) === '{year}' && number >= 1 && number <= 12) return '{month}'
  if (previousSegments.slice(-2).join('/') === '{year}/{month}' && number >= 1 && number <= 31) return '{day}'
  return '{number}'
}

function looksLikeSlug(value: string): boolean {
  const letterCount = [...value].filter((character) => /[a-z]/i.test(character)).length
  const separatorCount = [...value].filter((character) => character === '-' || character === '_').length
  return letterCount >= 6 && (separatorCount >= 1 || value.length >= 24)
}

function normalizeQuery(rawQuery: string): string {
  if (!rawQuery) return ''
  const entries: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const pair of rawQuery.split('&')) {
    const separator = pair.indexOf('=')
    const key = (separator >= 0 ? pair.slice(0, separator) : pair).trim().toLowerCase()
    if (!key || IGNORED_QUERY_KEYS.has(key)) continue
    const rawValue = separator >= 0 ? pair.slice(separator + 1).trim() : ''
    const normalizedValue = ARTICLE_ID_QUERY_KEYS.has(key)
      ? normalizeArticleIdQueryValue(rawValue)
      : normalizeDynamicValue(rawValue)
    const signature = `${key}\u0000${normalizedValue}`
    if (!seen.has(signature)) {
      seen.add(signature)
      entries.push([key, normalizedValue])
    }
  }
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
    .map(([key, value]) => value ? `${key}=${value}` : key)
    .join('&')
}

function normalizeArticleIdQueryValue(value: string): string {
  if (/^\d+$/.test(value) && value.length > 0) return '{number}'
  if (UUID_RE.test(value)) return '{uuid}'
  return '{id}'
}

