import { describe, expect, it } from 'vitest'
import type { LlmCitationRefRecord } from '../../shared/llm-chat'
import type { LlmAssistantEvidenceSnapshot, LlmRestorableCitationSnapshot } from '../../shared/llm-ipc'
import {
  MAX_INLINE_CITATION_GROUPS,
  directNavigationRefForOccurrence,
  projectReaderAiCitationDisplay,
  readerAiCitationSnapshotFromRestorable,
  retainReaderAiCitationAsHistoricalFallback,
  selectReaderAiVisibleCitationSnapshot
} from './citation-ui'

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

function structuredSnapshot(citations: LlmCitationRefRecord[]): LlmAssistantEvidenceSnapshot {
  const value = snapshot(citations)
  value.citationAnnotations = citations.map((citation, index) => ({
    id: `annotation-${index + 1}`,
    conversationId: citation.conversationId,
    assistantMessageId: citation.assistantMessageId,
    canonicalInsertionOffset: index,
    occurrenceOrdinal: index,
    schemaVersion: 1,
    createdAt: 1
  }))
  value.citationAnnotationRefs = citations.map((citation, index) => ({
    annotationId: `annotation-${index + 1}`,
    citationRefId: citation.id,
    refOrdinal: 0
  }))
  return value
}

function externalRef(id: string, protocolId: string, url: string): LlmCitationRefRecord {
  return {
    ...ref(id, protocolId, `web:${id}`),
    sourceUrl: url,
    locatorSnapshot: {
      version: 1,
      sourceKind: 'WEB_SEARCH',
      sourceUrl: url,
      normalizedHash: `hash-${id}`
    }
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

  it('merges adjacent legacy occurrences when they share the same insertion offset and destination', () => {
    const first = ref('ref-1', 'E1', 'p:same')
    const second = ref('ref-2', 'E2', 'p:same')
    const display = projectReaderAiCitationDisplay('assistant', 'Claim [[E1]][[E2]].', snapshot([first, second]))
    expect(display.canonicalText).toBe('Claim.')
    expect(display.occurrences).toHaveLength(1)
    expect(display.occurrences[0]?.refs.map((item) => item.id)).toEqual(['ref-1', 'ref-2'])
  })

  it('rejects ambiguous duplicate positive display orders in legacy citation rows', () => {
    const first = ref('ref-1', 'E1', 'p:first')
    const second = ref('ref-2', 'E2', 'p:second')
    first.displayOrder = 1
    second.displayOrder = 1

    const display = projectReaderAiCitationDisplay('assistant', 'Claim [[E1]][[E2]].', snapshot([first, second]))

    expect(display.canonicalText).toBe('Claim.')
    expect(display.occurrences).toEqual([])
  })

  it('keeps the persisted assistant text with a restorable historical citation snapshot', () => {
    const restorable = {
      message: {
        id: 'assistant-history',
        content: 'First [[E2]], then [[E1]].'
      },
      evidence: snapshot([ref('ref-1', 'E1', 'p:1'), ref('ref-2', 'E2', 'p:2')])
    } as LlmRestorableCitationSnapshot

    const restored = readerAiCitationSnapshotFromRestorable(restorable)

    expect(restored.messageId).toBe('assistant-history')
    expect(restored.messageContent).toBe('First [[E2]], then [[E1]].')
    expect(restored.origin).toBe('HISTORICAL')
  })

  it('caps structured citations at 20 while preserving independent article coverage', () => {
    const articles = [...Array(21).fill('article-a'), 'article-b', 'article-c', 'article-d', 'article-e']
    const citations = articles.map((articleId, index) => ref(`ref-${index + 1}`, `E${index + 1}`, `p:${index + 1}`, articleId))
    const display = projectReaderAiCitationDisplay('assistant', 'x'.repeat(citations.length), structuredSnapshot(citations))
    expect(display.occurrences).toHaveLength(MAX_INLINE_CITATION_GROUPS)
    const coveredArticles = new Set(display.occurrences.flatMap((item) => item.refs.map((citation) => citation.locatorSnapshot?.articleId)))
    expect(coveredArticles).toEqual(new Set(['article-a', 'article-b', 'article-c', 'article-d', 'article-e']))
  })

  it('caps legacy and streaming provisional citation groups at 20 while legacy keeps source coverage', () => {
    const articles = [...Array(21).fill('article-a'), 'article-b', 'article-c', 'article-d', 'article-e']
    const citations = articles.map((articleId, index) => ref(`ref-${index + 1}`, `E${index + 1}`, `p:${index + 1}`, articleId))
    const content = citations.map((citation) => `Claim [[${citation.protocolId}]].`).join(' ')
    const legacy = projectReaderAiCitationDisplay('assistant', content, snapshot(citations))
    expect(legacy.occurrences).toHaveLength(MAX_INLINE_CITATION_GROUPS)
    expect(new Set(legacy.occurrences.flatMap((item) => item.refs.map((citation) => citation.locatorSnapshot?.articleId))))
      .toEqual(new Set(['article-a', 'article-b', 'article-c', 'article-d', 'article-e']))
    expect(projectReaderAiCitationDisplay('assistant', content, null, true).occurrences).toHaveLength(MAX_INLINE_CITATION_GROUPS)
  })

  it('direct-navigates a multi-ref occurrence only when all refs resolve to the same exact destination', () => {
    const sameA = ref('a', 'E1', 'p:same')
    const sameB = ref('b', 'E2', 'p:same')
    sameA.locatorSnapshot = { ...sameA.locatorSnapshot!, headingPath: ['Section'] }
    sameB.locatorSnapshot = { ...sameA.locatorSnapshot! }
    const differentHash = ref('c', 'E3', 'p:same')
    differentHash.locatorSnapshot = { ...sameA.locatorSnapshot!, normalizedHash: 'different-hash' }
    const differentHeading = ref('d', 'E4', 'p:same')
    differentHeading.locatorSnapshot = { ...sameA.locatorSnapshot!, headingPath: ['Other'] }
    const base = { annotationId: 'a1', canonicalInsertionOffset: 0, occurrenceOrdinal: 0, displayOrder: 1 }
    expect(directNavigationRefForOccurrence({ ...base, refs: [sameA, sameB] })?.id).toBe('b')
    expect(directNavigationRefForOccurrence({ ...base, refs: [sameA, differentHash] })).toBeNull()
    expect(directNavigationRefForOccurrence({ ...base, refs: [sameA, differentHeading] })).toBeNull()
  })

  it('requires external URLs to be exactly equal for multi-ref direct navigation', () => {
    const exactA = externalRef('a', 'E1', 'https://example.com/source/#section')
    const exactB = externalRef('b', 'E2', 'https://example.com/source/#section')
    const fragmentVariant = externalRef('c', 'E3', 'https://example.com/source/#other')
    const slashVariant = externalRef('d', 'E4', 'https://example.com/source#section')
    const base = { annotationId: 'a1', canonicalInsertionOffset: 0, occurrenceOrdinal: 0, displayOrder: 1 }
    expect(directNavigationRefForOccurrence({ ...base, refs: [exactA, exactB] })?.id).toBe('b')
    expect(directNavigationRefForOccurrence({ ...base, refs: [exactA, fragmentVariant] })).toBeNull()
    expect(directNavigationRefForOccurrence({ ...base, refs: [exactA, slashVariant] })).toBeNull()
  })

  it('downgrades dismissed Chat citation layers permanently so reopening cannot revive the old interaction', () => {
    const interaction = { messageId: 'old-message', snapshot: snapshot([ref('old', 'E1', 'p:old')]) }
    const historical = { messageId: 'latest-message', snapshot: snapshot([ref('latest', 'E2', 'p:latest')]) }
    const dismissed = retainReaderAiCitationAsHistoricalFallback(interaction)
    const base = {
      source: null,
      interaction: dismissed,
      answer: null,
      historical,
      dismissedFallback: dismissed
    }

    expect(dismissed?.origin).toBe('HISTORICAL')
    expect(selectReaderAiVisibleCitationSnapshot({ ...base, panelOpen: true, historicalResolved: true })?.messageId).toBe('latest-message')
    expect(selectReaderAiVisibleCitationSnapshot({ ...base, panelOpen: false, historicalResolved: true })?.messageId).toBe('latest-message')
    expect(selectReaderAiVisibleCitationSnapshot({ ...base, panelOpen: false, historicalResolved: false, historical: null })?.messageId).toBe('old-message')
    expect(selectReaderAiVisibleCitationSnapshot({ ...base, panelOpen: false, historicalResolved: true, historical: null })).toBeNull()
  })
})
