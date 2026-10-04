import { describe, expect, it } from 'vitest'
import { AccountRepository } from '../accounts/account-repository'
import { MemorySecretStore } from '../security/secret-store'
import { SourceSyncService } from './source-sync-service'
import { RssSubscriptionService } from './rss/rss-subscription-service'
import { RssDiscoveryService } from './rss/rss-discovery-service'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'
import { discoveryFlow, rssDiscovery, rssPayload, rssXml, withLibrary } from './subscription-regression-support'

/** 代表真实 GitHub Atom 的命名空间、tag 标识及 alternate 链接。 */
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from OrigRead</title>
  <id>tag:github.com,2008:/ZGMFX01A/OrigRead/releases</id><updated>2026-10-03T00:00:00Z</updated>
  <entry><id>tag:github.com,2008:Repository/123/v1.6.1</id><title>v1.6.1</title>
  <link rel="alternate" href="https://github.com/ZGMFX01A/OrigRead/releases/tag/v1.6.1" />
  <updated>2026-10-03T00:00:00Z</updated><content type="html">Release body</content></entry></feed>`

describe('账户作用域和 GitHub issue #2', () => {
  it('GitHub Atom 真实解析成功后直接订阅，不探测 JSON、RSSHub 或网站', async () => withLibrary(async (library, database) => {
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const rss = rssDiscovery(() => ATOM)
    const subscription = new RssSubscriptionService(library, rss)
    const { service, unusedProbe } = discoveryFlow({ rss, subscription, current: () => accounts.current() })
    const discovered = await service.discover('https://github.com/ZGMFX01A/OrigRead/releases.atom')
    expect(discovered.candidates[0]?.kind).toBe('RSS_DIRECT')
    const added = await service.subscribe(discovered.discoveryId, discovered.candidates[0]!.id)
    expect(library.listArticlesByFeed(added.feedId)[0]?.title).toBe('v1.6.1')
    expect(unusedProbe).not.toHaveBeenCalled()
  }))

  it('发现结果不能在用户切换账户后被写入另一个账户', async () => withLibrary(async (library, database) => {
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const second = accounts.add({ type: 'local', name: 'Second' })
    accounts.switchTo(1)
    const rss = rssDiscovery(() => ATOM)
    const subscription = new RssSubscriptionService(library, rss)
    const { service } = discoveryFlow({ rss, subscription, current: () => accounts.current() })
    const discovered = await service.discover('https://github.com/ZGMFX01A/OrigRead/releases.atom')
    accounts.switchTo(second.id)
    await expect(service.subscribe(discovered.discoveryId, discovered.candidates[0]!.id)).rejects.toThrow(/账户/)
    expect(library.listFeedsForAccount(second.id)).toEqual([])
  }))

  it('直接添加 RSS 的网络请求期间切换账户仍写入请求开始的账户', async () => withLibrary(async (library, database) => {
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const second = accounts.add({ type: 'local', name: 'Second' })
    accounts.switchTo(1)
    const rss = new RssDiscoveryService(async (url) => {
      accounts.switchTo(second.id)
      return rssPayload(url, ATOM)
    }, { findBestIcon: async () => null })
    const result = await new RssSubscriptionService(library, rss).add('https://github.com/ZGMFX01A/OrigRead/releases.atom')
    expect(library.getFeedByIdForAccount(1, result.feedId)).not.toBeNull()
    expect(library.listFeedsForAccount(second.id)).toEqual([])
  }))

  it('同步队列超过并发数时，账户切换不会让后续来源失去作用域', async () => withLibrary(async (library, database) => {
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const second = accounts.add({ type: 'local', name: 'Second' })
    accounts.switchTo(1)
    const original = library.listFeeds()[0]!
    library.deleteFeed(original.id)
    for (let i = 0; i < 17; i++) library.upsertFeed({ ...original, id: `source-${i}`, url: `https://example.com/rss/${i}` })
    const content = rssXml([{ guid: 'one', title: 'One', link: 'https://example.com/1' }])
    const rss = new RssDiscoveryService(async (url) => {
      accounts.switchTo(second.id)
      return rssPayload(url, content)
    }, { findBestIcon: async () => null })
    const sourceSync = new SourceSyncService(library, { rss: new RssSubscriptionService(library, rss), json: {} as JsonSubscriptionService, website: {} as WebsiteSubscriptionService })
    const result = await sourceSync.refreshAllSources()
    expect(result).toMatchObject({ sourceCount: 17, successCount: 17, failedCount: 0 })
    expect(library.listArticlesForAccount(1)).toHaveLength(17)
    expect(library.listArticlesForAccount(second.id)).toEqual([])
  }))
})
