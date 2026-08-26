import { describe, expect, it } from 'vitest'
import { decodeHttpText } from './http-text-decoder'

describe('decodeHttpText', () => {
  it('decodes GBK HTML from the HTTP Content-Type charset', () => {
    const bytes = concatBytes(
      ascii('<html><head><title>'),
      gbkWuAiPoJie(),
      ascii('</title></head></html>')
    )

    expect(decodeHttpText(bytes, 'text/html; charset=gbk', 'html')).toContain('<title>吾爱破解</title>')
  })

  it('decodes GBK RSS from the XML declaration when the HTTP header has no charset', () => {
    const bytes = concatBytes(
      ascii('<?xml version="1.0" encoding="gbk"?><rss><channel><title>'),
      gbkWuAiPoJie(),
      ascii('</title></channel></rss>')
    )

    expect(decodeHttpText(bytes, 'application/xml', 'xml')).toContain('<title>吾爱破解</title>')
  })

  it('uses an HTML meta charset when the response header omits charset', () => {
    const bytes = concatBytes(
      ascii('<html><head><meta charset="gbk"><title>'),
      gbkWuAiPoJie(),
      ascii('</title></head></html>')
    )

    expect(decodeHttpText(bytes, 'text/html', 'html')).toContain('<title>吾爱破解</title>')
  })

  it('falls back to UTF-8 when a declared charset is unsupported', () => {
    const text = 'UTF-8 fallback 中文'
    expect(decodeHttpText(new TextEncoder().encode(text), 'text/plain; charset=not-a-real-charset')).toBe(text)
  })
})

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** GBK bytes for “吾爱破解”; kept explicit so the regression test does not depend on an encoder package. */
function gbkWuAiPoJie(): Uint8Array {
  return Uint8Array.from([0xce, 0xe1, 0xb0, 0xae, 0xc6, 0xc6, 0xbd, 0xe2])
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
