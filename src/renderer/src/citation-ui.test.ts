import { describe, expect, it } from 'vitest'
import type { LlmCitationRefRecord } from '../../shared/llm-chat'
import type { LlmAssistantEvidenceSnapshot } from '../../shared/llm-ipc'
import { directNavigationRefForOccurrence, projectReaderAiCitationDisplay } from './citation-ui'

function ref(id: string, protocolId: string, stableLocatorKey: string, articleId = 'article-1'): LlmCitationRefRecord {
  return {
    id,
    conversationId: 'conversation',
    assistantMessageId: 'assistant',
    contextRefId: `context-${id}`,
    evidenceBlockId: `evidence-${id}`,
    targetKind: 'EVIDENCE_BLOCK',
    protocolId,
    displayOrder: null,
    quoteSnapshot: `quote-${id}`,
    sourceUrl: 'https://example.com/article',
    locatorSnapshot: {
      version: 1,
      sourceKind: 'ARTICLE',
      stableLocatorKey,
      articleId,
      sourceUrl: 'https://example.com/article',
      normalizedHash: `hash-${id}`
    },
    schemaVersion: 1,
    createdAt: 1
  }
}

function snapshot(citations: LlmCitationRefRecord[]): LlmAssistantEvidenceSnapshot {
  return {
    contextRefs: [],
    evidenceBlocks: [],
    citations,
    citationAnnotations: [],
    citationAnnotationRefs: []
  }
}

describe('Reader AI Citation projection', () => {
  it('projects persisted occurrences independently even when they reuse the same stable ref', () => {
    const citation = ref('ref-1', 'E1', 'p:1')
    const value = snapshot([citation])
    value.citationAnnotations = [
      { id: 'a1', conversationId: 'conversation', assistantMessageId: 'assistant', canonicalInsertionOffset: 5, occurrenceOrdinal: 0, schemaVersion: 1, createdAt: 1 },
      { id: 'a2', conversationId: 'conversation', assistantMessageId: 'assistant', canonicalInsertionOffset: 12, occurrenceOrdinal: 1, schemaVersion: 1, createdAt: 1 }
    ]
    value.citationAnnotationRefs = [
      { annotationId: 'a1', citationRefId: 'ref-1', refOrdinal: 0 },
      { annotationId: 'a2', citationRefId: 'ref-1', refOrdinal: 0 }
    ]

    const display = projectReaderAiCitationDisplay('assistant', 'First, second.', value)
    expect(display.canonicalText).toBe('First, second.')
    expect(display.occurrences.map((item) => [item.annotationId, item.displayOrder, item.refs[0]?.id])).toEqual([
      ['a1', 1, 'ref-1'],
      ['a2', 2, 'ref-1']
    ])
  })

  it('lazily canonicalizes legacy compact transport with the same grammar', () => {
    const first = ref('ref-1', 'E1', 'p:1')
    const second = ref('ref-2', 'E2', 'p:2')
    const display = projectReaderAiCitationDisplay('assistant', 'Claim [[E1][E2]].', snapshot([first, second]))
    expect(display.canonicalText).toBe('Claim.')
    expect(display.occurrences).toHaveLength(1)
    expect(display.occurrences[0]?.refs.map((item) => item.id)).toEqual(['ref-1', 'ref-2'])
  })

  it('direct-navigates a multi-ref occurrence only when all refs resolve to the same exact destination', () => {
    const sameA = ref('a', 'E1', 'p:same')
    const sameB = ref('b', 'E2', 'p:same')
    const different = ref('c', 'E3', 'p:other')
    const base = { annotationId: 'a1', canonicalInsertionOffset: 0, occurrenceOrdinal: 0, displayOrder: 1 }
    expect(directNavigationRefForOccurrence({ ...base, refs: [sameA, sameB] })?.id).toBe('a')
    expect(directNavigationRefForOccurrence({ ...base, refs: [sameA, different] })).toBeNull()
  })
})
