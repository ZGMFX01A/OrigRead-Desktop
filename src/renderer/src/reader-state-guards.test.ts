import { describe, expect, it, vi } from 'vitest'
import { acceptChatExecution, recoverUnsentChatDraft, isCurrentChatSnapshot, isCurrentGeneration, optimisticArticleFlag, type ReaderArticleState } from './reader-state-guards'
import type { ArticleRecord } from '../../shared/library'

function fixture(unread = true): ReaderArticleState {
  const article: ArticleRecord = { id: 'a', accountId: 1, feedId: 'f', title: 'a', url: null, author: null,
    publishedAt: 1, description: '', contentHtml: null, fullContentHtml: null, imageUrl: null,
    isUnread: unread, isStarred: false, createdAt: 1, updatedAt: 1 }
  return { articles: [article], scopeArticles: [article], readArticles: unread ? [] : [article],
    recentArticles: [{ ...article, lastOpenedAt: 3 }], selectedArticleRecord: article,
    feedArticleStats: [{ feedId: 'f', total: 1, unread: Number(unread), starred: 0 }],
    librarySnapshot: { groups: 1, feeds: 1, articles: 1, unread: Number(unread), starred: 0 } }
}

describe('reader request generations', () => {
  it.each(['previous terminal', 'pending conversation history'])('drops the %s snapshot when the next request starts in the same session', async () => {
    const session = { current: 1 }
    const snapshots = { current: 1 }
    const epoch = session.current
    const seq = snapshots.current
    let resolve!: (messages: string[]) => void
    const pending = new Promise<string[]>((done) => { resolve = done })
    let messages = ['old assistant', 'new user', 'new streaming assistant']
    const reading = pending.then((result) => {
      if (isCurrentChatSnapshot(session, epoch, snapshots, seq)) messages = result
    })
    // A send or newer history load changes only the snapshot sequence, not the session.
    snapshots.current++
    resolve(['old assistant'])
    await reading
    expect(messages).toEqual(['old assistant', 'new user', 'new streaming assistant'])
  })

  it('accepts the newest tool snapshot and rejects an older tool response delivered afterward', async () => {
    const session = { current: 4 }
    const snapshots = { current: 0 }
    let activity = 'initial'
    let resolveOld!: (value: string) => void
    const old = new Promise<string>((done) => { resolveOld = done })
    const oldSeq = ++snapshots.current
    const readingOld = old.then((value) => {
      if (isCurrentChatSnapshot(session, 4, snapshots, oldSeq)) activity = value
    })
    const newSeq = ++snapshots.current
    if (isCurrentChatSnapshot(session, 4, snapshots, newSeq)) activity = 'newest'
    resolveOld('old')
    await readingOld
    expect(activity).toBe('newest')
    session.current++
    expect(isCurrentChatSnapshot(session, 4, snapshots, newSeq)).toBe(false)
  })

  it('cancels a late startLlmExecution identity instead of accepting it into a new session', async () => {
    const epoch = { current: 1 }
    const cancel = vi.fn(async (_requestId: string) => undefined)
    expect(await acceptChatExecution(epoch, 1, { requestId: 'current' }, cancel)).toBe(true)
    epoch.current++
    expect(await acceptChatExecution(epoch, 1, { requestId: 'stale' }, cancel)).toBe(false)
    expect(cancel).toHaveBeenCalledExactlyOnceWith('stale')
  })

  it('keeps failed unsent drafts without duplicating a persisted message or overwriting new input', () => {
    expect(recoverUnsentChatDraft('', 'draft', false)).toBe('draft')
    expect(recoverUnsentChatDraft('new typing', 'draft', false)).toBe('new typing')
    expect(recoverUnsentChatDraft('', 'persisted message', true)).toBe('')
    expect(recoverUnsentChatDraft('new typing', 'persisted message', true)).toBe('new typing')
  })

  it('rejects old chat results even after returning to the same session/article', async () => {
    const epoch = { current: 1 }
    const captured = epoch.current
    let resolve!: (value: string) => void
    const pending = new Promise<string>((done) => { resolve = done })
    let current = 'new session'
    const response = pending.then((value) => { if (isCurrentGeneration(epoch, captured)) current = value })
    epoch.current += 2
    resolve('old session')
    await response
    expect(current).toBe('new session')
  })

  it('drops out-of-order search results and stale errors/finally after close, clear, or reopen', async () => {
    for (const action of ['new query', 'close', 'clear', 'reopen']) {
      const sequence = { current: 1 }
      const captured = sequence.current
      const state = { results: 'new results', error: null as string | null, loading: true }
      let reject!: (error: Error) => void
      const pending = new Promise<string>((_, fail) => { reject = fail })
      const response = pending.then((value) => {
        if (isCurrentGeneration(sequence, captured)) state.results = value
      }).catch((error: Error) => {
        if (isCurrentGeneration(sequence, captured)) state.error = error.message
      }).finally(() => {
        if (isCurrentGeneration(sequence, captured)) state.loading = false
      })
      sequence.current++
      reject(new Error(action))
      await response
      expect(state).toEqual({ results: 'new results', error: null, loading: true })
    }
  })
})

describe('optimistic article rollback', () => {
  it.each(['isUnread', 'isStarred'] as const)('does not reverse refreshed persisted %s counts a second time', (flag) => {
    const before = fixture()
    const change = optimisticArticleFlag(before, before.articles[0]!, flag, !before.articles[0]![flag])
    // A library refresh replaced counters with persisted values while source/selection
    // snapshots can still contain optimistic flags. Only counters have a new publication.
    const refreshed = { ...change.state, articles: before.articles,
      feedArticleStats: before.feedArticleStats, librarySnapshot: before.librarySnapshot }
    const restored = change.rollback(refreshed, false)
    expect(restored).toEqual(before)
  })

  it.each(['isUnread', 'isStarred'] as const)('restores all seven states for %s without mutating the snapshot', (flag) => {
    const before = fixture()
    const saved = structuredClone(before)
    const change = optimisticArticleFlag(before, before.articles[0]!, flag, !before.articles[0]![flag])
    expect(change.state.articles[0]![flag]).toBe(!before.articles[0]![flag])
    expect(change.rollback(change.state)).toEqual(saved)
    expect(before).toEqual(saved)
  })

  it('reinserts a removed read article at its position, preserving concurrent star changes and other counters', () => {
    const before = fixture(false)
    const other = { ...before.articles[0]!, id: 'b' }
    before.readArticles = [other, before.articles[0]!]
    const unreadChange = optimisticArticleFlag(before, before.articles[0]!, 'isUnread', true)
    expect(unreadChange.state.readArticles?.map((item) => item.id)).toEqual(['b'])
    const starChange = optimisticArticleFlag(unreadChange.state, unreadChange.state.articles[0]!, 'isStarred', true)
    const current = { ...starChange.state, librarySnapshot: { ...starChange.state.librarySnapshot!, unread: 3 } }
    const restored = unreadChange.rollback(current)
    expect(restored.readArticles?.map((item) => item.id)).toEqual(['b', 'a'])
    expect(restored.readArticles?.[1]).toMatchObject({ isUnread: false, isStarred: true })
    expect(restored.librarySnapshot).toMatchObject({ unread: 2, starred: 1 })
    expect(restored.feedArticleStats[0]).toMatchObject({ unread: 0, starred: 1 })
    expect(restored.recentArticles[0]?.lastOpenedAt).toBe(3)
  })

  it('undoes only the actual count delta when a stale count was already zero', () => {
    const before = fixture()
    before.feedArticleStats[0]!.unread = 0
    before.librarySnapshot!.unread = 0
    const change = optimisticArticleFlag(before, before.articles[0]!, 'isUnread', false)
    expect(change.rollback(change.state)).toEqual(before)
  })

  it('does not restore a stale selected article after switching selection', () => {
    const before = fixture()
    const change = optimisticArticleFlag(before, before.articles[0]!, 'isStarred', true)
    const selected = { ...before.articles[0]!, id: 'b' }
    const restored = change.rollback({ ...change.state, selectedArticleRecord: selected })
    expect(restored.selectedArticleRecord).toEqual(selected)
  })
})
