import type { DiscoveredRssFeed } from './rss'

export interface RssHubRouteCatalogData {
  schemaVersion: number
  source: string
  license: string
  generatedAt?: string | null
  routeCount?: number | null
  routes: RssHubRouteDefinition[]
}

export interface RssHubRouteDefinition {
  id: string
  name: string
  host: string
  pathPrefix: string
  target: string
  sourcePathTemplate?: string | null
  sourceQueryTemplate?: string | null
}

export interface RssHubRouteMatch {
  route: RssHubRouteDefinition
  feedUrl: string | null
  parameters: Record<string, string>
  missingParameters: string[]
  resolved: boolean
}

export type RssHubCandidateState =
  | 'available'
  | 'needs_input'
  | 'timeout'
  | 'network_unavailable'
  | 'invalid_content'
  | 'unsupported'

export interface RssHubProbeResult {
  match: RssHubRouteMatch
  state: RssHubCandidateState
  feed: DiscoveredRssFeed | null
  message: string | null
  available: boolean
}

export interface RssHubInstance {
  id: string
  url: string
  location: string
  maintainer: string
  enabled: boolean
  builtIn: boolean
}

export interface RssHubSettings {
  enabled: boolean
  instances: RssHubInstance[]
}

export type RssHubUiLanguage = 'zh' | 'en'

const RSS_HUB_REGION_LABELS: Record<string, { zh: string; en: string }> = {
  US: { zh: '🇺🇸 美国', en: 'US United States' },
  AE: { zh: '🇦🇪 阿联酋', en: 'AE United Arab Emirates' },
  FR: { zh: '🇫🇷 法国', en: 'FR France' },
  DE: { zh: '🇩🇪 德国', en: 'DE Germany' },
  CA: { zh: '🇨🇦 加拿大', en: 'CA Canada' },
  GB: { zh: '🇬🇧 英国', en: 'GB United Kingdom' },
  HK: { zh: '🇭🇰 香港', en: 'HK Hong Kong' },
  VN: { zh: '🇻🇳 越南', en: 'VN Vietnam' },
  CN: { zh: '🇨🇳 中国', en: 'CN China' },
  GLOBAL: { zh: '🌐 多地负载均衡', en: 'Global load balancing' }
}

const BUILT_IN_RSS_HUB_REGION_BY_ID: Record<string, string> = {
  official: 'US',
  rssforever: 'AE',
  slarker: 'US',
  pseudoyu: 'FR',
  rsstips: 'US',
  ktachibana: 'US',
  owonz: 'DE',
  wudifeixue: 'CA',
  henry: 'GB',
  umzzz: 'HK',
  isrss: 'US',
  emailonce: 'HK',
  datuan: 'VN',
  cups: 'US',
  spriple: 'CN',
  virworks: 'GLOBAL'
}

const LEGACY_RSS_HUB_REGION_ALIASES: Array<[string, string]> = [
  ['多地负载均衡', 'GLOBAL'],
  ['阿联酋', 'AE'],
  ['加拿大', 'CA'],
  ['美国', 'US'],
  ['法国', 'FR'],
  ['德国', 'DE'],
  ['英国', 'GB'],
  ['香港', 'HK'],
  ['越南', 'VN'],
  ['中国', 'CN']
]

/**
 * RSSHub 实例地区在存储层使用中立代码，避免某一端的 UI 语言写进共享备份。
 * 旧版已经持久化的中文地区名会在读取时自动规范化。
 */
export function canonicalRssHubLocation(instanceId: string, location: string): string {
  const builtIn = BUILT_IN_RSS_HUB_REGION_BY_ID[instanceId]
  if (builtIn) return builtIn
  const trimmed = location.trim()
  if (!trimmed) return ''
  const upper = trimmed.toUpperCase()
  if (RSS_HUB_REGION_LABELS[upper]) return upper
  const legacy = LEGACY_RSS_HUB_REGION_ALIASES.find(([label]) => trimmed.includes(label))
  return legacy?.[1] ?? trimmed
}

export function formatRssHubLocation(location: string, language: RssHubUiLanguage): string {
  const canonical = canonicalRssHubLocation('', location)
  const localized = RSS_HUB_REGION_LABELS[canonical]
  if (localized) return localized[language]
  if (language === 'en' && /[\u3400-\u9fff]/.test(canonical)) {
    return canonical.replace(/[\u3400-\u9fff]+/g, '').replace(/\s+/g, ' ').trim()
  }
  return canonical
}
