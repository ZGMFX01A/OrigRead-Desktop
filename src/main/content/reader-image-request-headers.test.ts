import { describe, expect, it } from 'vitest'
import { withReaderImageReferer } from './reader-image-request-headers'

describe('withReaderImageReferer', () => {
  it('adds the image origin when Reader has no usable HTTP referer', () => {
    expect(withReaderImageReferer({
      url: 'https://img.example.com/uploads/a.jpg',
      resourceType: 'image',
      requestHeaders: { Accept: 'image/avif,image/webp,*/*', Referer: 'file:///reader/index.html' }
    })).toMatchObject({ Referer: 'https://img.example.com/' })
  })

  it('preserves a real webpage referer for original WebContentsView requests', () => {
    const headers = { Referer: 'https://www.example.com/article/1', Accept: 'image/*' }
    expect(withReaderImageReferer({
      url: 'https://cdn.example.com/a.jpg',
      resourceType: 'image',
      requestHeaders: headers
    })).toEqual(headers)
  })

  it('does not modify non-image requests', () => {
    const headers = { Accept: 'text/html' }
    expect(withReaderImageReferer({
      url: 'https://www.example.com/',
      resourceType: 'mainFrame',
      requestHeaders: headers
    })).toEqual(headers)
  })
})
