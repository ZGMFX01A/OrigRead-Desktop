import { describe, expect, it } from 'vitest'
import { buildUnconsumedWebSearchContextRefs, buildWebSearchContext } from './web-search-context'

describe('Web Search context evidence', () => {
  it('turns every result into an independent auditable ContextRef/evidence candidate', () => {
    const built = buildWebSearchContext({
      providerId: 'search-1', providerName: 'Fixture', backendKind: 'RAW_SEARCH', answer: null,
      results: [
        { title: 'One', url: 'https://one.example/post', snippet: 'First fact.', publishedAt: '2026-09-01', source: 'one.example', content: null },
        { title: 'Two', url: 'https://two.example/post', snippet: 'Second fact.', publishedAt: null, source: 'two.example', content: null }
      ]
    })
    expect(built.contextItems).toHaveLength(2)
    expect(built.contextItems[0]).toMatchObject({ type: 'WEB_SEARCH_RESULT', title: 'One', sourceId: 'https://one.example/post' })
    expect(built.contextItems.map((item) => item.priority)).toEqual([11000, 10999])
    expect(built.contextItems[0]?.content).toContain('Published: 2026-09-01')
    expect(built.evidenceGroups[0]?.blocks[0]).toMatchObject({ kind: 'SEARCH_RESULT', locator: { sourceKind: 'WEB_SEARCH', sourceUrl: 'https://one.example/post' } })

    const refs = buildUnconsumedWebSearchContextRefs('conversation', 'assistant', built.contextItems, 123)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({
      assistantMessageId: 'assistant', type: 'WEB_SEARCH_RESULT', includedInPrompt: false,
      truncatedInPrompt: false, promptContentSnapshot: null, createdAt: 123
    })
  })
})
