import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { TranslationContentProcessor } from './translation-content-processor'

const processor = new TranslationContentProcessor()
describe('translation DOM coverage', () => {
  it.each(['Plain text', '<div>Hello <span>world</span></div>', '<article>Before<p>Paragraph</p>After</article>'])('covers all prose without a body wrapper: %s', html => {
    const prepared = processor.prepare(html)
    expect(prepared.texts.join(' ')).toBe(cheerio.load(html).text().replace(/\s+/g, ' ').trim().replace('BeforeParagraphAfter', 'Before Paragraph After'))
    expect(prepared.texts.length).toBeGreaterThan(0)
    const rendered = processor.render(prepared, prepared.texts.map(() => '译文'), 'TRANSLATED')
    expect(rendered).not.toMatch(/<\/?body/i)
    expect(rendered).toContain('译文')
  })
  it('keeps bilingual content inside list items and table cells', () => {
    const prepared = processor.prepare('<ul><li>Item</li></ul><table><tr><td>Cell</td></tr></table>')
    const $ = cheerio.load(processor.render(prepared, ['条目', '单元格'], 'BILINGUAL'))
    expect($('li > .origread-translation').text()).toBe('条目')
    expect($('td > .origread-translation').text()).toBe('单元格')
    expect($('ul > div, tr > div, body > .origread-translation')).toHaveLength(0)
  })
})

