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
import { AiSummaryService, prepareArticleForSummary } from './ai-summary-service'

const databases: DesktopDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AiSummaryService', () => {
  it('preserves table rows for research and report summarization', () => {
    const prepared = prepareArticleForSummary({
      articleId: 'table-article',
      mode: 'content',
      html: '<article><h2>Results</h2><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Accuracy</td><td>92%</td></tr></table></article>',
      sourceUrl: 'https://example.com/report'
    })
    expect(prepared).toContain('| Metric | Value |\n| Accuracy | 92% |')
  })

  it('budgets oversized tables across the whole table without swallowing following prose', () => {
    const rows = Array.from({ length: 120 }, (_value, rowIndex) =>
      `<tr>${Array.from({ length: 12 }, (_cell, cellIndex) => `<td>row-${rowIndex}-col-${cellIndex}-representative-value</td>`).join('')}</tr>`
    ).join('')
    const prepared = prepareArticleForSummary({
      articleId: 'large-table-article',
      mode: 'content',
      html: `<article><h2>Data</h2><table>${rows}</table><h2>Conclusion</h2><p>正文结论必须保留，不能被巨型表格挤出摘要输入。</p></article>`,
      sourceUrl: 'https://example.com/large-report'
    })
    expect(prepared).toContain('表格过大：共 120 行')
    expect(prepared).toContain('row-0-col-0')
    expect(prepared).toContain('row-119-col-0')
    expect(prepared).toContain('正文结论必须保留')
  })

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

  it('returns and caches NOT_NEEDED locally for an obviously concise article without calling provider', async () => {
    const database = new DesktopDatabase(':memory:')
    databases.push(database)
    const library = new LibraryRepository(database.connection)
    library.upsertFeed(feed())
    library.upsertArticle(article('<p>英伟达盘中涨超 10%，受财报超预期影响。</p>'))
    const config = {
      enabled: true,
      defaultProviderId: 'default-provider',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD' as const,
      providers: [{ id: 'default-provider', name: 'Default', enabled: true, endpoint: 'https://default.example/v1', defaultModel: 'default-model', models: ['default-model'], hasApiKey: true }]
    }
    const settings = { current: () => config, getApiKey: () => 'test-key' } as unknown as AiSettingsRepository
    let providerCalls = 0
    const provider = { completeDetailed: async () => { providerCalls += 1; return { content: 'should not happen', reasoning: null } } } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-'))
    tempDirs.push(cacheDir)
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, cacheDir, provider)

    const first = await service.summarize('article-1')
    expect(first).toMatchObject({ status: 'NOT_NEEDED', summary: '', skipReason: 'local_source_already_concise' })
    expect(providerCalls).toBe(0)
    const reopened = await service.summarize('article-1')
    expect(reopened.status).toBe('NOT_NEEDED')
    expect(providerCalls).toBe(0)
  })

  it('invalidates a NOT_NEEDED cache when the actual reader content changes from a short feed body to full content', async () => {
    const database = new DesktopDatabase(':memory:')
    databases.push(database)
    const library = new LibraryRepository(database.connection)
    library.upsertFeed(feed())
    library.upsertArticle(article('<p>详情见原文。</p>'))
    const config = {
      enabled: true,
      defaultProviderId: 'default-provider',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD' as const,
      providers: [{ id: 'default-provider', name: 'Default', enabled: true, endpoint: 'https://default.example/v1', defaultModel: 'default-model', models: ['default-model'], hasApiKey: true }]
    }
    const settings = { current: () => config, getApiKey: () => 'test-key' } as unknown as AiSettingsRepository
    let providerCalls = 0
    const provider = {
      completeDetailed: async () => {
        providerCalls += 1
        return { content: '完整正文已经具备摘要价值。', reasoning: null }
      }
    } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-'))
    tempDirs.push(cacheDir)
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, cacheDir, provider)

    const shortResult = await service.summarize('article-1')
    expect(shortResult.status).toBe('NOT_NEEDED')
    expect(providerCalls).toBe(0)

    const updated = article('<p>详情见原文。</p>')
    updated.fullContentHtml = '<h2>背景</h2><p>完整正文包含多个事实、数据和上下文，需要真正压缩。</p><h2>证据</h2><p>第二部分提供独立证据和限制条件。</p><ul><li>事实 A</li><li>事实 B</li><li>限制 C</li></ul>'
    library.upsertArticle(updated)

    const fullResult = await service.summarize('article-1')
    expect(fullResult.status).toBe('GENERATED')
    expect(fullResult.summary).toContain('完整正文已经具备摘要价值')
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

function article(contentHtml = '<h2>Background</h2><p>This is substantial article content used to validate summary cache behavior and preserve the full multi-part summarization path.</p><h2>Evidence</h2><p>The second section adds independent evidence, concrete observations, limitations, and enough structure that a complex article must remain eligible for AI summarization.</p><ul><li>Measured result A</li><li>Measured result B</li><li>Known limitation C</li></ul>'): ArticleRecord {
  const now = 1_786_000_000_000
  return {
    id: 'article-1', feedId: 'feed-1', title: 'AI article', url: 'https://example.com/article', author: null, publishedAt: now,
    description: 'Source preview',
    contentHtml,
    fullContentHtml: null, imageUrl: null, isUnread: true, isStarred: false, createdAt: now, updatedAt: now
  }
}
