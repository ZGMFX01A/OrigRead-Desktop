import { describe, expect, it } from 'vitest'
import { withReaderImageReferer } from './reader-image-request-headers'

describe('withReaderImageReferer', () => {
  it('does not fabricate an image-origin referer when the Reader has none', () => {
    const headers = { Accept: 'image/avif,image/webp,*/*' }
    expect(withReaderImageReferer({
      url: 'https://img.example.com/uploads/a.jpg',
      resourceType: 'image',
      requestHeaders: headers
    })).toBe(headers)
  })

  it.each(['file:///reader/index.html', 'about:blank', 'null', ''])('removes unusable referer %s without replacing it', referer => {
    const headers = { Accept: 'image/avif,image/webp,*/*', rEfErEr: referer }
    expect(withReaderImageReferer({
      url: 'https://img.example.com/uploads/a.jpg',
      resourceType: 'image',
      requestHeaders: headers
    })).toEqual({ Accept: headers.Accept })
    expect(headers.rEfErEr).toBe(referer)
  })

  it.each(['Referer', 'referer'])('preserves an existing HTTP webpage %s verbatim', key => {
    const headers = { [key]: 'https://www.example.com/article/1', Accept: 'image/*' }
    expect(withReaderImageReferer({
      url: 'https://cdn.example.com/a.jpg',
      resourceType: 'image',
      requestHeaders: headers
    })).toBe(headers)
  })

  it('does not modify non-image requests', () => {
    const headers = { Accept: 'text/html', Referer: 'file:///reader/index.html' }
    expect(withReaderImageReferer({
      url: 'https://www.example.com/',
      resourceType: 'mainFrame',
      requestHeaders: headers
    })).toBe(headers)
  })

  it.each(['file:///cover.png', 'data:image/png;base64,AA==', 'not a URL'])('does not handle non-HTTP or invalid image URL %s', url => {
    const headers = { Referer: 'file:///reader/index.html' }
    expect(withReaderImageReferer({ url, resourceType: 'image', requestHeaders: headers })).toBe(headers)
  })
})
