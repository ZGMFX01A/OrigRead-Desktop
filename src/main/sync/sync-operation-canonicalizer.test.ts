import { describe, expect, it } from 'vitest'
import { canonicalJson } from './sync-operation-canonicalizer'

describe('cross-platform canonical JSON', () => {
  it('normalizes binary64 numbers with the ECMAScript wire representation', () => {
    expect(canonicalJson('[1.0,-0,1E30,4.50,2e-3,1e-7,0.000001,333333333.33333329,5e-324]'))
      .toBe('[1,0,1e+30,4.5,0.002,1e-7,0.000001,333333333.3333333,5e-324]')
  })

  it('preserves Unicode without normalization and rejects isolated surrogates', () => {
    expect(canonicalJson('{"😀":"é","汉":"é"}')).toBe('{"汉":"é","😀":"é"}')
    expect(() => canonicalJson('"\\ud800"')).toThrow('surrogate')
    expect(() => canonicalJson('{"\\udfff":1}')).toThrow('surrogate')
    expect(() => canonicalJson('1e400')).toThrow('Non-finite')
  })
})
