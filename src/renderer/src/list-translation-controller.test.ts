import { describe, expect, it, vi } from 'vitest'
import type { OrigReadDesktopApi } from '../../shared/contracts'
import type { ArticleRecord } from '../../shared/library'
import type { ListTranslationItem, ListTranslationProgress, ListTranslationRequest, ListTranslationSnapshot, TranslationSettings, TranslationTarget } from '../../shared/translation'
import { listTranslationExcerpt } from '../../shared/translation'
import { ListTranslationController } from './list-translation-controller'

const target: TranslationTarget = { type: 'traditional', provider: 'DEEPL' }
const settings: TranslationSettings = { defaultTarget: target, defaultProvider: 'DEEPL', targetLanguage: 'zh-CN', displayMode: 'TRANSLATED', providers: [] }
const row = (id = 'a'): ArticleRecord => ({ id, accountId: 1, feedId: 'feed', title: `Title ${id}`, description: `Preview ${id}`, contentHtml: 'BODY MUST NOT BE SENT', fullContentHtml: null,
  url: null, author: null, imageUrl: null, isUnread: true, isStarred: false, publishedAt: 0, createdAt: 0, updatedAt: 0 })
const item = (id = 'a'): ListTranslationItem => ({ accountId: 1, feedId: 'feed', articleId: id, title: `Title ${id}`, description: `Preview ${id}`,
  translatedTitle: `标题 ${id}`, translatedDescription: `摘要 ${id}`, target, language: 'zh-CN', cacheKey: 'a'.repeat(64), expiresAt: Date.now() + 100000, showTranslation: true, cacheWriteFailed: false })
const deferred = <T,>() => { let resolve!: (result: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const fixture = () => {
  const api = {
    restoreListTranslations: vi.fn(async (_accountId: number, _articleIds: string[]): Promise<ListTranslationSnapshot> => ({ settings, items: [] })),
    translateList: vi.fn(async (_request: ListTranslationRequest): Promise<ListTranslationProgress> => ({ requestId: '', completed: 0, total: 0, items: [] })),
    stopListTranslation: vi.fn(async () => true), setTranslationVisible: vi.fn(async () => true)
  }
  const controller = new ListTranslationController(api as unknown as OrigReadDesktopApi); controller.reset('feed')
  return { controller, api }
}
describe('list translation ownership and explicit generation', () => {
  it('retains an in-flight local restore when selecting an article stops idle generation', async () => {
    const { controller, api } = fixture()
    const disk = deferred<ListTranslationSnapshot>()
    api.restoreListTranslations.mockReturnValue(disk.promise)
    const pending = controller.restore(1, [row()])
    controller.stop()
    disk.resolve({ settings, items: [item()] })
    await pending
    expect(controller.snapshot().settings).toEqual(settings)
    expect(controller.snapshot().items.get('a')).toMatchObject({ translatedTitle: '标题 a' })
  })

  it('does not let a pre-generation restore overwrite newly generated translations', async () => {
    const { controller, api } = fixture()
    const disk = deferred<ListTranslationSnapshot>()
    api.restoreListTranslations.mockReturnValue(disk.promise)
    const restore = controller.restore(1, [row()])
    api.translateList.mockImplementation(async request => ({ requestId: request.requestId, completed: 1, total: 1,
      items: [{ ...item(), translatedTitle: 'New translation' }] }))
    await controller.translate(1, [row()])
    disk.resolve({ settings, items: [item()] })
    await restore
    expect(controller.snapshot().items.get('a')?.translatedTitle).toBe('New translation')
  })

  it('restores cached display and toggles without generating or passing body HTML', async () => {
    const { controller, api } = fixture()
    api.restoreListTranslations.mockResolvedValue({ settings, items: [item()] })
    await controller.restore(1, [row()])
    expect(api.translateList).not.toHaveBeenCalled()
    await controller.translate(1, [row()])
    expect(controller.snapshot().items.get('a')?.showTranslation).toBe(false)
    await controller.translate(1, [row()])
    expect(controller.snapshot().items.get('a')?.showTranslation).toBe(true)
    expect(api.translateList).not.toHaveBeenCalled()
    expect(api.setTranslationVisible).toHaveBeenCalledTimes(2)
  })
  it('ignores late progress and completion after stopping', async () => {
    const { controller, api } = fixture(); const work = deferred<ListTranslationProgress>()
    api.translateList.mockReturnValue(work.promise)
    const pending = controller.translate(1, [row()])
    const request = api.translateList.mock.calls[0]![0] as unknown as { requestId: string }
    controller.stop()
    controller.progress({ requestId: request.requestId, completed: 1, total: 1, items: [item()] })
    work.resolve({ requestId: request.requestId, completed: 1, total: 1, items: [item()] }); await pending
    expect(controller.snapshot().busy).toBe(false)
    expect(controller.snapshot().items.size).toBe(0)
    expect(api.stopListTranslation).toHaveBeenCalledWith(request.requestId)
  })
  it('does not restore an old scope after navigation', async () => {
    const { controller, api } = fixture(); const disk = deferred<ListTranslationSnapshot>()
    api.restoreListTranslations.mockReturnValue(disk.promise)
    const pending = controller.restore(1, [row()]); controller.reset('different-account')
    disk.resolve({ settings, items: [item()] }); await pending
    expect(controller.snapshot().items.size).toBe(0)
    expect(api.translateList).not.toHaveBeenCalled()
  })
  it('old request completion cannot clear a newer request busy state', async () => {
    const { controller, api } = fixture(); const old = deferred<ListTranslationProgress>(); const newer = deferred<ListTranslationProgress>()
    api.translateList.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
    const first = controller.translate(1, [row()]); const second = controller.translate(1, [row()], { type: 'traditional', provider: 'MICROSOFT' })
    const ids = api.translateList.mock.calls.map(call => (call[0] as unknown as { requestId: string }).requestId)
    old.resolve({ requestId: ids[0]!, completed: 1, total: 1, items: [item()] }); await first
    expect(controller.snapshot().busy).toBe(true)
    newer.resolve({ requestId: ids[1]!, completed: 1, total: 1, items: [{ ...item(), target: { type: 'traditional', provider: 'MICROSOFT' } }] }); await second
    expect(controller.snapshot().busy).toBe(false)
    expect(controller.snapshot().items.get('a')?.target).toEqual({ type: 'traditional', provider: 'MICROSOFT' })
  })
  it('keeps completed rows after a partial failure without retrying', async () => {
    const { controller, api } = fixture(); const work = deferred<ListTranslationProgress>()
    api.translateList.mockReturnValue(work.promise)
    const pending = controller.translate(1, [row(), row('b')])
    const requestId = (api.translateList.mock.calls[0]![0] as unknown as { requestId: string }).requestId
    controller.progress({ requestId, completed: 1, total: 2, items: [item()] })
    work.reject(new Error('fixture failure')); await pending
    expect(controller.snapshot().items.size).toBe(1)
    expect(controller.snapshot().error).toBe('fixture failure')
    expect(api.translateList).toHaveBeenCalledTimes(1)
  })
  it('sends only at most 50 IDs and never an Article body', async () => {
    const { controller, api } = fixture()
    await controller.translate(1, Array.from({ length: 80 }, (_, i) => row(String(i))))
    const request = api.translateList.mock.calls[0]![0] as unknown as { articleIds: string[] }
    expect(request.articleIds).toHaveLength(50)
    expect(JSON.stringify(request)).not.toContain('BODY MUST NOT BE SENT')
  })
  it('does not display an expired or source-mismatched cache entry', async () => {
    const { controller, api } = fixture()
    api.restoreListTranslations.mockResolvedValue({ settings, items: [{ ...item(), title: 'Old title' }, { ...item('b'), expiresAt: Date.now() - 1 }] })
    await controller.restore(1, [row(), row('b')])
    expect(controller.snapshot().items.size).toBe(0)
  })
  it('bounds excerpts by Unicode code points', () => {
    expect(listTranslationExcerpt('😀'.repeat(1100), 1024)).toBe('😀'.repeat(1024))
  })
})
