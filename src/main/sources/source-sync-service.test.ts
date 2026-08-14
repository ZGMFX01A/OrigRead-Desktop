import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeedRecord, SourceType } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import type { JsonSubscriptionService } from './json/json-subscription-service'
import type { RssSubscriptionService } from './rss/rss-subscription-service'
import { SourceSyncService } from './source-sync-service'
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

    expect(rssRefresh).toHaveBeenCalledWith('rss-feed', fetchedAt)
    expect(jsonRefresh).toHaveBeenCalledWith('json-feed', fetchedAt)
    expect(websiteRefresh).toHaveBeenCalledWith('website-feed', fetchedAt)
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

  it('never exceeds the Android parity limit of 16 concurrent source refreshes', async () => {
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
    expect(maxActive).toBe(16)
  })
})

function createRepository(): LibraryRepository {
  const database = new DesktopDatabase(':memory:')
  databases.push(database)
  return new LibraryRepository(database.connection)
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

function createService(
  repository: LibraryRepository,
  rssRefresh: ReturnType<typeof vi.fn>,
  jsonRefresh: ReturnType<typeof vi.fn>,
  websiteRefresh: ReturnType<typeof vi.fn>
): SourceSyncService {
  return new SourceSyncService(
    repository,
    { refresh: rssRefresh } as unknown as RssSubscriptionService,
    { refresh: jsonRefresh } as unknown as JsonSubscriptionService,
    { refresh: websiteRefresh } as unknown as WebsiteSubscriptionService
  )
}

