import { describe, expect, it } from 'vitest'
import { parseCitationTransport } from './citation-transport'

const allowed = new Set(['E1', 'E2', 'E21', 'E53'])

describe('Citation transport parser', () => {
  it('canonicalizes compact multi-evidence transport into one ordered occurrence', () => {
    const result = parseCitationTransport('Claim [[E21][E53]].', allowed, true)
    expect(result.canonicalText).toBe('Claim.')
    expect(result.annotations).toEqual([{
      canonicalInsertionOffset: 5,
      occurrenceOrdinal: 0,
      protocolIds: ['E21', 'E53']
    }])
  })

  it('keeps adjacent complete tokens as distinct occurrences at the same canonical offset', () => {
    const result = parseCitationTransport('Claim[[E1]][[E2]].', allowed, true)
    expect(result.canonicalText).toBe('Claim.')
    expect(result.annotations).toEqual([
      { canonicalInsertionOffset: 5, occurrenceOrdinal: 0, protocolIds: ['E1'] },
      { canonicalInsertionOffset: 5, occurrenceOrdinal: 1, protocolIds: ['E2'] }
    ])
  })

  it('keeps valid IDs from a compact token while reporting invalid members', () => {
    const result = parseCitationTransport('Claim [[E1][E404]].', allowed, true)
    expect(result.canonicalText).toBe('Claim.')
    expect(result.annotations).toEqual([{
      canonicalInsertionOffset: 5,
      occurrenceOrdinal: 0,
      protocolIds: ['E1']
    }])
    expect(result.invalidProtocolIds).toEqual(['E404'])
  })

  it('hides an incomplete streaming Citation tail until more input arrives', () => {
    const result = parseCitationTransport('Claim [[E1', allowed, false)
    expect(result.canonicalText).toBe('Claim')
    expect(result.annotations).toEqual([])
    expect(result.hasIncompleteTransport).toBe(true)
  })

  it('does not interpret Citation-shaped examples inside inline or fenced code', () => {
    const source = 'Use `[[E1]]` literally.\n```text\n[[E2]]\n```\nReal [[E1]].'
    const result = parseCitationTransport(source, allowed, true)
    expect(result.canonicalText).toContain('`[[E1]]`')
    expect(result.canonicalText).toContain('[[E2]]')
    expect(result.canonicalText.endsWith('Real.')).toBe(true)
    expect(result.annotations).toHaveLength(1)
    expect(result.annotations[0]?.protocolIds).toEqual(['E1'])
  })

  it('preserves arbitrary double-bracket text that is not Citation transport', () => {
    const source = 'Wiki [[Page Name]], matrix [[1,2],[3,4]], and [[:category]].'
    expect(parseCitationTransport(source, allowed, true).canonicalText).toBe(source)
  })

  it('preserves English double-bracket text while extracting real citations', () => {
    const source = 'Wiki [[Page Name]] and [[Evil]] stay literal. Real [[E1]].'
    for (const final of [false, true]) {
      const result = parseCitationTransport(source, allowed, final)
      expect(result.canonicalText).toBe('Wiki [[Page Name]] and [[Evil]] stay literal. Real.')
      expect(result.annotations).toEqual([{
        canonicalInsertionOffset: result.canonicalText.length - 1,
        occurrenceOrdinal: 0,
        protocolIds: ['E1']
      }])
      expect(result.invalidFragmentCount).toBe(0)
    }
  })

  it('preserves unclosed malformed Citation prose across lines', () => {
    const result = parseCitationTransport('Before [[E1 nope\nAfter [[Page]] [[E2]].', allowed, true)
    expect(result.canonicalText).toBe('Before [[E1 nope\nAfter [[Page]].')
    expect(result.invalidFragmentCount).toBe(0)
    expect(result.annotations[0]?.protocolIds).toEqual(['E2'])
  })

  it('protects tilde-fenced examples too', () => {
    const source = '~~~\n[[E1]]\n~~~\nOutside [[E2]].'
    const result = parseCitationTransport(source, allowed, true)
    expect(result.canonicalText).toContain('[[E1]]')
    expect(result.canonicalText.endsWith('Outside.')).toBe(true)
    expect(result.annotations.map((item) => item.protocolIds)).toEqual([['E2']])
  })
  it('preserves indentation and punctuation spacing in code and prose', () => {
    const code = '```ts\n  .map(...)\n    !flag\n\ta ? b : c [[E1]]\n```'
    const inline = '`  .map(...)    !flag a ? b : c [[E2]]`'
    const source = `${code}\n${inline}\na ? b : c\n  .map(...)\n    !flag\nClaim [[E21][E53]].`
    const result = parseCitationTransport(source, allowed)
    expect(result.canonicalText).toBe(`${code}\n${inline}\na ? b : c\n  .map(...)\n    !flag\nClaim.`)
    expect(result.annotations).toHaveLength(1)
    expect(parseCitationTransport('Claim [[E1][E2]]， next.', allowed).canonicalText).toBe('Claim， next.')
    expect(parseCitationTransport('```\n  .map(...)\n    ', allowed, false).canonicalText).toBe('```\n  .map(...)\n    ')
  })

  it('preserves malformed prose while extracting subsequent valid tokens', () => {
    const result = parseCitationTransport('Before [[E1 this is real prose [[E2]].', allowed)
    expect(result.canonicalText).toBe('Before [[E1 this is real prose.')
    expect(result.annotations[0]?.protocolIds).toEqual(['E2'])
  })

  it('strips only short closed malformed markers', () => {
    for (const token of ['[[E1x]]', '[[E1, bad]]', '[[E]]', '[[E][E1]]']) {
      const result = parseCitationTransport(`Claim ${token}.`, allowed)
      expect(result.canonicalText).toBe('Claim.')
      expect(result.invalidFragmentCount).toBe(1)
    }
    for (const token of ['[[Evil]]', '[[Example]]', '[[E1 this is prose]]', '[[E1 nope\rAfter]]', `[[E${'x'.repeat(32)}]]`]) {
      expect(parseCitationTransport(token, allowed).canonicalText).toBe(token)
    }
    expect(parseCitationTransport('Claim [[E1, E2]].', allowed).annotations[0]?.protocolIds).toEqual(['E1', 'E2'])
  })

  it('does not let unmatched backticks poison later citations', () => {
    const source = 'Here is an unclosed ` backtick.\n\nNext paragraph [[E1]].'
    for (const final of [true, false]) {
      const result = parseCitationTransport(source, allowed, final)
      expect(result.canonicalText).toBe('Here is an unclosed ` backtick.\n\nNext paragraph.')
      expect(result.annotations[0]?.protocolIds).toEqual(['E1'])
    }
    expect(parseCitationTransport('Unclosed ` text [[E1]].', allowed).annotations).toHaveLength(1)
    expect(parseCitationTransport(`Unclosed \` ${'x'.repeat(256)} [[E1]].`, allowed, false).annotations).toHaveLength(1)
  })

  it('releases a pending inline tail at a paragraph boundary or final snapshot', () => {
    const prefix = 'Here is an unclosed ` backtick.'
    for (const suffix of ['', '\n', '\r\n']) {
      const pending = parseCitationTransport(prefix + suffix, allowed, false)
      expect(pending.canonicalText).toBe('Here is an unclosed')
      expect(pending.hasIncompleteTransport).toBe(true)
    }
    for (const boundary of ['\n\n', '\r\n\r\n']) {
      const result = parseCitationTransport(prefix + boundary + 'Next [[E1]].', allowed, false)
      expect(result.canonicalText).toBe(prefix + boundary + 'Next.')
      expect(result.annotations).toHaveLength(1)
      expect(result.hasIncompleteTransport).toBe(false)
    }
    expect(parseCitationTransport(prefix + ' [[E1]].', allowed, true).annotations).toHaveLength(1)
    const closed = parseCitationTransport(prefix + ' [[E1]]` Next [[E2]].', allowed, false)
    expect(closed.canonicalText).toBe(prefix + ' [[E1]]` Next.')
    expect(closed.annotations[0]?.protocolIds).toEqual(['E2'])
  })

  it('holds legal streaming prefixes and preserves non-protocol suffixes', () => {
    for (const tail of ['[[E', '[[E1', '[[E1]', '[[E1][E', '[[E1, E']) {
      expect(parseCitationTransport('Claim ' + tail, allowed, false)).toMatchObject({
        canonicalText: 'Claim', invalidFragmentCount: 0, hasIncompleteTransport: true
      })
      expect(parseCitationTransport('Claim ' + tail, allowed, true)).toMatchObject({
        canonicalText: 'Claim', invalidFragmentCount: 1, hasIncompleteTransport: false
      })
    }
    for (const text of ['Before [[E1 nope', 'Before [[E1 this is real prose', 'Before [[E1 nope\nAfter']) {
      for (const final of [false, true]) {
        expect(parseCitationTransport(text, allowed, final)).toMatchObject({
          canonicalText: text, invalidFragmentCount: 0, hasIncompleteTransport: false
        })
      }
    }
    for (const [text, canonicalText] of [['Before [[E1', 'Before'], ['结论 [[E21', '结论']] as const) {
      expect(parseCitationTransport(text, allowed, true)).toMatchObject({
        canonicalText, invalidFragmentCount: 1, hasIncompleteTransport: false
      })
    }
  })

})
