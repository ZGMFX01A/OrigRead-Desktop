import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LibraryRepository } from '../database/library-repository'
import { DEFAULT_GROUP_ID } from '../database/migrations'
import type { ArticleRecord, FeedRecord } from '../../shared/library'
import type { TranslationSettings, TranslationTarget } from '../../shared/translation'
import type { OpenAiCompatibleProvider } from '../ai/openai-compatible-provider'
import { TranslationService } from './translation-service'
import { TRANSLATION_TTL } from './translation-cache'

const target: TranslationTarget = { type: 'ai', providerId: 'ai', providerName: 'Fixture', model: 'fixture-model' }
describe('desktop list/body persistence with the real library schema', () => {
  let directory: string, database: DesktopDatabase, library: LibraryRepository, now: number, service: TranslationService
  let settings: TranslationSettings, enabled: boolean
  let requests: string[], beforeResponse: (() => Promise<void>) | undefined
  const reader = { get: vi.fn((id: string) => ({ articleId: id, html: library.getArticleById(id)?.contentHtml ?? '' })) }
  const provider = { completeDetailed: async (_system: string, user: string, _config: unknown, signal?: AbortSignal) => {
    requests.push(user)
    await beforeResponse?.()
    signal?.throwIfAborted()
    const fragments = (JSON.parse(user) as { fragments: Array<{ id: number; text: string }> }).fragments
    return { content: JSON.stringify({ translations: fragments.map(item => ({ id: item.id, text: `译:${item.text}` })) }), reasoning: null }
  } } as unknown as OpenAiCompatibleProvider
  const create = (): TranslationService => new TranslationService(library, reader as never, { current: () => settings } as never,
    { current: () => ({ enabled, providers: [{ id: 'ai', enabled: true, name: 'Fixture', endpoint: 'https://fixture.invalid/v1', models: ['fixture-model'], defaultModel: 'fixture-model' }] }), getApiKey: () => 'fixture-not-a-secret' } as never,
    directory, provider, undefined, () => now)
  const add = (id: string): void => { library.upsertArticle({ id, accountId: 1, feedId: 'feed', title: `Title ${id}`, description: `Preview ${id}`,
    contentHtml: '<p>BODY_ONLY_SENTINEL</p><p>Second body paragraph.</p>', fullContentHtml: null,
    imageUrl: null, author: null, url: `https://fixture.invalid/${id}`, publishedAt: now,
    isUnread: true, isStarred: false, createdAt: now, updatedAt: now } satisfies ArticleRecord) }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'origread-translation-parity-')); now = Date.now()
    database = new DesktopDatabase(join(directory, 'reader.db')); library = new LibraryRepository(database.connection)
    library.upsertFeed({ id: 'feed', accountId: 1, groupId: DEFAULT_GROUP_ID, name: 'Fixture', url: 'https://fixture.invalid/feed', sourcePageUrl: 'https://fixture.invalid', sourceType: 'rss', icon: null,
      isNotification: false, isFullContent: false, isBrowser: false, dynamicRendering: false, createdAt: now, updatedAt: now } satisfies FeedRecord)
    settings = { defaultTarget: target, defaultProvider: 'DEEPL', displayMode: 'TRANSLATED', targetLanguage: 'zh-CN', providers: [] }
    requests = []; enabled = true; beforeResponse = undefined; reader.get.mockClear(); add('a'); service = create()
  })
  afterEach(async () => { await service.dispose(); database.close(); await rm(directory, { recursive: true, force: true }) })
  const list = (ids = ['a']) => service.translateList({ requestId: 'click', accountId: 1, articleIds: ids, target }, new AbortController().signal, () => {})

  it('restores nothing without generating, then saves list previews without reading any body', async () => {
    expect((await service.restoreList(1, ['a'])).items).toEqual([])
    expect(await service.restoreArticle('a')).toBeNull()
    expect(requests).toEqual([]); reader.get.mockClear()
    await list()
    expect(reader.get).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toContain('BODY_ONLY_SENTINEL')
    const payload = JSON.parse(requests[0]!)
    expect(payload.fragments.map((item: { text: string }) => item.text)).toEqual(['Title a', 'Preview a'])
    expect(payload.previousTranslations).toEqual([])
  })
  it('reopens database and caches, restores with disabled channel, rerenders mode locally', async () => {
    await list(); await service.translateArticle('a', target)
    expect(requests).toHaveLength(2)
    await service.dispose(); database.close()
    database = new DesktopDatabase(join(directory, 'reader.db')); library = new LibraryRepository(database.connection); service = create()
    enabled = false; settings = { ...settings, displayMode: 'BILINGUAL' }
    expect((await service.restoreList(1, ['a'])).items[0]?.translatedTitle).toBe('译:Title a')
    const full = await service.restoreArticle('a')
    expect(full?.displayMode).toBe('BILINGUAL')
    expect(full?.translatedContent).toContain('BODY_ONLY_SENTINEL')
    expect(full?.translatedContent).toContain('译:BODY_ONLY_SENTINEL')
    await list(); await service.translateArticle('a', target)
    expect(requests).toHaveLength(2)
    expect(library.getArticleById('a')).toMatchObject({ title: 'Title a', description: 'Preview a', isUnread: true, isStarred: false })
  })
  it('preserves show-original choice without extending 30-day lifetime', async () => {
    const result = await service.translateArticle('a', target)
    await service.setVisible(1, 'a', 'FULL', result.cacheKey!, false)
    now += 1000
    expect((await service.restoreArticle('a'))?.showTranslation).toBe(false)
    now = result.expiresAt!
    expect(await service.restoreArticle('a')).toBeNull()
    expect(requests).toHaveLength(1)
  })
  it('does not treat application shutdown during cleanup as deleted articles', async () => {
    await list()
    await Promise.all([service.maintain(), service.dispose()])
    service = create()
    expect((await service.restoreList(1, ['a'])).items[0]?.translatedTitle).toBe('译:Title a')
    expect(requests).toHaveLength(1)
  })
  it('invalidates changed input and never uses list data as body data', async () => {
    await list(); expect(await service.restoreArticle('a')).toBeNull()
    library.upsertArticle({ ...library.getArticleById('a')!, title: 'Changed title' })
    expect((await service.restoreList(1, ['a'])).items).toEqual([])
    await list(); expect(requests).toHaveLength(2)
  })
  it('rejects wrong accounts and drops a late response after feed deletion', async () => {
    await expect(service.restoreList(2, ['a'])).rejects.toThrow('账户')
    beforeResponse = async () => { database.connection.prepare('DELETE FROM feeds WHERE id = ?').run('feed') }
    await expect(list()).rejects.toThrow('删除')
    expect((await service.restoreList(1, ['a'])).items).toEqual([])
    await service.maintain()
  })
  it('does not persist cancelled or partial body translations', async () => {
    const controller = new AbortController()
    beforeResponse = async () => controller.abort(new Error('Stopped'))
    await expect(service.translateArticle('a', target, false, controller.signal)).rejects.toThrow('Stopped')
    expect(await service.restoreArticle('a')).toBeNull()
  })
  it('limits an explicit list request to 50 articles even for an internal caller', async () => {
    for (let index = 0; index < 55; index++) add(`article-${index}`)
    const result = await list(Array.from({ length: 55 }, (_, index) => `article-${index}`))
    expect(result.items).toHaveLength(50)
    expect(result.completed).toBe(50)
    expect(requests.every(raw => !raw.includes('BODY_ONLY_SENTINEL'))).toBe(true)
    expect(requests.join('')).not.toContain('Title article-50')
  })
  it('expires both kinds without scheduling replacement translations', async () => {
    await list(); await service.translateArticle('a', target); const calls = requests.length
    now += TRANSLATION_TTL; await service.maintain()
    expect((await service.restoreList(1, ['a'])).items).toEqual([])
    expect(await service.restoreArticle('a')).toBeNull()
    expect(requests).toHaveLength(calls)
  })
})
