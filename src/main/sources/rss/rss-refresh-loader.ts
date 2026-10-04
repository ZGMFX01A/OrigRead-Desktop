import type { FeedRecord } from '../../../shared/library'
import type { DiscoveredRssFeed } from '../../../shared/rss'
import type { RssHubSubscriptionDescriptor } from '../../../shared/rsshub'
import type { LibraryRepository } from '../../database/library-repository'
import type { RssDiscoveryService } from './rss-discovery-service'
import type { RssHubResolver } from '../rsshub/rsshub-resolver'

export interface LoadedRssRefresh {
  feed: DiscoveredRssFeed | null
  validators: { etag: string | null; lastModified: string | null }
  descriptor?: RssHubSubscriptionDescriptor
}

/** 刷新只请求 XML，图标沿用已有值；条件响应和 RSSHub 实例恢复保留显式失败。 */
export async function loadRssRefresh(options: {
  repository: LibraryRepository; discovery: RssDiscoveryService; resolver?: RssHubResolver
}, existing: FeedRecord): Promise<LoadedRssRefresh> {
    const { repository, discovery } = options
    const descriptor = repository.getRssHubDescriptor(existing.id)
    const cache = repository.getRssHttpCache(existing.id)
    const validCache = cache?.feedUrl === existing.url ? cache : null
    try {
      const direct = await discovery.parseDirectConditional(existing.url, {
        sourcePageUrl: descriptor ? existing.url : existing.sourcePageUrl ?? existing.url,
        validators: { etag: validCache?.etag, lastModified: validCache?.lastModified },
        skipIconDiscovery: true
      })
      return {
        feed: direct.notModified ? null : descriptor
          ? { ...direct.feed!, sourcePageUrl: descriptor.originalInput } : direct.feed!,
        validators: { etag: direct.etag, lastModified: direct.lastModified }
      }
    } catch (error) {
      // 普通 RSS 的网络和 XML 错误必须抛出；只有已绑定 RSSHub 路由才有实例恢复语义。
      const recovered = await recover(options.resolver, descriptor)
      if (!recovered) throw error
      return { ...recovered, validators: { etag: null, lastModified: null } }
    }
}

/** 仅对持久化 RSSHub 路由执行实例恢复，避免普通 RSS 错误被空结果掩盖。 */
async function recover(resolver: RssHubResolver | undefined, descriptor: RssHubSubscriptionDescriptor | null): Promise<{
    feed: DiscoveredRssFeed; descriptor: RssHubSubscriptionDescriptor
  } | null> {
    if (!descriptor || !resolver) return null
    const results = descriptor.routePath
      ? await resolver.probeRouteForRecovery(descriptor.routePath, descriptor.lastResolvedInstance ?? descriptor.preferredInstance)
      : await resolver.probe(descriptor.originalInput)
    const recovered = results.find((result) => result.available && result.feed && result.match.feedUrl)
    if (!recovered?.feed || !recovered.match.feedUrl) return null
    return {
      feed: { ...recovered.feed, feedUrl: recovered.match.feedUrl, sourcePageUrl: descriptor.originalInput },
      descriptor: {
        ...descriptor, routePath: recovered.routePath ?? descriptor.routePath,
        lastResolvedInstance: recovered.instanceBaseUrl ?? descriptor.lastResolvedInstance,
        lastResolvedUrl: recovered.match.feedUrl
      }
    }
}
