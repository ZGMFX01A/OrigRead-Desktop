import { describe, expect, it } from 'vitest'
import { BestIconFinder, extractIconDomain, type IconFetchPayload, type IconFetcher } from './best-icon-finder'

describe('BestIconFinder Android parity', () => {
  it('prefers apple touch icon before other formats and larger bytes within the same format', async () => {
    const page = `<html><head>
      <link rel="icon" href="/small.png">
      <link rel="icon" href="/large.png">
      <link rel="apple-touch-icon" href="/touch.png">
      <meta property="og:image" content="https://example.com/og.jpg">
    </head></html>`
    const finder = new BestIconFinder(fixtures({
      'http://example.com/': html(page, 'http://example.com/'),
      'http://example.com/small.png': image('image/png', 10),
      'http://example.com/large.png': image('image/png', 100),
      'http://example.com/touch.png': image('image/png', 5),
      'https://example.com/og.jpg': image('image/jpeg', 999),
      'http://example.com/favicon.ico': image('image/x-icon', 9999)
    }))

    await expect(finder.findBestIcon('example.com')).resolves.toBe('http://example.com/touch.png')
  })

  it('falls back to standard root icons when the page request fails', async () => {
    const finder = new BestIconFinder(fixtures({
      'http://example.com/apple-touch-icon.png': image('image/png', 20),
      'http://example.com/apple-touch-icon-precomposed.png': image('image/png', 30),
      'http://example.com/favicon.ico': image('image/x-icon', 100)
    }))
    await expect(finder.findBestIcon('example.com')).resolves.toBe('http://example.com/apple-touch-icon-precomposed.png')
  })

  it('extracts the same host-level lookup input used by Android', () => {
    expect(extractIconDomain('https://news.example.com/path?q=1')).toBe('news.example.com')
  })
})

function fixtures(values: Record<string, IconFetchPayload>): IconFetcher {
  return async (url) => {
    const result = values[url]
    if (!result) throw new Error(`HTTP 404: ${url}`)
    return result
  }
}

function html(value: string, finalUrl: string): IconFetchPayload {
  return { finalUrl, contentType: 'text/html; charset=UTF-8', bytes: new TextEncoder().encode(value) }
}

function image(contentType: string, bytes: number): IconFetchPayload {
  return { finalUrl: '', contentType, bytes: new Uint8Array(bytes) }
}
