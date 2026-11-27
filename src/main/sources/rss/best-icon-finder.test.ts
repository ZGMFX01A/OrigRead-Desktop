import { describe, expect, it, vi } from 'vitest'
import { BestIconFinder, fetchIconPayload, MAX_ICON_RESPONSE_BYTES, extractIconDomain, type IconFetchPayload, type IconFetcher } from './best-icon-finder'

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


describe('icon cancellation and bounded responses', () => {
  it('passes cancellation to page and icon requests and never starts fallback requests after abort', async () => {
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const fetcher = vi.fn(async (url: string, signal?: AbortSignal) => {
      seen.push(signal!)
      if (url === 'http://example.com/') return html('<link rel="icon" href="/one.png">', url)
      controller.abort(new DOMException('cancel icons', 'AbortError'))
      signal!.throwIfAborted()
      return image('image/png', 10)
    })
    await expect(new BestIconFinder(fetcher).findBestIcon('example.com', controller.signal)).rejects.toThrow('cancel icons')
    expect(seen).toEqual([controller.signal, controller.signal])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('cancels an idle body read as soon as its AbortSignal aborts', async () => {
    const controller = new AbortController()
    let fetchSignal: AbortSignal | null | undefined
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ pull() { started() }, cancel: cancelled }))
    const pending = fetchIconPayload('https://example.com/icon', { lookup: async () => [{ address: '1.1.1.1' }], fetchImpl: async (_url, init) => { fetchSignal = init?.signal; return response } }, controller.signal)
    await reading
    controller.abort(new DOMException('cancel body', 'AbortError'))
    await expect(pending).rejects.toThrow('cancel body')
    expect(fetchSignal?.aborted).toBe(true)
    expect(cancelled).toHaveBeenCalledOnce()
  })
  it.each([true, false])('bounds icon bytes with declared size=%s', async declared => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(MAX_ICON_RESPONSE_BYTES + 1)) }, cancel: cancelled }), { headers: declared ? { 'content-length': String(MAX_ICON_RESPONSE_BYTES + 1) } : {} })
    await expect(fetchIconPayload('https://example.com/icon', { lookup: async () => [{ address: '1.1.1.1' }], fetchImpl: async () => response })).rejects.toThrow('响应体大小超过限制')
    expect(cancelled).toHaveBeenCalledOnce()
  })
})
