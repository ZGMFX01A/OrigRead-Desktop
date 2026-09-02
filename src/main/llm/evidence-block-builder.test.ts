import { describe, expect, it } from 'vitest'
import { annotateArticleEvidenceHtml, buildArticleEvidenceBlocks, buildSelectionEvidenceBlock } from './evidence-block-builder'

describe('buildArticleEvidenceBlocks D2.9', () => {
  it('splits sanitized article HTML into semantic blocks without duplicating nested content', () => {
    const blocks = buildArticleEvidenceBlocks(`
      <article>
        <h2>Results</h2>
        <p>Revenue <strong>increased</strong> by 20%.</p>
        <ul><li>First fact<p>nested explanation</p></li><li>Second fact</li></ul>
        <blockquote><p>Quoted evidence</p></blockquote>
        <pre>const x = 1;\nconsole.log(x)</pre>
        <table><tr><th>Metric</th><th>Value</th></tr><tr><td>Growth</td><td>20%</td></tr></table>
      </article>
    `, { articleId: 'article-1', sourceUrl: 'https://example.com/article' })

    expect(blocks.map((block) => [block.kind, block.content])).toEqual([
      ['HEADING', 'Results'],
      ['PARAGRAPH', 'Revenue increased by 20%.'],
      ['LIST_ITEM', 'First fact nested explanation'],
      ['LIST_ITEM', 'Second fact'],
      ['BLOCKQUOTE', 'Quoted evidence'],
      ['CODE', 'const x = 1;\nconsole.log(x)'],
      ['TABLE_ROW', 'Metric | Value'],
      ['TABLE_ROW', 'Growth | 20%']
    ])
    expect(blocks.every((block, index) => block.ordinal === index)).toBe(true)
    expect(blocks[1]?.locator).toMatchObject({
      version: 1,
      sourceKind: 'ARTICLE',
      stableLocatorKey: blocks[1]?.stableLocatorKey,
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article',
      headingPath: ['Results']
    })
  })

  it('annotates Reader HTML with the same stable block identities and hashes', () => {
    const html = annotateArticleEvidenceHtml('<h2>Section</h2><p>Evidence text.</p><p>Second fact.</p>', {
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article'
    })
    const blocks = buildArticleEvidenceBlocks(html, { articleId: 'article-1', sourceUrl: 'https://example.com/article' })
    expect(html).toContain(`data-origread-block-id="${blocks[0]?.stableLocatorKey}"`)
    expect(html).toContain(`data-origread-block-id="${blocks[1]?.stableLocatorKey}"`)
    expect(html).toContain(`data-origread-block-hash="${blocks[1]?.normalizedSha256}"`)
    expect(html).toContain('data-origread-heading-path="Section"')
  })

  it('keeps stable locator identity when unrelated content is inserted after a block', () => {
    const before = buildArticleEvidenceBlocks('<h2>Section</h2><p>Stable evidence.</p>')
    const after = buildArticleEvidenceBlocks('<h2>Section</h2><p>Stable evidence.</p><p>Later new text.</p>')
    expect(after[0]?.stableLocatorKey).toBe(before[0]?.stableLocatorKey)
    expect(after[1]?.stableLocatorKey).toBe(before[1]?.stableLocatorKey)
    expect(after[1]?.normalizedSha256).toBe(before[1]?.normalizedSha256)
  })

  it('distinguishes duplicate identical evidence under the same heading', () => {
    const blocks = buildArticleEvidenceBlocks('<h2>Same</h2><p>Repeated.</p><p>Repeated.</p>')
    expect(blocks[1]?.normalizedSha256).toBe(blocks[2]?.normalizedSha256)
    expect(blocks[1]?.stableLocatorKey).not.toBe(blocks[2]?.stableLocatorKey)
  })

  it('falls back to one paragraph for meaningful bare text', () => {
    const blocks = buildArticleEvidenceBlocks('<div>Only bare text without semantic tags</div>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'PARAGRAPH', content: 'Only bare text without semantic tags' })
  })

  it('freezes selected original text as citation-ready evidence without pretending it has an article block anchor', () => {
    const block = buildSelectionEvidenceBlock('  selected   evidence  ', { articleId: 'article-1', sourceUrl: 'https://example.com/article' })
    expect(block).toMatchObject({
      content: 'selected evidence',
      kind: 'SELECTION',
      locator: { sourceKind: 'SELECTION', articleId: 'article-1', sourceUrl: 'https://example.com/article' }
    })
    expect(block?.locator.stableLocatorKey).toBe(block?.stableLocatorKey)
  })
})
