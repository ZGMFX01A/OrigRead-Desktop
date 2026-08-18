import type { JsonRule } from '../../../shared/json-source'

export function createWordPressCandidates(siteUrl: string): JsonRule[] {
  const uri = new URL(siteUrl)
  const host = uri.hostname
  if (!host) throw new Error('WordPress 地址缺少域名')
  const origin = `${uri.protocol}//${uri.host}`
  const path = uri.pathname.replace(/^\/+|\/+$/g, '')
  const bases = [...new Set([...(path ? [`${origin}/${path}`] : []), origin])]

  return bases.map((base, index) => ({
    ...createWordPressRule(siteUrl),
    id: `wordpress-${host.toLowerCase()}-${index}`,
    endpoint: `${base}/wp-json/wp/v2/posts?_embed=1&per_page=30`
  }))
}

export function createWordPressRule(siteUrl: string): JsonRule {
  const uri = new URL(siteUrl)
  const host = uri.hostname
  if (!host) throw new Error('WordPress 地址缺少域名')
  const siteBase = `${uri.protocol}//${uri.host}`
  return {
    id: `wordpress-${host.toLowerCase()}`,
    name: `WordPress · ${host}`,
    version: 1,
    enabled: true,
    hosts: [host],
    sourceKind: 'API',
    endpoint: `${siteBase}/wp-json/wp/v2/posts?_embed=1&per_page=30`,
    itemsPath: '$[*]',
    titlePath: '$.title.rendered',
    linkPath: '$.link',
    datePath: '$.date_gmt',
    authorPath: null,
    // WordPress REST 的 excerpt 只是列表摘要；Reader 首屏应直接复用 API 已返回的完整正文，
    // 避免用户明明订阅了 JSON/API 来源，打开文章却只看到标题/短摘要。
    descriptionPath: '$.content.rendered',
    imagePath: null,
    idPath: '$.id',
    dateFormat: "yyyy-MM-dd'T'HH:mm:ss",
    maxItems: 30
  }
}

export function createWordPressRuleFromEndpoint(endpointUrl: string): JsonRule | null {
  let uri: URL
  try {
    uri = new URL(endpointUrl)
  } catch {
    return null
  }
  if (!uri.pathname.includes('/wp-json/wp/v2/posts')) return null
  try {
    return { ...createWordPressRule(endpointUrl), endpoint: endpointUrl }
  } catch {
    return null
  }
}
