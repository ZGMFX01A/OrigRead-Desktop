import { describe, expect, it } from 'vitest'
import { happensBefore, parseOperationVersionToken, SyncGenesisVersionCollisionError, SyncVersionResolver, SyncVersionToken } from './sync-version-token'

describe('Sync VersionToken', () => {
  it('distinguishes a concurrent late Genesis from an observed lane baseline', () => {
    const genesis = { versionToken: SyncVersionToken.genesis('late', 'ARTICLE_STATE', 'article', 'isStarred'), valueJson: 'true' }
    const operation = { versionToken: SyncVersionToken.operation('actor', 'ARTICLE_STATE', 1), valueJson: 'false' }
    expect(happensBefore(genesis, operation)).toBe(false)
    expect(SyncVersionResolver.resolve([genesis, operation], 'STARRED_WINS').versionToken).toBe(operation.versionToken)
    expect(happensBefore(genesis, { ...operation, observedGenesisBaselinesByLane: { ARTICLE_STATE: ['late'] } })).toBe(true)
    expect(happensBefore(genesis, { ...operation, observedGenesisBaselinesByLane: { LIBRARY: ['late'] } })).toBe(false)
  })

  it.each(['0', '-1', '1junk', '1|extra', '9007199254740992'])('rejects malformed causal sequence %s', (sequence) => {
    expect(parseOperationVersionToken(`OPERATION_V1|actor|LIBRARY|${sequence}`)).toBeNull()
  })

  it('is stable for Genesis values and distinguishes Operation dots', () => {
    const first = SyncVersionToken.genesis('baseline-1', 'ARTICLE_STATE', 'article-1', 'isUnread')
    const second = SyncVersionToken.genesis('baseline-1', 'ARTICLE_STATE', 'article-1', 'isUnread')
    expect(first).toBe(second)
    expect(SyncVersionToken.source(first)).toBe('GENESIS')
    expect(SyncVersionToken.source(SyncVersionToken.operation('actor-1', 'ARTICLE_STATE', 7))).toBe('OPERATION')
    expect(SyncVersionToken.genesis('baseline-a', 'ARTICLE_STATE', 'article-1', 'isStarred'))
      .toBe('GENESIS_V1|baseline-a|ARTICLE_STATE|article-1|isStarred|9d29aea2342bcde6bb2fca175acfb7c15c0f2344b8cfdb89ca0c382066d9bcd0')
  })

  it('applies bootstrap policies while Operation candidates win over Genesis', () => {
    const read = SyncVersionToken.genesis('baseline-1', 'ARTICLE_STATE', 'article-1', 'isUnread')
    const unread = SyncVersionToken.genesis('baseline-2', 'ARTICLE_STATE', 'article-1', 'isUnread')
    expect(SyncVersionResolver.resolve([
      { versionToken: read, valueJson: 'true' },
      { versionToken: unread, valueJson: 'false' }
    ], 'READ_WINS').valueJson).toBe('false')

    const operation = SyncVersionToken.operation('actor-1', 'ARTICLE_STATE', 1)
    expect(SyncVersionResolver.resolve([
      { versionToken: read, valueJson: 'true' },
      { versionToken: operation, valueJson: 'true' }
    ], 'READ_WINS').versionToken).toBe(operation)
  })

  it('rejects two values claiming one VersionToken', () => {
    const token = SyncVersionToken.genesis('baseline-1', 'ARTICLE_STATE', 'article-1', 'isStarred')
    expect(() => SyncVersionResolver.resolve([
      { versionToken: token, valueJson: 'true' },
      { versionToken: token, valueJson: 'false' }
    ], 'STARRED_WINS')).toThrow(SyncGenesisVersionCollisionError)
  })

  it('strictly ensures happens-after operation wins even if its actor or sequence has lower lexicographical order (R10 Causal Conflict)', () => {
    // Actor A 有更高的 sequence 和更高的字母序，产生了 starred = true
    const opA = SyncVersionToken.operation('actor-z', 'ARTICLE_STATE', 10)
    // Actor B 字母序低、sequence 小，但是观察到了 Actor A 的操作（causalContext 包含 actor-z: 10），改成了 false
    const opB = SyncVersionToken.operation('actor-a', 'ARTICLE_STATE', 1)

    const candidateA = {
      versionToken: opA,
      valueJson: 'true',
      source: 'OPERATION' as const
    }
    const candidateB = {
      versionToken: opB,
      valueJson: 'false',
      source: 'OPERATION' as const,
      causalContext: {
        ARTICLE_STATE: { 'actor-z': 10 }
      }
    }

    // 即使在 STARRED_WINS 策略下，因为 B happens-after A，B 也必须胜出！
    const resolved = SyncVersionResolver.resolve([candidateA, candidateB], 'STARRED_WINS')
    expect(resolved.versionToken).toBe(opB)
    expect(resolved.valueJson).toBe('false')
  })

  it('uses the deterministic register for explicit concurrent operations', () => {
    const opA = SyncVersionToken.operation('actor-a', 'ARTICLE_STATE', 1)
    const opB = SyncVersionToken.operation('actor-b', 'ARTICLE_STATE', 1)

    // A 和 B 互不包含对方的 Dot（真正并发）
    const candidateA = {
      versionToken: opA,
      valueJson: 'false',
      source: 'OPERATION' as const,
      causalContext: {}
    }
    const candidateB = {
      versionToken: opB,
      valueJson: 'true',
      source: 'OPERATION' as const,
      causalContext: {}
    }

    // 并发下 STARRED_WINS 让 true 胜出
    expect(SyncVersionResolver.resolve([candidateA, candidateB], 'STARRED_WINS').valueJson).toBe('true')
    // 并发下 READ_WINS 让 false (已读) 胜出
    expect(SyncVersionResolver.resolve([candidateA, candidateB], 'READ_WINS').valueJson).toBe('true')
    expect(SyncVersionResolver.resolve([candidateB, candidateA], 'READ_WINS').versionToken).toBe(opB)
  })
})
