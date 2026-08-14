import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RssHubRouteCatalogData, RssHubRouteDefinition } from '../../../shared/rsshub'

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2])

export function loadBundledRssHubRoutes(): RssHubRouteDefinition[] {
  return loadRssHubRoutes(join(__dirname, '../../resources/rsshub_routes.json'))
}

export function loadRssHubRoutes(path: string): RssHubRouteDefinition[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RssHubRouteCatalogData
  if (!SUPPORTED_SCHEMA_VERSIONS.has(parsed.schemaVersion)) {
    throw new Error(`不支持的 RSSHub 路由目录版本：${parsed.schemaVersion}`)
  }
  if (parsed.routeCount != null && parsed.routeCount !== parsed.routes.length) {
    throw new Error('RSSHub 路由目录数量校验失败')
  }
  return parsed.routes
}
