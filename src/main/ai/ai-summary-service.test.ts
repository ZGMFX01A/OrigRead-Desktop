import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiSettingsRepository } from './ai-settings-repository'
import type { AiRuntimeConfig, OpenAiCompatibleProvider } from './openai-compatible-provider'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import { ReaderContentService } from '../content/reader-content-service'
import { NETWORK_REQUEST_TIMEOUT_MS } from '../network/request-policy'
import { LlmCustomizationSettingsRepository } from '../llm/customization-settings-repository'
import { LlmTaskPromptCustomizer } from '../llm/prompt-customization'
import { LlmSkillRepository } from '../llm/skill-repository'
import {
  AiSummaryService,
  aiSummaryInputBudget,
  extractAiSummaryStreamPreview,
  planAiSummaryBudget,
  prepareArticleForSummary
} from './ai-summary-service'

const databases: DesktopDatabase[] = []
const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) database.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AiSummaryService', () => {
  it('uses the short health-check timeout for explicit provider connection tests', async () => {
    const database = new DesktopDatabase(':memory:')
    databases.push(database)
    const library = new LibraryRepository(database.connection)
    const config = {
      enabled: true,
      defaultProviderId: 'default-provider',
      outputLanguage: 'zh-CN',
      summaryLength: 'STANDARD' as const,
      providers: [{
        id: 'default-provider',
        name: 'Default',
        enabled: true,
        endpoint: 'https://default.example/v1',
        defaultModel: 'default-model',
        models: ['default-model'],
        hasApiKey: true
      }]
    }
    const settings = { current: () => config, getApiKey: () => 'test-key' } as unknown as AiSettingsRepository
    let observedTimeoutMs: number | undefined
    const provider = {
      complete: async (_systemPrompt: string, _userPrompt: string, runtime: AiRuntimeConfig) => {
        observedTimeoutMs = runtime.requestTimeoutMs
        return 'OK'
      }
    } as unknown as OpenAiCompatibleProvider
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, 'unused-cache-dir', provider)

    await service.testProvider('default-provider')

    expect(observedTimeoutMs).toBe(NETWORK_REQUEST_TIMEOUT_MS.AI_PROVIDER_HEALTH)
  })

  it('hides partial metadata from streaming preview and shows body after the comment closes', () => {
    expect(extractAiSummaryStreamPreview('<')).toBe('')
    expect(extractAiSummaryStreamPreview('<!-- origread-summary-v2: {"v":2')).toBe('')
    expect(extractAiSummaryStreamPreview('<!-- origread-summary-v2: {"v":2,"form":"news","domain":"technology"} -->\n正文')).toBe('正文')
    expect(extractAiSummaryStreamPreview('兼容模型直接输出正文')).toBe('兼容模型直接输出正文')
  })

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

  it('uses increasing mode budgets while respecting small provider context windows', () => {
    expect(aiSummaryInputBudget('BRIEF')).toBe(12_000)
    expect(aiSummaryInputBudget('STANDARD')).toBe(24_000)
    expect(aiSummaryInputBudget('DETAILED')).toBe(36_000)

    const fourK = planAiSummaryBudget(4_096, 'system prompt', 'title', 'DETAILED')
    const eightK = planAiSummaryBudget(8_000, 'system prompt', 'title', 'DETAILED')
    expect(fourK.articleCharacterBudget).toBeLessThan(4_096)
    expect(eightK.articleCharacterBudget).toBeGreaterThan(fourK.articleCharacterBudget)
    expect(eightK.articleCharacterBudget).toBeLessThan(8_000)
    expect(fourK.outputReserveTokens).toBe(1_024)
  })

  it('rejects a provider window that cannot fit fixed prompt plus meaningful article input', () => {
    expect(() => planAiSummaryBudget(4_096, '固定提示词'.repeat(4_000), '标题', 'STANDARD')).toThrow(/上下文窗口|正文预算/)
  })

  it('samples the middle of a long structured report instead of keeping only head and tail', () => {
    const chapters = Array.from({ length: 9 }, (_value, index) => {
      const sentinel = index === 4 ? ' MIDDLE-KEY-CHAPTER-SENTINEL ' : ' '
      return `<h2>Chapter ${index}</h2><p>${`chapter-${index}-data `.repeat(50)}${sentinel}</p>`
    }).join('')
    const prepared = prepareArticleForSummary({
      articleId: 'coverage-article',
      mode: 'content',
      html: `<article>${chapters}</article>`,
      sourceUrl: 'https://example.com/report'
    }, 'STANDARD', 2_200)

    expect(prepared.length).toBeLessThanOrEqual(2_200)
    expect(prepared).toContain('Chapter 0')
    expect(prepared).toContain('MIDDLE-KEY-CHAPTER-SENTINEL')
    expect(prepared).toContain('Chapter 8')
    expect(prepared).toContain('[content omitted due to input limit]')
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
      streamDetailed: async (_systemPrompt: string, _userPrompt: string, runtime: AiRuntimeConfig, onDelta: (delta: { content: string; reasoning: string; finishReason: string | null }) => void) => {
        providerCalls += 1
        expect(runtime.temperature).toBe(0)
        onDelta({ content: '<!-- origread-summary-v2: {"v":2,"form":"analysis","domain":"technology"} -->\nalternate summary', reasoning: '', finishReason: 'stop' })
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

  it('applies the fixed Summary Skill and Custom Instructions and isolates cache variants when preferences change', async () => {
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
      providers: [{ id: 'default-provider', name: 'Default', enabled: true, endpoint: 'https://default.example/v1', defaultModel: 'default-model', models: ['default-model'], hasApiKey: true }]
    }
    const aiSettings = { current: () => config, getApiKey: () => 'test-key' } as unknown as AiSettingsRepository
    const skills = new LlmSkillRepository(database.connection)
    const customization = new LlmCustomizationSettingsRepository(database.connection)
    await skills.createFromMarkdown(`---\nname: summary-evidence\ndescription: Evidence-focused summary.\n---\nPreserve quantitative evidence and explicit limitations.`)
    skills.setBinding('SUMMARY', 'summary-evidence')
    customization.update({ customInstructions: 'Prefer compact prose.' })
    const customizer = new LlmTaskPromptCustomizer(skills, customization)
    const systemPrompts: string[] = []
    const provider = {
      streamDetailed: async (systemPrompt: string) => {
        systemPrompts.push(systemPrompt)
        return {
          content: '<!-- origread-summary-v2: {"v":2,"form":"analysis","domain":"technology"} -->\n定制摘要',
          reasoning: null
        }
      }
    } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-d4-'))
    tempDirs.push(cacheDir)
    const service = new AiSummaryService(library, new ReaderContentService(library), aiSettings, cacheDir, provider, customizer)

    await service.summarize('article-1', true)
    expect(systemPrompts).toHaveLength(1)
    expect(systemPrompts[0]).toContain('<origread_user_skill id="summary-evidence">')
    expect(systemPrompts[0]).toContain('Preserve quantitative evidence and explicit limitations.')
    expect(systemPrompts[0]).toContain('<origread_user_custom_instructions>')
    expect(systemPrompts[0]).toContain('Prefer compact prose.')

    await service.summarize('article-1')
    expect(systemPrompts).toHaveLength(1)

    customization.update({ customInstructions: 'Use short paragraphs.' })
    await service.summarize('article-1')
    expect(systemPrompts).toHaveLength(2)
    expect(systemPrompts[1]).toContain('Use short paragraphs.')
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
    const provider = { streamDetailed: async () => { providerCalls += 1; return { content: 'should not happen', reasoning: null } } } as unknown as OpenAiCompatibleProvider
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

  it('force refresh bypasses the local concise-article gate and really calls the provider', async () => {
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
      streamDetailed: async () => {
        providerCalls += 1
        return { content: '<!-- origread-summary-v2: {"v":2,"form":"flash","domain":"technology"} -->\n重新生成的摘要', reasoning: null }
      }
    } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-'))
    tempDirs.push(cacheDir)
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, cacheDir, provider)

    const result = await service.summarize('article-1', true)
    expect(result).toMatchObject({ status: 'GENERATED', summary: '重新生成的摘要', articleForm: 'flash', domain: 'technology' })
    expect(providerCalls).toBe(1)
  })

  it('aggregates summary timings without logging prompts, API keys, or authorization data', async () => {
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
      providers: [{ id: 'default-provider', name: 'Default', enabled: true, endpoint: 'https://default.example/v1', defaultModel: 'default-model', models: ['default-model'], hasApiKey: true }]
    }
    const secret = 'super-secret-api-key'
    const settings = { current: () => config, getApiKey: () => secret } as unknown as AiSettingsRepository
    const provider = {
      streamDetailed: async (_systemPrompt: string, _userPrompt: string, runtime: AiRuntimeConfig) => {
        runtime.onTiming?.({ metric: 'request_start', elapsedMs: 0 })
        runtime.onTiming?.({ metric: 'TTFB', elapsedMs: 12.3 })
        runtime.onTiming?.({ metric: 'first_sse', elapsedMs: 18.4 })
        runtime.onTiming?.({ metric: 'TTFR', elapsedMs: 25.5 })
        runtime.onTiming?.({ metric: 'TTFC', elapsedMs: 41.6 })
        return {
          content: '<!-- origread-summary-v2: {"v":2,"form":"analysis","domain":"technology"} -->\n性能摘要正文',
          reasoning: '性能推理'
        }
      }
    } as unknown as OpenAiCompatibleProvider
    const cacheDir = mkdtempSync(join(tmpdir(), 'origread-ai-summary-'))
    tempDirs.push(cacheDir)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const service = new AiSummaryService(library, new ReaderContentService(library), settings, cacheDir, provider)

    await service.summarize('article-1', true)

    const perfCall = info.mock.calls.find(([prefix]) => prefix === '[OrigRead][AI Perf]')
    expect(perfCall).toBeDefined()
    const perf = JSON.parse(String(perfCall?.[1])) as Record<string, unknown>
    expect(perf).toMatchObject({
      task: 'summary',
      TTFB_ms: 12.3,
      first_sse_ms: 18.4,
      TTFR_ms: 25.5,
      TTFC_ms: 41.6,
      streaming: true,
      outcome: 'generated'
    })
    expect(Number(perf.prepare_ms)).toBeGreaterThanOrEqual(0)
    expect(Number(perf.request_start_ms)).toBeGreaterThanOrEqual(Number(perf.prepare_ms))
    expect(Number(perf.total_ms)).toBeGreaterThanOrEqual(Number(perf.request_start_ms))
    const serializedLogs = JSON.stringify(info.mock.calls)
    expect(serializedLogs).not.toContain(secret)
    expect(serializedLogs).not.toContain('You are')
    expect(serializedLogs).not.toContain('Authorization')
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
      streamDetailed: async () => {
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
