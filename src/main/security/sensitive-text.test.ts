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

 it.each(['DeepL-Auth-Key', 'x-api-key', 'x-subscription-token', 'apiKey', 'accessKey', 'privateKey', 'secretKey', 'accessToken', 'refreshToken', 'clientSecret', 'authToken', 'ACCESS_TOKEN', 'refresh-token'])('redacts %s in headers and JSON', (key) => {
   for (const text of [`${key}: hidden-value`, `"${key}":"hidden-value"`, `${key}='hidden-value'`]) {
     expect(redactSensitiveText(text)).not.toContain('hidden-value')
   }
 })
 it('redacts the entire multi-part cookie header and preserves following diagnostics', () => {
   expect(redactSensitiveText('Cookie: session=abc; token=xyz; other=tail\nstatus=401')).toBe('Cookie=[redacted]\nstatus=401')
   expect(redactSensitiveText('Set-Cookie: session=abc; Path=/; HttpOnly')).toBe('Set-Cookie=[redacted]')
 })
 it('preserves Error AbortError identity', () => {
   const abort = Object.assign(new Error('cancel'), { name: 'AbortError' })
   expect(redactErrorForBoundary(abort)).toBe(abort)
 })


it('redacts every credential shape in rethrown boundary failures', () => {
  const error = redactErrorForBoundary(new Error('DeepL-Auth-Key=hidden Cookie: session=secret; extra=tail'))
  expect(error.message).toBe('DeepL-Auth-Key=[redacted] Cookie=[redacted]')
})

it.each([
  'apiKey="example-unclosed',
  "refreshToken='example-unclosed",
  'privateKey="line-one\nline-two"',
  "secretKey='line-one\r\nline-two'",
  'clientSecret="escaped\\"quote"'
])('redacts incomplete, multiline and escaped quoted values: %s', (raw) => {
  const safe = redactSensitiveText(raw)
  expect(safe).toMatch(/^[a-z]+Key=\[redacted\]$|^(?:refreshToken|clientSecret)=\[redacted\]$/i)
  expect(redactErrorForBoundary(new Error(raw)).message).toBe(safe)
  expect(safe).not.toMatch(/example-unclosed|line-one|line-two|escaped|quote/)
})
