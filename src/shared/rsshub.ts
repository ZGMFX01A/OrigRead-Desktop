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
