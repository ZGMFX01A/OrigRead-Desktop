import type { DiscoveredRssFeed } from '../../shared/rss'
import type { JsonSourceProbeResult } from '../../shared/json-source'
import type { RssHubProbeResult } from '../../shared/rsshub'
import type { WebsiteInspectionResult } from '../../shared/website'
import type { AccountRecord } from '../../shared/account'
import type { SourceDiscoveryStage, SourceDiscoveryStageState } from '../../shared/source-discovery'
import type { UnscoredSourceCandidate } from './source-candidate-scorer'
import type { FeedCatalogUrlMatch } from '../../shared/feed-catalog-index'
import type { FeedDiscoveryCatalog } from '../discovery/feed-discovery-catalog'
import type { RssDiscoveryService } from './rss/rss-discovery-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import type { RssHubResolver } from './rsshub/rsshub-resolver'
import type { RssHubSubscriptionService } from './rsshub/rsshub-subscription-service'
import type { JsonSourceService } from './json/json-source-service'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { WebsiteSourceService } from './website/website-source-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'

export type CandidatePayload =
  | { type: 'rss'; discovered: DiscoveredRssFeed }
  | { type: 'rsshub'; sourceUrl: string; result: RssHubProbeResult; preferredInstance: string | null }
  | { type: 'json'; probe: JsonSourceProbeResult }
  | { type: 'website'; inspection: WebsiteInspectionResult; dynamic: boolean }

export type ProgressReporter = (stage: SourceDiscoveryStage, state: SourceDiscoveryStageState) => void
export interface StageOutcome<T> { value: T | null; error: string | null }
export interface DiscoveryOutcome {
  candidates: UnscoredSourceCandidate[]
  payloads: CandidatePayload[]
  error: string | null
  rssHubResults?: RssHubProbeResult[]
}
export interface AccountSourceCoordinator {
  current(): AccountRecord
  subscribeRss(discovered: DiscoveredRssFeed, groupId?: string): Promise<string>
}
export interface SourceDiscoveryDependencies {
  rssDiscovery: RssDiscoveryService
  rssSubscription: RssSubscriptionService
  rssHubResolver: RssHubResolver
  rssHubSubscription: RssHubSubscriptionService
  jsonSource: JsonSourceService
  jsonSubscription: JsonSubscriptionService
  websiteSource: WebsiteSourceService
  websiteSubscription: WebsiteSubscriptionService
  accountCoordinator?: AccountSourceCoordinator
  feedDiscoveryCatalog?: FeedDiscoveryCatalog
}
export interface DiscoveryContext {
  dependencies: SourceDiscoveryDependencies
  sourceUrl: string
  isLocalAccount: boolean
  catalogMatch: FeedCatalogUrlMatch
  reportProgress: ProgressReporter
  signal?: AbortSignal
}
