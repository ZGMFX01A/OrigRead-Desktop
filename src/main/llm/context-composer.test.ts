import { describe, expect, it } from 'vitest'
import type { LlmContextItem } from '../../shared/llm-context'
import { estimateLlmTokens, LlmContextComposer, takeWithinEstimatedTokenBudget } from './context-composer'

describe('LlmContextComposer', () => {
  it('keeps higher-priority context within budget and records budget omissions', () => {
    const composer = new LlmContextComposer()
    const result = composer.compose([
      { id: 'article', type: 'ARTICLE', content: 'A'.repeat(200), priority: 10 },
      { id: 'manual', type: 'MANUAL', content: 'B'.repeat(200), priority: 1 }
    ], { maxTokens: 80 })

    expect(result.includedIds).toContain('article')
    expect(result.omittedIds).toContain('manual')
    expect(result.truncated).toBe(true)
    expect(estimateLlmTokens(result.text)).toBeLessThanOrEqual(80)
    expect(result.text.endsWith('[/ORIGREAD_CONTEXT]')).toBe(true)
    expect(result.decisions.find((item) => item.id === 'manual')?.status).toBe('OMITTED_BUDGET')
  })

  it('preserves reserved raw evidence after a higher-priority summary', () => {
    const composer = new LlmContextComposer()
    const items: LlmContextItem[] = [
      { id: 'summary', type: 'ARTICLE_SUMMARY', content: 'S'.repeat(20_000), priority: 130 },
      { id: 'article', type: 'ARTICLE', content: 'A'.repeat(20_000), reserveEvidenceBudget: true, priority: 100 }
    ]

    for (const maxTokens of [1_000, 4_000, 128_000]) {
      const result = composer.compose(items, { maxTokens })
      expect(result.includedIds).toContain('article')
      expect(result.renderedItems.find((item) => item.id === 'article')?.content).not.toBe('')
      expect(estimateLlmTokens(result.text)).toBeLessThanOrEqual(maxTokens)
    }
  })

  it('omits an item when the budget cannot preserve the context wrapper', () => {
    const result = new LlmContextComposer().compose([
      { id: 'article', type: 'ARTICLE', content: '正文' }
    ], { maxTokens: 1 })

    expect(result.text).toBe('')
    expect(result.omittedIds).toEqual(['article'])
    expect(result.truncated).toBe(true)
  })

  it('rejects non-positive budgets and duplicate IDs', () => {
    const composer = new LlmContextComposer()
    expect(() => composer.compose([], { maxTokens: 0 })).toThrow('上下文预算必须大于 0')
    expect(() => composer.compose([
      { id: 'same', type: 'ARTICLE', content: 'A' },
      { id: 'same', type: 'MANUAL', content: 'B' }
    ], { maxTokens: 100 })).toThrow('上下文 id 必须唯一')
  })

  it('never truncates inside an emoji surrogate pair', () => {
    expect(takeWithinEstimatedTokenBudget('A😀B', 1)).toBe('A')
    expect([...takeWithinEstimatedTokenBudget('😀B', 1)]).toEqual(['😀'])
  })

  it('filters disallowed/blank items without misreporting them as budget truncation', () => {
    const result = new LlmContextComposer().compose([
      { id: 'article', type: 'ARTICLE', content: 'evidence' },
      { id: 'tool', type: 'TOOL_RESULT', content: 'tool result' },
      { id: 'blank', type: 'MANUAL', content: '   ' }
    ], { maxTokens: 200, allowedTypes: new Set(['ARTICLE']) })

    expect(result.includedIds).toEqual(['article'])
    expect(result.omittedIds).toEqual(['tool', 'blank'])
    expect(result.decisions).toEqual([
      { id: 'article', status: 'INCLUDED' },
      { id: 'tool', status: 'OMITTED_FILTERED' },
      { id: 'blank', status: 'OMITTED_FILTERED' }
    ])
    expect(result.truncated).toBe(false)
  })

  it('preserves stable source IDs and safely quotes header attributes', () => {
    const result = new LlmContextComposer().compose([
      {
        id: 'web-search:1',
        type: 'WEB_SEARCH_RESULT',
        title: 'Fresh source',
        sourceId: 'https://example.com/a?x="quoted"',
        content: 'fresh evidence',
        priority: 110
      }
    ], { maxTokens: 200 })

    expect(result.text).toContain('id="web-search:1"')
    expect(result.text).toContain('source="https://example.com/a?x=\\"quoted\\""')
    expect(result.text).toContain('Title: Fresh source')
  })

  it('treats additional articles as first-class context candidates', () => {
    const result = new LlmContextComposer().compose([
      { id: 'article:current', type: 'ARTICLE', content: 'current', priority: 100 },
      { id: 'article:extra', type: 'ADDITIONAL_ARTICLE', content: 'extra', priority: 90 }
    ], { maxTokens: 200 })

    expect(result.includedIds).toEqual(['article:current', 'article:extra'])
  })

  it('never truncates citation evidence inside a block and reports exactly which blocks entered the prompt', () => {
    const first = { stableLocatorKey: 'p:first', content: 'First evidence block.' }
    const oversized = { stableLocatorKey: 'p:oversized', content: '中'.repeat(300) }
    const last = { stableLocatorKey: 'p:last', content: 'Last evidence block.' }
    const result = new LlmContextComposer().compose([{
      id: 'article:evidence',
      type: 'ARTICLE',
      content: `${first.content}\n${oversized.content}\n${last.content}`,
      evidenceBlocks: [first, oversized, last],
      priority: 100
    }], { maxTokens: 100 })

    const rendered = result.renderedItems[0]
    expect(rendered?.evidenceBlockKeys).toEqual(['p:first', 'p:last'])
    expect(rendered?.content).toContain(first.content)
    expect(rendered?.content).toContain(last.content)
    expect(rendered?.content).not.toContain(oversized.content)
    expect(result.text).not.toContain('中'.repeat(10))
    expect(result.text).toContain('[ORIGREAD_EVIDENCE id="p:first"]')
    expect(result.text).toContain('[ORIGREAD_EVIDENCE id="p:last"]')
    expect(result.decisions[0]?.status).toBe('INCLUDED_TRUNCATED')
  })

  it('rejects duplicate evidence keys because citation bookkeeping is key-based', () => {
    expect(() => new LlmContextComposer().compose([{
      id: 'article:evidence',
      type: 'ARTICLE',
      content: 'A B',
      evidenceBlocks: [
        { stableLocatorKey: 'same', content: 'A' },
        { stableLocatorKey: 'same', content: 'B' }
      ]
    }], { maxTokens: 200 })).toThrow('Evidence block key 必须唯一')
  })
})
