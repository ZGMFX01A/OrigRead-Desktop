import { describe, expect, it } from 'vitest'
import type { FeedRecord } from '../../shared/library'
import type { LibraryRepository } from '../database/library-repository'
import { RssDiscoveryService } from './rss/rss-discovery-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { WebsiteSubscriptionService } from './website/website-subscription-service'
import type { WebsiteSourceService } from './website/website-source-service'
import { rssDiscovery, rssPayload, rssXml, withLibrary } from './subscription-regression-support'

const XML = rssXml([{ guid: 'one', title: 'Article one', link: 'https://example.com/one' }])
type Kind = 'rss' | 'website'

/** 只延迟网络边界，使用现有 SQLite、解析器和生产刷新提交路径。 */
async function delayedRefresh(library: LibraryRepository, kind: Kind) {
  const added = await new RssSubscriptionService(library, rssDiscovery(() => XML)).add('https://example.com/feed.xml')
  const initial: FeedRecord = { ...library.getFeedById(added.feedId)!, sourceType: kind }
  library.upsertFeed(initial)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = kind === 'rss'
    ? new RssSubscriptionService(library, new RssDiscoveryService(async (url) => {
      await gate
      return { ...rssPayload(url, XML), etag: 'new-response' }
    }, { findBestIcon: async () => null }))
    : new WebsiteSubscriptionService(library, {
      fetchArticleBatch: async () => { await gate; return { articles: [], cleanupRule: null } }
    } as unknown as WebsiteSourceService)
  return { initial, release, service }
}

describe.each(['rss', 'website'] as const)('%s refresh lifecycle', (kind) => {
  it('retains preferences, group and a user rename made while waiting for the network', async () => withLibrary(async (library) => {
    const { initial, service, release } = await delayedRefresh(library, kind)
    const pending = service.refresh(initial.id)
    library.upsertGroup({ id: 'moved-group', accountId: initial.accountId, name: 'Moved', sortOrder: 10, isDefault: false })
    const edited = { ...initial, groupId: 'moved-group', name: 'My source', isNotification: true, isFullContent: true, isBrowser: true }
    library.upsertFeed(edited)
    release()
    await pending
    expect(library.getFeedById(initial.id)).toMatchObject({ groupId: edited.groupId, name: edited.name,
      isNotification: true, isFullContent: true, isBrowser: true })
  }))

  it('does not resurrect a source deleted while the response is in flight', async () => withLibrary(async (library) => {
    const { initial, service, release } = await delayedRefresh(library, kind)
    const pending = service.refresh(initial.id)
    library.deleteFeed(initial.id)
    release()
    await expect(pending).rejects.toThrow('来源已删除')
    expect(library.getFeedById(initial.id)).toBeNull()
    expect(library.listArticlesByFeedForAccount(1, initial.id)).toEqual([])
    expect(library.getRssHttpCache(initial.id)).toBeNull()
  }))

  it('rejects old content when the source URL was changed during the request', async () => withLibrary(async (library) => {
    const { initial, service, release } = await delayedRefresh(library, kind)
    const pending = service.refresh(initial.id)
    library.upsertFeed({ ...initial, url: 'https://example.com/replacement.xml' })
    release()
    await expect(pending).rejects.toThrow('已变化')
    expect(library.getFeedById(initial.id)?.url).toBe('https://example.com/replacement.xml')
    expect(library.getRssHttpCache(initial.id)).toBeNull()
  }))
})
