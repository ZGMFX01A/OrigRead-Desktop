import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { assertSafeTargetUrl, isLoopbackHost, isPrivateOrReservedIp, safeFetch, setE2eLoopbackFetchEnabled, MAX_REPLAY_REQUEST_BODY_BYTES } from './safe-fetch'

const lookup = async () => [{ address: '1.1.1.1' }]
const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } })

describe('safe HTTP targets', () => {
  it.each(['localhost', 'FOO.Localhost.', '[::1]', '127.10.2.3', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1'])('recognizes loopback %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::a00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::a00:1', '2002:0a00:0001::1'])('blocks reserved %s', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true)
  })
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808', '2002:0808:0808::1', '64:ff9b::808:808'])('allows public %s', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false)
    expect(isLoopbackHost(ip)).toBe(false)
  })
  it('rejects empty/mixed/private DNS answers and propagates DNS errors', async () => {
    for (const addresses of [[], [{ address: '10.1.1.1' }], [{ address: '1.1.1.1' }, { address: '192.168.1.1' }]]) {
      await expect(assertSafeTargetUrl(new URL('https://example.com'), { blockPrivateNetwork: true, lookup: async () => addresses })).rejects.toThrow('DNS')
    }
    await expect(assertSafeTargetUrl(new URL('https://example.com'), { blockPrivateNetwork: true, lookup: async () => { throw new Error('DNS failed') } })).rejects.toThrow('DNS failed')
  })
  it('rejects unsupported protocols, URL credentials and public HTTP with credentials', async () => {
    for (const url of ['file:///test', 'https://user:pass@example.com', 'http://example.com']) {
      const fetchImpl = vi.fn<typeof fetch>()
      await expect(safeFetch(url, { headers: { Authorization: 'secret' } }, { fetchImpl, lookup })).rejects.toThrow()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })
  it.each(['Authorization', 'x-api-key', 'X-Custom-Secret'])('refuses cross-origin credentials %s', async (name) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect('https://other.example/'))
    await expect(safeFetch('https://example.com', { headers: { [name]: 'secret' } }, { fetchImpl, lookup, sensitiveHeaderNames: ['x-custom-secret'] })).rejects.toThrow('跨源')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['http://example.com', 'https://169.254.169.254', 'https://127.0.0.1'])('rejects unsafe redirect %s', async (location) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect(location))
    await expect(safeFetch('https://example.com', undefined, { fetchImpl, lookup })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('limits redirects and releases discarded bodies', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: '/again' } }))
    await expect(safeFetch('https://example.com', undefined, { fetchImpl, lookup, maxRedirects: 1 })).rejects.toThrow('次数')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(2)
  })
  it.each([302, 307, 308])('preserves same-origin GET on %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/next', status)).mockResolvedValueOnce(new Response('ok'))
    expect(await (await safeFetch('https://example.com', { headers: { Authorization: 'secret' } }, { fetchImpl, lookup })).text()).toBe('ok')
    expect(new Headers(fetchImpl.mock.calls[1]![1]?.headers).get('authorization')).toBe('secret')
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'manual')).toBe(true)
  })
  it.each([301, 302, 303, 307, 308])('honors POST semantics for %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/next', status)).mockResolvedValueOnce(new Response('ok'))
    await safeFetch('https://example.com', { method: 'POST', body: 'data', headers: { 'content-type': 'text/plain', 'content-length': '4' } }, { fetchImpl, lookup })
    const init = fetchImpl.mock.calls[1]![1]!
    expect(init.method).toBe(status >= 307 ? 'POST' : 'GET')
    expect(init.body).toBe(status >= 307 ? 'data' : undefined)
    expect(new Headers(init.headers).has('content-type')).toBe(status >= 307)
    expect(new Headers(init.headers).has('content-length')).toBe(status >= 307)
  })
  it('does not extend configured-origin exemptions to redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect('/next'))
    await expect(safeFetch('https://10.0.0.1', undefined, { fetchImpl, allowedInitialOrigins: new Set(['https://10.0.0.1']) })).rejects.toThrow('私网')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each(['fec0::1', 'feff::1'])('rejects IPv6 site-local literals and DNS answers %s', async (address) => {
    expect(isPrivateOrReservedIp(address)).toBe(true)
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(safeFetch(`https://[${address}]`, undefined, { fetchImpl })).rejects.toThrow('私网')
    await expect(safeFetch('https://example.com', undefined, { fetchImpl, lookup: async () => [{ address }] })).rejects.toThrow('DNS')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each([302, 307])('allows same-origin public HTTP without credentials on %s', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/next', status)).mockResolvedValueOnce(new Response('ok'))
    expect(await (await safeFetch('http://example.com', undefined, { fetchImpl, lookup })).text()).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('requires HTTPS for an unauthenticated cross-origin redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect('http://other.example.com'))
    await expect(safeFetch('http://example.com', undefined, { fetchImpl, lookup })).rejects.toThrow('HTTPS')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
  it.each([307, 308])('replays Request bodies through real HTTP %s responses', async (status) => {
    const received: Array<{ method?: string; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push({ method: request.method, body: Buffer.concat(chunks).toString() })
        if (request.url === '/start') response.writeHead(status, { location: '/end' }).end()
        else response.end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture port missing')
      const input = new Request(`http://127.0.0.1:${address.port}/start`, { method: 'POST', body: 'request-body' })
      const response = await safeFetch(input, undefined, { allowLoopbackHttp: true })
      expect(await response.text()).toBe('ok')
      expect(received).toEqual([{ method: 'POST', body: 'request-body' }, { method: 'POST', body: 'request-body' }])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
  it('bounds streamed request replay data before sending any request', async () => {
    const cancel = vi.fn()
    let bytes = 0
    const stream = new ReadableStream({
      pull(controller) { bytes += 65_536; controller.enqueue(new Uint8Array(65_536)) },
      cancel
    })
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(safeFetch('https://example.com', { method: 'POST', body: stream }, { fetchImpl, lookup })).rejects.toThrow('请求体超过重定向重放安全上限')
    expect(bytes).toBeLessThanOrEqual(MAX_REPLAY_REQUEST_BODY_BYTES + 2 * 65_536)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
it('uses the pinned socket lookup with the native fetch transport', async () => {
  const server = createServer((_request,response)=>response.end('pinned'))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address = server.address()
  if(!address || typeof address==='string') throw new Error('test server did not bind')
  const lookup = vi.fn().mockResolvedValueOnce([{address:'127.0.0.1'}]).mockRejectedValue(new Error('unexpected second DNS lookup'))
  try {
    const response = await safeFetch(`http://localhost:${address.port}/`,undefined,{lookup,allowLoopbackHttp:true})
    expect(await response.text()).toBe('pinned')
    expect(lookup).toHaveBeenCalledTimes(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

it('allows loopback only when E2E loopback mode is enabled while still blocking other private IPs', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'))
  try {
    setE2eLoopbackFetchEnabled(true)
    const loopbackResponse = await safeFetch('http://127.0.0.1:4321/feed.xml', undefined, { fetchImpl })
    expect(await loopbackResponse.text()).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(safeFetch('http://10.0.0.1/feed.xml', undefined, { fetchImpl })).rejects.toThrow('私网')
    await expect(safeFetch('https://192.168.1.1/feed.xml', undefined, { fetchImpl })).rejects.toThrow('私网')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  } finally {
    setE2eLoopbackFetchEnabled(false)
  }
  await expect(safeFetch('http://127.0.0.1:4321/feed.xml', undefined, { fetchImpl })).rejects.toThrow('私网')
})
