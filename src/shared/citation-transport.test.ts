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

  it('bounds malformed Citation cleanup at the current line', () => {
    const result = parseCitationTransport('Before [[E1 nope\nAfter [[Page]].', allowed, true)
    expect(result.canonicalText).toBe('Before \nAfter [[Page]].')
    expect(result.invalidFragmentCount).toBe(1)
  })

  it('protects tilde-fenced examples too', () => {
    const source = '~~~\n[[E1]]\n~~~\nOutside [[E2]].'
    const result = parseCitationTransport(source, allowed, true)
    expect(result.canonicalText).toContain('[[E1]]')
    expect(result.canonicalText.endsWith('Outside.')).toBe(true)
    expect(result.annotations.map((item) => item.protocolIds)).toEqual([['E2']])
  })
})
