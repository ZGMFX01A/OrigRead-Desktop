import { describe, expect, it } from 'vitest'
import type { LlmCitationEvidenceCandidate } from './citation-protocol'
import { buildCitationPersistenceFromAssistantOutput, buildCitationRefsFromAssistantOutput, prepareCitationProtocol, resolveAssistantCitationTokens, stripHistoricalCitationProtocolTokens } from './citation-protocol'
import { LlmContextComposer } from './context-composer'

describe('D2.9 citation protocol', () => {
  it('assigns E IDs only to complete evidence blocks that actually entered the prompt', () => {
    const composed = new LlmContextComposer().compose([{
      id: 'article', type: 'ARTICLE', content: 'all', evidenceBlocks: [
        { stableLocatorKey: 'block-a', content: 'Short A' },
        { stableLocatorKey: 'block-too-large', content: '中'.repeat(300) },
        { stableLocatorKey: 'block-b', content: 'Short B' }
      ]
    }], { maxTokens: 100 })
    const prepared = prepareCitationProtocol(composed, [
      candidate('block-a', 'evidence-a'),
      candidate('block-too-large', 'evidence-large'),
      candidate('block-b', 'evidence-b')
    ])

    expect(prepared.protocolEntries.map((entry) => [entry.stableLocatorKey, entry.protocolId])).toEqual([
      ['block-a', 'E1'],
      ['block-b', 'E2']
    ])
    expect(prepared.text).toContain('[ORIGREAD_EVIDENCE id="E1"]')
    expect(prepared.text).toContain('[ORIGREAD_EVIDENCE id="E2"]')
    expect(prepared.text).not.toContain('block-too-large')
    expect(prepared.instruction).toContain('[[E1]]')
  })

  it('does not resolve hallucinated or omitted evidence IDs', () => {
    const entries = [
      { ...candidate('block-a', 'evidence-a'), protocolId: 'E1' },
      { ...candidate('block-b', 'evidence-b'), protocolId: 'E2' }
    ]
    const resolved = resolveAssistantCitationTokens('Claim [[E1]] fake [[E999]] repeated [[E1]]', entries)
    expect(resolved.validProtocolIds).toEqual(['E1'])
    expect(resolved.invalidProtocolIds).toEqual(['E999'])
    expect(resolved.annotations.map((item) => item.protocolIds)).toEqual([['E1'], ['E1']])
    expect(resolved.canonicalText).not.toContain('[[E')
  })

  it('persists only valid cited evidence and keeps stable identity separate from display order', () => {
    const entries = [
      { ...candidate('block-a', 'evidence-a'), protocolId: 'E1' },
      { ...candidate('block-b', 'evidence-b'), protocolId: 'E2' }
    ]
    let id = 0
    const result = buildCitationRefsFromAssistantOutput(
      'Second source first [[E2]], then first [[E1]], bad [[E404]].',
      entries,
      { conversationId: 'conversation', assistantMessageId: 'assistant' },
      { now: 100, idFactory: () => `citation-${++id}` }
    )
    expect(result.invalidProtocolIds).toEqual(['E404'])
    expect(result.refs.map((ref) => [ref.id, ref.protocolId, ref.displayOrder, ref.evidenceBlockId])).toEqual([
      ['citation-1', 'E2', 1, 'evidence-b'],
      ['citation-2', 'E1', 2, 'evidence-a']
    ])
  })

  it('persists compact/repeated Citation occurrences independently from stable refs', () => {
    const entries = [
      { ...candidate('block-a', 'evidence-a'), protocolId: 'E1' },
      { ...candidate('block-b', 'evidence-b'), protocolId: 'E2' }
    ]
    let refId = 0
    let annotationId = 0
    const result = buildCitationPersistenceFromAssistantOutput(
      'First [[E1][E2]], repeat [[E1]].',
      entries,
      { conversationId: 'conversation', assistantMessageId: 'assistant' },
      {
        now: 100,
        refIdFactory: () => `ref-${++refId}`,
        annotationIdFactory: () => `annotation-${++annotationId}`
      }
    )
    expect(result.canonicalText).toBe('First, repeat.')
    expect(result.refs.map((ref) => ref.protocolId)).toEqual(['E1', 'E2'])
    expect(result.annotations.map((annotation) => [annotation.id, annotation.canonicalInsertionOffset, annotation.occurrenceOrdinal])).toEqual([
      ['annotation-1', 5, 0],
      ['annotation-2', 13, 1]
    ])
    expect(result.annotationRefs).toEqual([
      { annotationId: 'annotation-1', citationRefId: 'ref-1', refOrdinal: 0 },
      { annotationId: 'annotation-1', citationRefId: 'ref-2', refOrdinal: 1 },
      { annotationId: 'annotation-2', citationRefId: 'ref-1', refOrdinal: 0 }
    ])
  })

  it('keeps identical locator keys in separate context items distinct', () => {
    const composed = new LlmContextComposer().compose([
      { id: 'article:a', type: 'ARTICLE', content: 'A', evidenceBlocks: [{ stableLocatorKey: 'same', content: 'A' }] },
      { id: 'article:b', type: 'ADDITIONAL_ARTICLE', content: 'B', evidenceBlocks: [{ stableLocatorKey: 'same', content: 'B' }] }
    ], { maxTokens: 200 })
    const a = { ...candidate('same', 'evidence-a'), contextId: 'article:a', contextRefId: 'context-a' }
    const b = { ...candidate('same', 'evidence-b'), contextId: 'article:b', contextRefId: 'context-b' }
    const prepared = prepareCitationProtocol(composed, [a, b])
    expect(prepared.protocolEntries.map((entry) => [entry.contextId, entry.protocolId])).toEqual([
      ['article:a', 'E1'],
      ['article:b', 'E2']
    ])
  })

  it('uses the canonical parser to strip malformed historical request-local transport', () => {
    expect(stripHistoricalCitationProtocolTokens('Old [[E1][E2]] answer.')).toBe('Old  answer.')
    expect(stripHistoricalCitationProtocolTokens('Wiki [[Page Name]] remains.')).toBe('Wiki [[Page Name]] remains.')
  })

  it('refuses prompt evidence without metadata instead of silently creating a fake mapping', () => {
    const composed = new LlmContextComposer().compose([{
      id: 'article', type: 'ARTICLE', content: 'A', evidenceBlocks: [{ stableLocatorKey: 'block-a', content: 'A' }]
    }], { maxTokens: 100 })
    expect(() => prepareCitationProtocol(composed, [])).toThrow('缺少 Citation metadata')
  })
})

function candidate(stableLocatorKey: string, evidenceBlockId: string): LlmCitationEvidenceCandidate {
  return {
    contextId: 'article',
    stableLocatorKey,
    contextRefId: 'context-1',
    evidenceBlockId,
    targetKind: 'EVIDENCE_BLOCK',
    quoteSnapshot: `quote:${stableLocatorKey}`,
    sourceUrl: 'https://example.com/article',
    locatorSnapshot: {
      version: 1,
      sourceKind: 'ARTICLE',
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article',
      normalizedHash: `hash:${stableLocatorKey}`
    }
  }
}
