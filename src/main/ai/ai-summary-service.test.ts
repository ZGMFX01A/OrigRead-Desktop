import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiSettingsRepository } from './ai-settings-repository'
import type { OpenAiCompatibleProvider } from './openai-compatible-provider'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { ReaderContentService } from '../content/reader-content-service'
import { AiSummaryService } from './ai-summary-service'

const databases: DesktopDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AiSummaryService', () => {
  it('reuses the latest successful explicit-provider summary for a later normal open and reports real stages', async () => {
    const database = new DesktopDatabase(':memory:')
    databases.push(database)
    const library = new LibraryRepository(database.connection)
    library.upsertFeed(feed())
    library.upsertArticle(article())

    const config = {
      enabled: true,
      defaultProviderId: 'default-provider',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD' as const,
      providers: [
        { id: 'default-provider', name: 'Default', enabled: true, endpoint: 'https://default.example/v1', defaultModel: 'default-model', models: ['default-model'], hasApiKey: true },
        { id: 'alternate-provider', name: 'Alternate', enabled: true, endpoint: 'https://alternate.example/v1', defaultModel: 'alternate-model', models: ['alternate-model'], hasApiKey: true }
      ]
    }
    const settings = {
      current: () => config,
      getApiKey: () => 'test-key'
    } as unknown as AiSettingsRepository

    let providerCalls = 0
    const provider = {
      completeDetailed: async () => {
        providerCalls += 1
        return { content: 'alternate summary', reasoning: null }
      }
    } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-'))
    tempDirs.push(cacheDir)
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, cacheDir, provider)
    const stages: string[] = []

    const generated = await service.summarize(
      'article-1',
      true,
      { providerId: 'alternate-provider', model: 'alternate-model', length: 'DETAILED' },
      (stage) => stages.push(stage)
    )

    expect(generated).toMatchObject({ providerId: 'alternate-provider', model: 'alternate-model', length: 'DETAILED', summary: 'alternate summary' })
    expect(stages).toEqual(['PREPARING', 'REQUESTING', 'FINALIZING'])
    expect(providerCalls).toBe(1)

    const reopened = await service.summarize('article-1')
    expect(reopened).toMatchObject({ providerId: 'alternate-provider', model: 'alternate-model', length: 'DETAILED', summary: 'alternate summary' })
    expect(providerCalls).toBe(1)
  })
})

function feed(): FeedRecord {
  const now = 1_786_000_000_000
  return {
    id: 'feed-1', groupId: DEFAULT_GROUP_ID, name: 'AI feed', url: 'https://example.com/feed.xml', sourcePageUrl: 'https://example.com/',
    sourceType: 'rss', icon: null, isNotification: false, isFullContent: false, isBrowser: false, dynamicRendering: false,
    createdAt: now, updatedAt: now
  }
}

function article(): ArticleRecord {
  const now = 1_786_000_000_000
  return {
    id: 'article-1', feedId: 'feed-1', title: 'AI article', url: 'https://example.com/article', author: null, publishedAt: now,
    description: 'Source preview',
    contentHtml: '<p>This is substantial article content used to validate summary cache behavior.</p><p>The second paragraph keeps the source deterministic.</p>',
    fullContentHtml: null, imageUrl: null, isUnread: true, isStarred: false, createdAt: now, updatedAt: now
  }
}
