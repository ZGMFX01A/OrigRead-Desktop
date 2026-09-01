import { describe, expect, it } from 'vitest'
import { normalizeLlmFinishReason } from './finish-reason'

describe('normalizeLlmFinishReason D2.8', () => {
  it.each([
    ['stop', 'STOP'],
    ['end_turn', 'STOP'],
    ['length', 'LENGTH'],
    ['max_tokens', 'LENGTH'],
    ['tool_calls', 'TOOL_CALLS'],
    ['function_call', 'TOOL_CALLS'],
    ['content_filter', 'CONTENT_FILTER'],
    ['safety', 'CONTENT_FILTER'],
    ['cancelled', 'CANCELLED'],
    ['error', 'ERROR'],
    ['provider_specific_future_reason', 'OTHER'],
    [null, 'OTHER']
  ] as const)('maps raw provider reason %s to %s', (raw, expected) => {
    expect(normalizeLlmFinishReason(raw)).toBe(expected)
  })

  it('lets local cancellation/error state override an ambiguous provider reason', () => {
    expect(normalizeLlmFinishReason('stop', { cancelled: true })).toBe('CANCELLED')
    expect(normalizeLlmFinishReason('stop', { errored: true })).toBe('ERROR')
  })
})
