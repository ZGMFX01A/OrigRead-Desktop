import type { FeedCatalogEntry } from './source-catalog'
import { sourceCategorySearchTerms } from './source-catalog'

export interface FeedCatalogUrlMatch {
  preferred: FeedCatalogEntry | null
  suggestions: FeedCatalogEntry[]
  totalSuggestions: number
}

/**
 * Desktop 对齐 Android FeedCatalogIndex：
 * - 2k+ 内置目录使用预计算搜索文本；
 * - URL 只做保守匹配，完整 Feed URL / 唯一完整 Site URL 才可成为 preferred；
 * - 同域名仅给候选，不自动替换用户输入。
 */
export class FeedCatalogIndex {
  static readonly MAX_URL_SUGGESTIONS = 8

  private readonly allFeeds: FeedCatalogEntry[]
  private readonly searchBlobs = new Map<string, string>()
  private readonly feedUrlIndex = new Map<string, FeedCatalogEntry[]>()
  private readonly siteUrlIndex = new Map<string, FeedCatalogEntry[]>()
  private readonly hostIndex = new Map<string, FeedCatalogEntry[]>()

  constructor(feeds: FeedCatalogEntry[]) {
    this.allFeeds = [...feeds]
    for (const feed of this.allFeeds) {
      this.searchBlobs.set(feed.id, buildSearchBlob(feed))
      appendIndex(this.feedUrlIndex, catalogComparisonKey(feed.feedUrl), feed)
      if (feed.siteUrl?.trim()) appendIndex(this.siteUrlIndex, catalogComparisonKey(feed.siteUrl), feed)
      for (const host of new Set([normalizedHost(feed.feedUrl), normalizedHost(feed.siteUrl)].filter(Boolean) as string[])) {
        appendIndex(this.hostIndex, host, feed)
      }
    }
  }

  search(query: string, selectedCategory: string | null = null): FeedCatalogEntry[] {
    const rawQuery = query.trim().toLocaleLowerCase()
    const normalizedUrlQuery = normalizeUrlSearchText(query)
    return this.allFeeds.filter((feed) => {
      if (selectedCategory && !feed.categories.includes(selectedCategory)) return false
      if (!rawQuery) return true
      const blob = this.searchBlobs.get(feed.id) ?? ''
      return blob.includes(rawQuery) || Boolean(normalizedUrlQuery && blob.includes(normalizedUrlQuery))
    })
  }

  matchUrl(rawUrl: string): FeedCatalogUrlMatch {
    const comparisonKey = catalogComparisonKey(rawUrl)
    const exactFeedMatches = distinctEntries(this.feedUrlIndex.get(comparisonKey) ?? [])
    if (exactFeedMatches.length > 0) {
      return { preferred: exactFeedMatches[0]!, suggestions: [], totalSuggestions: 0 }
    }

    const exactSiteMatches = distinctEntries(this.siteUrlIndex.get(comparisonKey) ?? [])
    if (exactSiteMatches.length === 1) {
      return { preferred: exactSiteMatches[0]!, suggestions: exactSiteMatches, totalSuggestions: 1 }
    }
    if (exactSiteMatches.length > 1) {
      return {
        preferred: null,
        suggestions: exactSiteMatches.slice(0, FeedCatalogIndex.MAX_URL_SUGGESTIONS),
        totalSuggestions: exactSiteMatches.length
      }
    }

    const host = normalizedHost(rawUrl)
    if (!host) return emptyFeedCatalogUrlMatch()
    const hostMatches = distinctEntries(this.hostIndex.get(host) ?? [])
    return {
      preferred: null,
      suggestions: hostMatches.slice(0, FeedCatalogIndex.MAX_URL_SUGGESTIONS),
      totalSuggestions: hostMatches.length
    }
  }
}

export function preferredCatalogProbeUrl(match: FeedCatalogUrlMatch, inputUrl: string): string | null {
  const preferred = match.preferred?.feedUrl
  if (!preferred) return null
  return catalogComparisonKey(preferred) === catalogComparisonKey(inputUrl) ? null : preferred
}

export function emptyFeedCatalogUrlMatch(): FeedCatalogUrlMatch {
  return { preferred: null, suggestions: [], totalSuggestions: 0 }
}

export function catalogComparisonKey(value: string): string {
  return normalizeUrlSearchText(sourceUrlComparisonKey(value))
}

export function normalizeUrlSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

function sourceUrlComparisonKey(value: string): string {
  const trimmed = value.trim()
  try {
    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(normalized)
    if (!['http:', 'https:'].includes(url.protocol)) return trimmed
    url.hostname = url.hostname.toLocaleLowerCase()
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = ''
    url.hash = ''
    const trackingKeys = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'spm'])
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLocaleLowerCase().startsWith('utm_') || trackingKeys.has(key.toLocaleLowerCase())) url.searchParams.delete(key)
    }
    url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return url.toString().replace(/\?$/, '').replace(/\/$/, '')
  } catch {
    return trimmed
  }
}

function normalizedHost(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const normalized = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
    return new URL(normalized).hostname.toLocaleLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

function appendIndex(index: Map<string, FeedCatalogEntry[]>, key: string, feed: FeedCatalogEntry): void {
  const items = index.get(key)
  if (items) items.push(feed)
  else index.set(key, [feed])
}

function distinctEntries(entries: FeedCatalogEntry[]): FeedCatalogEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => !seen.has(entry.id) && Boolean(seen.add(entry.id)))
}

function buildSearchBlob(feed: FeedCatalogEntry): string {
  const values = [feed.name, feed.feedUrl, normalizeUrlSearchText(feed.feedUrl)]
  if (feed.siteUrl?.trim()) values.push(feed.siteUrl, normalizeUrlSearchText(feed.siteUrl))
  for (const category of feed.categories) values.push(category, ...sourceCategorySearchTerms(category))
  for (const origin of feed.origins) values.push(origin.category, origin.sourceId)
  return values.map((value) => value.toLocaleLowerCase()).join('\n')
}
