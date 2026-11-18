import { describe, expect, it } from 'vitest'
import { parseArticleListArgs } from './article-list-args'

describe('parseArticleListArgs', () => {
  it('handles empty / undefined arguments', () => {
    expect(parseArticleListArgs()).toEqual({ limit: undefined, options: undefined })
    expect(parseArticleListArgs(undefined, undefined)).toEqual({ limit: undefined, options: undefined })
  })

  it('handles number limit argument', () => {
    expect(parseArticleListArgs(100)).toEqual({ limit: 100, options: undefined })
    expect(parseArticleListArgs(200, undefined)).toEqual({ limit: 200, options: undefined })
  })

  it('handles number limit with options argument', () => {
    expect(parseArticleListArgs(100, { isUnread: false })).toEqual({
      limit: 100,
      options: { isUnread: false }
    })
    expect(parseArticleListArgs(200, { isUnread: true })).toEqual({
      limit: 200,
      options: { isUnread: true }
    })
  })

  it('handles options object as first argument', () => {
    expect(parseArticleListArgs({ isUnread: false })).toEqual({
      limit: undefined,
      options: { isUnread: false }
    })
    expect(parseArticleListArgs({ limit: 50, isUnread: true })).toEqual({
      limit: 50,
      options: { isUnread: true }
    })
  })

  it('rejects invalid limit values', () => {
    expect(() => parseArticleListArgs(NaN)).toThrow(TypeError)
    expect(() => parseArticleListArgs(Infinity)).toThrow(TypeError)
    expect(() => parseArticleListArgs({ limit: NaN })).toThrow(TypeError)
    expect(() => parseArticleListArgs({ limit: '100' as unknown as number })).toThrow(TypeError)
  })

  it('rejects invalid options', () => {
    expect(() => parseArticleListArgs('invalid')).toThrow(TypeError)
    expect(() => parseArticleListArgs(100, 'invalid')).toThrow(TypeError)
    expect(() => parseArticleListArgs([1, 2])).toThrow(TypeError)
    expect(() => parseArticleListArgs({ isUnread: 'false' as unknown as boolean })).toThrow(TypeError)
    expect(() => parseArticleListArgs(100, { isUnread: 0 as unknown as boolean })).toThrow(TypeError)
  })
})
