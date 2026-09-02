import { describe, expect, it } from 'vitest'
import { redactErrorForBoundary, redactSensitiveText } from './sensitive-text'

describe('sensitive text redaction', () => {
  it('redacts common credential shapes without hiding ordinary diagnostics', () => {
    const value = redactSensitiveText('401 token=abc123 Authorization: Bearer top.secret password="pw" request_id=req-1')
    expect(value).toContain('401')
    expect(value).toContain('request_id=req-1')
    expect(value).toContain('token=[redacted]')
    expect(value).toContain('password=[redacted]')
    expect(value).toContain('Bearer [redacted]')
    expect(value).not.toContain('abc123')
    expect(value).not.toContain('top.secret')
    expect(value).not.toContain('"pw"')
  })

  it('preserves AbortError identity while sanitizing ordinary boundary errors', () => {
    const abort = new DOMException('cancelled', 'AbortError')
    expect(redactErrorForBoundary(abort)).toBe(abort)
    const error = redactErrorForBoundary(new TypeError('api_key=secret-value failed'))
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TypeError')
    expect(error.message).toBe('api_key=[redacted] failed')
  })
})
