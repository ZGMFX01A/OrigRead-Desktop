import { describe, expect, it } from 'vitest'
import type { LlmCitationEvidenceCandidate } from './citation-protocol'
import { buildCitationRefsFromAssistantOutput, prepareCitationProtocol, resolveAssistantCitationTokens } from './citation-protocol'
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
    expect(resolveAssistantCitationTokens('Claim [[E1]] fake [[E999]] repeated [[E1]]', entries)).toEqual({
      validProtocolIds: ['E1'],
      invalidProtocolIds: ['E999']
    })
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

  it('refuses prompt evidence without metadata instead of silently creating a fake mapping', () => {
    const composed = new LlmContextComposer().compose([{
      id: 'article', type: 'ARTICLE', content: 'A', evidenceBlocks: [{ stableLocatorKey: 'block-a', content: 'A' }]
    }], { maxTokens: 100 })
    expect(() => prepareCitationProtocol(composed, [])).toThrow('缺少 Citation metadata')
  })
})

function candidate(stableLocatorKey: string, evidenceBlockId: string): LlmCitationEvidenceCandidate {
  return {
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
