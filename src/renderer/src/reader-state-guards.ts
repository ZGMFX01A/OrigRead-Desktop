import type { ArticleRecord, FeedArticleStats, LibrarySnapshot, RecentArticleRecord } from '../../shared/library'

/** A monotonic generation also rejects A -> B -> A responses. */
export function isCurrentGeneration(ref: { current: number }, generation: number): boolean {
  return ref.current === generation
}

/** Epoch alone cannot reject a prior execution's snapshot in the same conversation. */
export function isCurrentChatSnapshot(
  session: { current: number }, epoch: number, snapshots: { current: number }, sequence: number
): boolean {
  return isCurrentGeneration(session, epoch) && isCurrentGeneration(snapshots, sequence)
}

export type ArticleFlag = 'isUnread' | 'isStarred'
export interface ReaderArticleState {
  articles: ArticleRecord[]
  scopeArticles: ArticleRecord[] | null
  readArticles: ArticleRecord[] | null
  recentArticles: RecentArticleRecord[]
  selectedArticleRecord: ArticleRecord | null
  feedArticleStats: FeedArticleStats[]
  librarySnapshot: LibrarySnapshot | null
}

export function optimisticArticleFlag(state: ReaderArticleState, article: ArticleRecord, flag: ArticleFlag, next: boolean): {
  state: ReaderArticleState
  apply: (current: ReaderArticleState) => ReaderArticleState
  rollback: (current: ReaderArticleState, restoreCounts?: boolean) => ReaderArticleState
} {
  const previous = article[flag]
  const count = flag === 'isUnread' ? 'unread' : 'starred'
  const delta = Number(next) - Number(previous)
  const readIndex = state.readArticles?.findIndex((item) => item.id === article.id) ?? -1
  const readRecord = readIndex >= 0 ? state.readArticles![readIndex]! : null
  const insertedRead = flag === 'isUnread' && !next && readIndex < 0
  const matches = (item: ArticleRecord): boolean => item.id === article.id && item.accountId === article.accountId
  const patch = <T extends ArticleRecord>(items: T[], value: boolean): T[] =>
    items.map((item) => matches(item) ? { ...item, [flag]: value } : item)
  const update = (current: ReaderArticleState, value: boolean, undo: boolean, restoreCounts = true): ReaderArticleState => {
    let read = current.readArticles
    if (read) {
      read = patch(read, value)
      if (flag === 'isUnread') {
        if (value || (undo && insertedRead)) read = read.filter((item) => !matches(item))
        else if (!read.some(matches)) {
          const latest = current.articles.find(matches) ?? current.scopeArticles?.find(matches)
            ?? current.selectedArticleRecord ?? readRecord ?? article
          const restored = { ...(matches(latest) ? latest : readRecord ?? article), [flag]: value }
          const index = undo && readIndex >= 0 ? Math.min(readIndex, read.length) : 0
          read = [...read.slice(0, index), restored, ...read.slice(index)]
        }
      }
    }
    return {
      articles: patch(current.articles, value),
      scopeArticles: current.scopeArticles ? patch(current.scopeArticles, value) : null,
      readArticles: read,
      recentArticles: patch(current.recentArticles, value),
      selectedArticleRecord: current.selectedArticleRecord && matches(current.selectedArticleRecord)
        ? { ...current.selectedArticleRecord, [flag]: value } : current.selectedArticleRecord,
      feedArticleStats: undo && !restoreCounts ? current.feedArticleStats : current.feedArticleStats.map((stats) => stats.feedId === article.feedId
        ? { ...stats, [count]: stats[count] + (undo ? -feedDelta : feedDelta) } : stats),
      librarySnapshot: undo && !restoreCounts ? current.librarySnapshot : current.librarySnapshot
        ? { ...current.librarySnapshot, [count]: current.librarySnapshot[count] + (undo ? -libraryDelta : libraryDelta) } : null
    }
  }
  // Record the actual clamped difference so undo remains exact at zero as well.
  const feedCount = state.feedArticleStats.find((item) => item.feedId === article.feedId)?.[count] ?? 0
  const feedDelta = Math.max(0, feedCount + delta) - feedCount
  const libraryCount = state.librarySnapshot?.[count] ?? 0
  const libraryDelta = Math.max(0, libraryCount + delta) - libraryCount
  return { state: update(state, next, false), apply: (current) => update(current, next, false), rollback: (current, restoreCounts = true) => update(current, previous, true, restoreCounts) }
}

/** Starting an execution is an external side effect: stale completions must be cancelled. */
export async function acceptChatExecution<T extends { requestId: string }>(
  ref: { current: number }, epoch: number, identity: T, cancel: (requestId: string) => Promise<unknown>
): Promise<boolean> {
  if (isCurrentGeneration(ref, epoch)) return true
  await cancel(identity.requestId)
  return false
}

export function recoverUnsentChatDraft(current: string, sentDraft: string, userMessagePersisted: boolean): string {
  return userMessagePersisted ? current : current || sentDraft
}
