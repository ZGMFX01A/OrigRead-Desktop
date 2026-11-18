import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArticleRecord, FeedRecord, SourceType } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { ORIGREAD_DESKTOP_RELEASE_FEED_URL } from '../../shared/origread-release'
import { AccountRepository } from '../accounts/account-repository'
import { MemorySecretStore } from '../security/secret-store'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import { SourceSyncService, type SourceNewArticlesListener } from './source-sync-service'
import type { WebsiteSubscriptionService } from './website/website-subscription-service'

const databases: DesktopDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('SourceSyncService', () => {
  it('dispatches RSS, JSON and Website through their existing services with one shared fetchedAt', async () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed('rss-feed', 'rss'))
    repository.upsertFeed(createFeed('json-feed', 'json'))
    repository.upsertFeed(createFeed('website-feed', 'website'))

    const rssRefresh = vi.fn(async (feedId: string, fetchedAt: number) => ({
      feedId,
      fetchedArticles: 5,
      insertedArticles: 2,
      fetchedAt
    }))
    const jsonRefresh = vi.fn(async (feedId: string, fetchedAt: number) => ({
      feedId,
      fetchedArticles: 4,
      insertedArticles: 1,
      fetchedAt
    }))
    const websiteRefresh = vi.fn(async (feedId: string, fetchedAt: number) => ({
      feedId,
      fetchedArticles: 3,
      insertedArticles: 1,
      deletedArticles: 2,
      fetchedAt
    }))
    const service = createService(repository, rssRefresh, jsonRefresh, websiteRefresh)
    const fetchedAt = 1_786_000_000_000

    const result = await service.refreshAllSources(fetchedAt)

    expect(rssRefresh).toHaveBeenCalledWith('rss-feed', fetchedAt, 1)
    expect(jsonRefresh).toHaveBeenCalledWith('json-feed', fetchedAt, 1)
    expect(websiteRefresh).toHaveBeenCalledWith('website-feed', fetchedAt, 1)
    expect(result).toMatchObject({
      sourceCount: 3,
      successCount: 3,
      failedCount: 0,
      fetchedArticles: 12,
      insertedArticles: 4,
      deletedArticles: 2,
      retryRecommended: false
    })
  })

  it('lets other sources finish when one source fails and marks the batch for retry', async () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed('rss-ok', 'rss'))
    repository.upsertFeed(createFeed('json-fail', 'json'))
    repository.upsertFeed(createFeed('website-ok', 'website'))

    const rssRefresh = vi.fn(async (feedId: string) => ({ feedId, fetchedArticles: 2, insertedArticles: 1 }))
    const jsonRefresh = vi.fn(async () => { throw new Error('JSON endpoint unavailable') })
    const websiteRefresh = vi.fn(async (feedId: string) => ({
      feedId,
      fetchedArticles: 4,
      insertedArticles: 2,
      deletedArticles: 1
    }))
    const service = createService(repository, rssRefresh, jsonRefresh, websiteRefresh)

    const result = await service.refreshAllSources()

    expect(rssRefresh).toHaveBeenCalledOnce()
    expect(jsonRefresh).toHaveBeenCalledOnce()
    expect(websiteRefresh).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      sourceCount: 3,
      successCount: 2,
      failedCount: 1,
      fetchedArticles: 6,
      insertedArticles: 3,
      deletedArticles: 1,
      retryRecommended: true
    })
    expect(result.results.find((item) => item.feedId === 'json-fail')).toMatchObject({
      status: 'failed',
      error: 'JSON endpoint unavailable'
    })
  })

  it('repairs an empty legacy Website source as RSS after Website refresh fails', async () => {
    const repository = createRepository()
    repository.upsertFeed({
      ...createFeed('legacy-website-rss', 'website'),
      name: 'Legacy Website',
      url: 'https://www.52pojie.cn/forum.php?mod=rss',
      sourcePageUrl: 'https://www.52pojie.cn/forum.php?mod=rss'
    })
    const fetchedAt = 1_786_000_000_123
    const websiteRefresh = vi.fn(async () => { throw new Error('当前网站的解析规则均未通过健康检查') })
    const rssRecovery = vi.fn(async (feedId: string, at: number) => {
      const current = repository.getFeedById(feedId)!
      repository.upsertFeed({ ...current, name: '吾爱破解 - 52pojie.cn', sourceType: 'rss', updatedAt: at })
      repository.upsertArticle(createArticle('recovered-rss-article', feedId))
      return { feedId, fetchedArticles: 1, insertedArticles: 1 }
    })
    const service = createService(repository, vi.fn(), vi.fn(), websiteRefresh, undefined, rssRecovery)

    const result = await service.refreshSource('legacy-website-rss', fetchedAt)

    expect(websiteRefresh).toHaveBeenCalledWith('legacy-website-rss', fetchedAt, 1)
    expect(rssRecovery).toHaveBeenCalledWith('legacy-website-rss', fetchedAt, 1)
    expect(result).toMatchObject({
      status: 'success',
      sourceType: 'rss',
      feedName: '吾爱破解 - 52pojie.cn',
      fetchedArticles: 1,
      insertedArticles: 1
    })
  })

  it('never exceeds the configured limit of 4 concurrent source refreshes', async () => {
    const repository = createRepository()
    for (let index = 0; index < 24; index += 1) {
      repository.upsertFeed(createFeed(`rss-${index}`, 'rss'))
    }

    let active = 0
    let maxActive = 0
    const rssRefresh = vi.fn(async (feedId: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 8))
      active -= 1
      return { feedId, fetchedArticles: 1, insertedArticles: 0 }
    })
    const service = createService(
      repository,
      rssRefresh,
      vi.fn(),
      vi.fn()
    )

    const result = await service.refreshAllSources()

    expect(result.successCount).toBe(24)
    expect(maxActive).toBe(4)
  })

  it('emits newly inserted articles only for sources with notification enabled', async () => {
    const repository = createRepository()
    repository.upsertFeed({ ...createFeed('rss-notify', 'rss'), isNotification: true })
    repository.upsertFeed(createFeed('rss-silent', 'rss'))
    const listener = vi.fn<SourceNewArticlesListener>()
    const rssRefresh = vi.fn(async (feedId: string) => {
      repository.upsertArticle(createArticle(`${feedId}-article`, feedId))
      return { feedId, fetchedArticles: 1, insertedArticles: 1 }
    })
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn(), listener)

    await service.refreshAllSources()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rss-notify', isNotification: true }),
      [expect.objectContaining({ id: 'rss-notify-article', feedId: 'rss-notify' })]
    )
  })

  it('rejects group refresh when group does not belong to the account or does not exist', async () => {
    const { repository, database } = createRepositoryWithDatabase()
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const account2 = accounts.add({ type: 'local', name: 'Account 2' })
    accounts.switchTo(1)

    // 在账户 2 创建分组
    repository.upsertGroup({
      id: 'acc2-group',
      accountId: account2.id,
      name: 'Group in Acc 2',
      sortOrder: 1,
      isDefault: false
    })

    const service = createService(repository, vi.fn(), vi.fn(), vi.fn())

    // 不存在的分组
    await expect(service.refreshGroup('non-existent-group')).rejects.toThrow('分组不存在或不属于当前账户')

    // 跨账户分组越权：当前为账户 1，尝试刷新账户 2 的分组
    await expect(service.refreshGroup('acc2-group', undefined, 1)).rejects.toThrow('分组不存在或不属于当前账户')
  })

  it('returns empty batch result for empty group without invoking refresh services', async () => {
    const repository = createRepository()
    repository.upsertGroup({
      id: 'empty-group',
      accountId: 1,
      name: 'Empty Group',
      sortOrder: 1,
      isDefault: false
    })

    const rssRefresh = vi.fn()
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    const result = await service.refreshGroup('empty-group')

    expect(rssRefresh).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      sourceCount: 0,
      successCount: 0,
      failedCount: 0,
      fetchedArticles: 0,
      insertedArticles: 0,
      deletedArticles: 0,
      retryRecommended: false,
      results: []
    })
  })

  it('handles partial failures within a group refresh and marks batch for retry', async () => {
    const repository = createRepository()
    repository.upsertGroup({
      id: 'custom-group',
      accountId: 1,
      name: 'Custom Group',
      sortOrder: 1,
      isDefault: false
    })
    repository.upsertFeed({ ...createFeed('feed-ok', 'rss'), groupId: 'custom-group' })
    repository.upsertFeed({ ...createFeed('feed-fail', 'rss'), groupId: 'custom-group' })

    const rssRefresh = vi.fn(async (feedId: string) => {
      if (feedId === 'feed-fail') throw new Error('网络连接超时')
      return { feedId, fetchedArticles: 3, insertedArticles: 1 }
    })
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    const result = await service.refreshGroup('custom-group')

    expect(result).toMatchObject({
      sourceCount: 2,
      successCount: 1,
      failedCount: 1,
      fetchedArticles: 3,
      insertedArticles: 1,
      retryRecommended: true
    })
    expect(result.results.find((item) => item.feedId === 'feed-fail')).toMatchObject({
      status: 'failed',
      error: '网络连接超时'
    })
  })

  it('deduplicates inflight refreshes across overlapping group, all, and single calls without cross-scope coalescing', async () => {
    const repository = createRepository()
    repository.upsertGroup({ id: 'group-1', accountId: 1, name: 'Group 1', sortOrder: 1, isDefault: false })
    repository.upsertGroup({ id: 'group-2', accountId: 1, name: 'Group 2', sortOrder: 2, isDefault: false })

    repository.upsertFeed({ ...createFeed('feed-1', 'rss'), groupId: 'group-1' })
    repository.upsertFeed({ ...createFeed('feed-2', 'rss'), groupId: 'group-2' })

    let finishFeed1!: () => void
    const feed1Gate = new Promise<void>((resolve) => { finishFeed1 = resolve })

    const rssRefresh = vi.fn(async (feedId: string) => {
      if (feedId === 'feed-1') {
        await feed1Gate
        return { feedId, fetchedArticles: 5, insertedArticles: 2 }
      }
      return { feedId, fetchedArticles: 3, insertedArticles: 1 }
    })
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    // 1. 发起全量刷新（包含 feed-1 和 feed-2），feed-1 会停留在 inflight
    const allPromise = service.refreshAllSources()
    // 让微任务推进，确保 feed-1 已发起并挂在 inflightFeeds
    await new Promise((r) => setTimeout(r, 5))

    // 2. 在 feed-1 仍在进行时，发起分组刷新（仅含 feed-1）与单源刷新（feed-1）
    const groupPromise = service.refreshGroup('group-1')
    const singlePromise = service.refreshSource('feed-1')

    // 3. 释放 feed-1
    finishFeed1()

    const [allResult, groupResult, singleResult] = await Promise.all([
      allPromise,
      groupPromise,
      singlePromise
    ])

    // 断言 feed-1 仅被抓取了 1 次（底层 service 只调用 1 次）
    const feed1Calls = rssRefresh.mock.calls.filter(([id]) => id === 'feed-1')
    expect(feed1Calls).toHaveLength(1)

    // 单源刷新返回该源成功结果
    expect(singleResult).toMatchObject({
      feedId: 'feed-1',
      status: 'success',
      fetchedArticles: 5,
      insertedArticles: 2
    })

    // 分组刷新仅包含 group-1 的 feed-1，范围未被误扩大
    expect(groupResult.sourceCount).toBe(1)
    expect(groupResult.successCount).toBe(1)
    expect(groupResult.results.map((r) => r.feedId)).toEqual(['feed-1'])

    // 全量刷新包含 feed-1 和 feed-2，范围完整
    expect(allResult.sourceCount).toBe(2)
    expect(allResult.successCount).toBe(2)
    expect(allResult.results.map((r) => r.feedId).sort()).toEqual(['feed-1', 'feed-2'])
  })

  it('strictly limits concurrency to <= 4 across concurrent all and group refreshes', async () => {
    const repository = createRepository()
    repository.upsertGroup({ id: 'group-a', accountId: 1, name: 'Group A', sortOrder: 1, isDefault: false })
    repository.upsertGroup({ id: 'group-b', accountId: 1, name: 'Group B', sortOrder: 2, isDefault: false })

    for (let index = 0; index < 8; index++) {
      repository.upsertFeed({ ...createFeed(`feed-a-${index}`, 'rss'), groupId: 'group-a' })
      repository.upsertFeed({ ...createFeed(`feed-b-${index}`, 'rss'), groupId: 'group-b' })
    }

    let active = 0
    let maxActive = 0
    const rssRefresh = vi.fn(async (feedId: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 8))
      active--
      return { feedId, fetchedArticles: 1, insertedArticles: 0 }
    })
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    // 同时发起两个不同组刷新与一个全量刷新（共 8 + 8 + 16 = 32 个任务项）
    const [resGroupA, resGroupB, resAll] = await Promise.all([
      service.refreshGroup('group-a'),
      service.refreshGroup('group-b'),
      service.refreshAllSources()
    ])

    expect(resGroupA.successCount).toBe(8)
    expect(resGroupB.successCount).toBe(8)
    expect(resAll.successCount).toBe(16)
    expect(maxActive).toBeLessThanOrEqual(4)
  })

  it('preserves target account scope even if active account changes during group refresh', async () => {
    const { repository, database } = createRepositoryWithDatabase()
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const account2 = accounts.add({ type: 'local', name: 'Account 2' })
    accounts.switchTo(1)

    repository.upsertGroup({ id: 'acc1-group', accountId: 1, name: 'Group 1', sortOrder: 1, isDefault: false })
    repository.upsertFeed({ ...createFeed('feed-acc1', 'rss'), groupId: 'acc1-group', accountId: 1 })

    const rssRefresh = vi.fn(async (feedId: string, _at: number, accountId?: number) => {
      // 模拟在异步抓取网络请求期间，用户在 UI 上切换了当前活跃账户
      accounts.switchTo(account2.id)

      // 写入文章，必须绑定到原传入的 accountId
      repository.upsertArticle({
        ...createArticle('article-acc1', feedId),
        accountId: accountId ?? repository.getCurrentAccountId()
      })
      return { feedId, fetchedArticles: 1, insertedArticles: 1 }
    })

    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    const result = await service.refreshGroup('acc1-group', undefined, 1)

    expect(result.successCount).toBe(1)
    // 断言文章被正确写入账户 1
    expect(repository.listArticlesForAccount(1)).toHaveLength(1)
    // 账户 2 不受任何影响
    expect(repository.listArticlesForAccount(account2.id)).toHaveLength(0)
  })

  it('does not fall back to the active account when an explicit account does not own a source', async () => {
    const { repository, database } = createRepositoryWithDatabase()
    const accounts = new AccountRepository(database.connection, new MemorySecretStore())
    const other = accounts.add({ type: 'local', name: 'Other' })
    const group = repository.listGroupsForAccount(other.id).find(item => item.isDefault)!
    repository.upsertFeed({ ...createFeed('other-feed', 'rss'), accountId: other.id, groupId: group.id })
    const refresh = vi.fn()
    const service = createService(repository, refresh, vi.fn(), vi.fn())

    await expect(service.refreshSource('other-feed', undefined, 1)).rejects.toThrow('来源不存在')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('throws error when single source refresh fails', async () => {
    const repository = createRepository()
    repository.upsertFeed(createFeed('feed-single-fail', 'rss'))

    const rssRefresh = vi.fn(async () => {
      throw new Error('Connection refused')
    })
    const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

    await expect(service.refreshSource('feed-single-fail')).rejects.toThrow('Connection refused')
  })

  describe('C2b: Descendant group hierarchy refresh & deduplication', () => {
    it('refreshes parent direct feeds, child feeds, and grandchild feeds with deduplication across descendants', () => {
      return (async () => {
        const repository = createRepository()

        // Account 1: parent -> child -> grandchild
        repository.upsertGroup({ id: 'parent-g', accountId: 1, name: 'Parent', sortOrder: 1, isDefault: false, parentId: null })
        repository.upsertGroup({ id: 'child-g', accountId: 1, name: 'Child', sortOrder: 2, isDefault: false, parentId: 'parent-g' })
        repository.upsertGroup({ id: 'grandchild-g', accountId: 1, name: 'Grandchild', sortOrder: 3, isDefault: false, parentId: 'child-g' })
        repository.upsertGroup({ id: 'other-g', accountId: 1, name: 'Other', sortOrder: 4, isDefault: false, parentId: null })

        // Feeds
        repository.upsertFeed({ ...createFeed('feed-p', 'rss'), accountId: 1, groupId: 'parent-g' })
        repository.upsertFeed({ ...createFeed('feed-c', 'rss'), accountId: 1, groupId: 'child-g' })
        repository.upsertFeed({ ...createFeed('feed-gc', 'rss'), accountId: 1, groupId: 'grandchild-g' })
        repository.upsertFeed({ ...createFeed('feed-other', 'rss'), accountId: 1, groupId: 'other-g' })

        const refreshedFeedIds: string[] = []
        const rssRefresh = vi.fn(async (feedId: string) => {
          refreshedFeedIds.push(feedId)
          return { feedId, fetchedArticles: 1, insertedArticles: 1 }
        })

        const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

        const result = await service.refreshGroup('parent-g')

        // 验证：包含父直属、子直属、孙直属共 3 个源
        expect(result.sourceCount).toBe(3)
        expect(result.successCount).toBe(3)
        expect(result.failedCount).toBe(0)
        expect(refreshedFeedIds.sort()).toEqual(['feed-c', 'feed-gc', 'feed-p'])

        // 验证子组刷新：只包含子直属和孙直属
        refreshedFeedIds.length = 0
        const childResult = await service.refreshGroup('child-g')
        expect(childResult.sourceCount).toBe(2)
        expect(childResult.successCount).toBe(2)
        expect(refreshedFeedIds.sort()).toEqual(['feed-c', 'feed-gc'])
      })()
    })

    it('deduplicates duplicate feed occurrences across group hierarchy', () => {
      return (async () => {
        const repository = createRepository()

        repository.upsertGroup({ id: 'parent-dup', accountId: 1, name: 'Parent', sortOrder: 1, isDefault: false, parentId: null })
        repository.upsertGroup({ id: 'child-dup', accountId: 1, name: 'Child', sortOrder: 2, isDefault: false, parentId: 'parent-dup' })

        // Two feeds under parent and child
        repository.upsertFeed({ ...createFeed('feed-shared', 'rss'), accountId: 1, groupId: 'parent-dup' })

        // Mock repository.listFeedsForAccount to return duplicate feed IDs if dirty catalog occurs
        const originalListFeeds = repository.listFeedsForAccount.bind(repository)
        vi.spyOn(repository, 'listFeedsForAccount').mockImplementation((accId) => {
          const actual = originalListFeeds(accId)
          return [
            ...actual,
            { ...actual.find((f) => f.id === 'feed-shared')!, groupId: 'child-dup' }
          ]
        })

        const refreshedFeedIds: string[] = []
        const rssRefresh = vi.fn(async (feedId: string) => {
          refreshedFeedIds.push(feedId)
          return { feedId, fetchedArticles: 1, insertedArticles: 1 }
        })

        const service = createService(repository, rssRefresh, vi.fn(), vi.fn())
        const result = await service.refreshGroup('parent-dup')

        // Deduplication ensures feed-shared is only refreshed once
        expect(result.sourceCount).toBe(1)
        expect(result.successCount).toBe(1)
        expect(refreshedFeedIds).toEqual(['feed-shared'])
      })()
    })

    it('strictly isolates accounts and handles empty group hierarchy without invocation', () => {
      return (async () => {
        const { repository, database } = createRepositoryWithDatabase()
        const accounts = new AccountRepository(database.connection, new MemorySecretStore())
        const acc2 = accounts.add({ type: 'local', name: 'Acc2' })

        // Switch back to account 1
        accounts.switchTo(1)

        repository.upsertGroup({ id: 'empty-parent', accountId: 1, name: 'Empty Parent', sortOrder: 1, isDefault: false, parentId: null })
        repository.upsertGroup({ id: 'empty-child', accountId: 1, name: 'Empty Child', sortOrder: 2, isDefault: false, parentId: 'empty-parent' })

        repository.upsertGroup({ id: 'acc2-parent', accountId: acc2.id, name: 'Acc2 Parent', sortOrder: 1, isDefault: false, parentId: null })
        repository.upsertFeed({ ...createFeed('acc2-feed', 'rss'), accountId: acc2.id, groupId: 'acc2-parent' })

        const rssRefresh = vi.fn()
        const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

        // Empty group returns sourceCount: 0 without invoking refresh
        const emptyResult = await service.refreshGroup('empty-parent')
        expect(emptyResult.sourceCount).toBe(0)
        expect(rssRefresh).not.toHaveBeenCalled()

        // Trying to refresh account 2's group while target account is account 1 throws error
        await expect(service.refreshGroup('acc2-parent', undefined, 1)).rejects.toThrow('分组不存在或不属于当前账户')
        expect(rssRefresh).not.toHaveBeenCalled()
      })()
    })

    it('works properly with remote flat account without children', () => {
      return (async () => {
        const repository = createRepository()

        // Remote flat groups do not have parentId
        repository.upsertGroup({ id: 'remote-g1', accountId: 1, name: 'Remote Group 1', sortOrder: 1, isDefault: false, parentId: null })
        repository.upsertGroup({ id: 'remote-g2', accountId: 1, name: 'Remote Group 2', sortOrder: 2, isDefault: false, parentId: null })

        repository.upsertFeed({ ...createFeed('feed-r1', 'rss'), accountId: 1, groupId: 'remote-g1' })
        repository.upsertFeed({ ...createFeed('feed-r2', 'rss'), accountId: 1, groupId: 'remote-g2' })

        const refreshedFeedIds: string[] = []
        const rssRefresh = vi.fn(async (feedId: string) => {
          refreshedFeedIds.push(feedId)
          return { feedId, fetchedArticles: 1, insertedArticles: 1 }
        })

        const service = createService(repository, rssRefresh, vi.fn(), vi.fn())

        const result = await service.refreshGroup('remote-g1')
        expect(result.sourceCount).toBe(1)
        expect(refreshedFeedIds).toEqual(['feed-r1'])
      })()
    })
  })
})

function createRepositoryWithDatabase(): { repository: LibraryRepository; database: DesktopDatabase } {
  const database = new DesktopDatabase(':memory:')
  databases.push(database)
  const repository = new LibraryRepository(database.connection)
  const builtInReleaseFeed = repository.findFeedByUrl(ORIGREAD_DESKTOP_RELEASE_FEED_URL)
  if (builtInReleaseFeed) repository.deleteFeed(builtInReleaseFeed.id)
  return { repository, database }
}

function createRepository(): LibraryRepository {
  return createRepositoryWithDatabase().repository
}

function createFeed(id: string, sourceType: SourceType): FeedRecord {
  const now = 1_786_000_000_000
  return {
    id,
    groupId: DEFAULT_GROUP_ID,
    name: id,
    url: `https://example.com/${id}`,
    sourcePageUrl: 'https://example.com/',
    sourceType,
    icon: null,
    isNotification: false,
    isFullContent: false,
    isBrowser: false,
    dynamicRendering: false,
    createdAt: now,
    updatedAt: now
  }
}

function createArticle(id: string, feedId: string): ArticleRecord {
  const now = 1_786_000_000_000
  return {
    id,
    feedId,
    title: id,
    url: `https://example.com/article/${id}`,
    author: null,
    publishedAt: now,
    description: '',
    contentHtml: null,
    fullContentHtml: null,
    imageUrl: null,
    isUnread: true,
    isStarred: false,
    createdAt: now,
    updatedAt: now
  }
}

function createService(
  repository: LibraryRepository,
  rssRefresh: ReturnType<typeof vi.fn>,
  jsonRefresh: ReturnType<typeof vi.fn>,
  websiteRefresh: ReturnType<typeof vi.fn>,
  listener?: SourceNewArticlesListener,
  rssRecovery: ReturnType<typeof vi.fn> = vi.fn(async () => null)
): SourceSyncService {
  return new SourceSyncService(
    repository,
    { rss: { refresh: rssRefresh, tryRecoverMisclassifiedEmptyWebsite: rssRecovery } as unknown as RssSubscriptionService, json: { refresh: jsonRefresh } as unknown as JsonSubscriptionService, website: { refresh: websiteRefresh } as unknown as WebsiteSubscriptionService },
    listener
  )
}
