import { Agent } from 'undici'
import type { LookupFunction } from 'node:net'
import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { readResponseBytes, ResponsePayloadLimitExceededError } from './safe-response-reader'

// Streams must be replayable before sending the first hop. Bound retained request data too.
export const MAX_REPLAY_REQUEST_BODY_BYTES = 10 * 1024 * 1024

export type DnsLookupFn = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>
const normalizeHost = (host: string): string => host.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()

function ipv6Groups(ip: string): number[] {
  let value = ip
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':')
    const bytes = value.slice(colon + 1).split('.').map(Number)
    value = `${value.slice(0, colon)}:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`
  }
  const halves = value.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map((group) => parseInt(group, 16))
}

function embeddedV4(a: number, b: number): string {
  return `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host) === 4) return host.split('.')[0] === '127'
  if (isIP(host) !== 6) return false
  const g = ipv6Groups(host)
  return (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) ||
    (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff && (g[6]! >>> 8) === 127)
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const host = normalizeHost(ip)
  const version = isIP(host)
  if (version === 4) {
    const [a, b, c] = host.split('.').map(Number) as [number, number, number, number]
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
  }
  if (version !== 6) return false
  const g = ipv6Groups(host)
  if (g.slice(0, 6).every((n) => n === 0)) return true // IPv4-compatible is reserved.
  if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 || (g[0]! & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0xdb8)) return true
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPrivateOrReservedIp(embeddedV4(g[6]!, g[7]!))
  if (g[0] === 0x2002) return isPrivateOrReservedIp(embeddedV4(g[1]!, g[2]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && (g[2] === 1 || g.slice(2, 6).every((n) => n === 0))) return isPrivateOrReservedIp(embeddedV4(g[6]!, g[7]!))
  return false
}

export function isPrivateOrLoopbackHostLiteral(hostname: string): boolean {
  const host = normalizeHost(hostname)
  return isLoopbackHost(host) || (isIP(host) > 0 && isPrivateOrReservedIp(host))
}

interface TargetPolicy {
  requireHttps?: boolean
  allowLoopbackHttp?: boolean
  allowLoopback?: boolean
  blockPrivateNetwork?: boolean
  lookup?: DnsLookupFn
}

export async function assertSafeTargetUrl(url: URL, policy: TargetPolicy): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('目标 URL 只支持 HTTP/HTTPS')
  if (url.username || url.password) throw new Error('目标 URL 不允许包含认证凭据')
  if (policy.requireHttps && url.protocol !== 'https:' && !(policy.allowLoopbackHttp && isLoopbackHost(url.hostname))) throw new Error('目标 URL 必须使用 HTTPS')
  if (!policy.blockPrivateNetwork) return
  const allowed = (ip: string): boolean => !!policy.allowLoopback && isLoopbackHost(ip)
  if (isPrivateOrLoopbackHostLiteral(url.hostname) && !allowed(url.hostname)) throw new Error('拒绝访问私网或保留地址')
  const host = normalizeHost(url.hostname)
  if (isIP(host)) return
  const addresses = await (policy.lookup ?? ((name) => dnsLookup(name, { all: true, verbatim: true })))(host)
  if (!addresses.length || addresses.some(({ address }) => !isIP(address) || (isPrivateOrReservedIp(address) && !allowed(address)))) throw new Error('DNS 解析包含私网或无效地址')
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch
  lookup?: DnsLookupFn
  maxRedirects?: number
  allowLoopbackHttp?: boolean
  allowedInitialOrigins?: ReadonlySet<string>
  requireHttpsForSensitiveHeaders?: boolean
  requireHttps?: boolean
  blockPrivateNetwork?: boolean
  sensitiveHeaderNames?: readonly string[]
}

export async function safeFetch(input: string | URL | Request, init: RequestInit | undefined, options: SafeFetchOptions = {}): Promise<Response> {
  const request = input instanceof Request ? input : undefined
  let url = new URL(request ? request.url : String(input))
  let current: RequestInit = { ...(request ? { method: request.method, headers: request.headers, body: request.body, signal: request.signal, duplex: 'half' } : {}), ...init }
  let crossedOrigin = false
  const sensitive = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-subscription-token', 'api-key', ...(options.sensitiveHeaderNames ?? [])].map((name) => name.toLowerCase()))
  const max = options.maxRedirects ?? 5
  if (!Number.isInteger(max) || max < 0) throw new Error('maxRedirects 无效')
  for (let hop = 0; ; hop++) {
    const headers = new Headers(current.headers)
    const hasCredentials = [...sensitive].some((name) => headers.has(name))
    let pinnedAddresses: ReadonlyArray<{address: string}> | undefined
    await assertSafeTargetUrl(url, {
      lookup: async (host) => {
        const addresses = await (options.lookup ?? ((name) => dnsLookup(name, {all:true, verbatim:true})))(host)
        pinnedAddresses = addresses.map(({address}) => ({address}))
        return pinnedAddresses
      },
      requireHttps: crossedOrigin || options.requireHttps || (hasCredentials && options.requireHttpsForSensitiveHeaders !== false && !isLoopbackHost(url.hostname)),
      allowLoopbackHttp: options.allowLoopbackHttp,
      allowLoopback: options.allowLoopbackHttp && isLoopbackHost(url.hostname),
      blockPrivateNetwork: hop === 0 ? (options.allowedInitialOrigins?.has(url.origin) ? false : options.blockPrivateNetwork !== false) : true
    })
    if (current.body instanceof ReadableStream) {
      try {
        const bytes = await readResponseBytes(new Response(current.body), MAX_REPLAY_REQUEST_BODY_BYTES, current.signal ?? undefined)
        current = { ...current, body: new Uint8Array(bytes) }
      } catch (error) {
        if (error instanceof ResponsePayloadLimitExceededError) throw new Error('请求体超过重定向重放安全上限', { cause: error })
        throw error
      }
    }
    // Keep the original hostname for Host/SNI/certificate verification, while the
    // socket lookup returns only the exact addresses validated for this hop.
    const dispatcher = pinnedAddresses ? new Agent({connect: {lookup: pinnedLookup(pinnedAddresses)}}) : undefined
    let response: Response
    try {
      const requestInit: RequestInit = { ...current, headers, redirect: 'manual', ...(dispatcher ? {dispatcher: dispatcher as unknown as RequestInit['dispatcher']} : {}) }
      response = await (options.fetchImpl ?? globalThis.fetch)(url, requestInit)
    } finally {
      // Graceful close waits for the response body to finish/cancel; do not await
      // here because callers still need to consume the bounded response stream.
      if (dispatcher) void dispatcher.close().catch(error => console.warn('安全抓取连接池关闭失败', error))
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    // Only resource-release failures are ignored; redirect validation errors propagate.
    try {
      await response.body?.cancel()
    } catch (error) {
      console.warn('重定向响应流释放失败', error)
    }
    if (hop >= max) throw new Error('重定向次数超过安全上限')
    const location = response.headers.get('location')
    if (!location) throw new Error('重定向缺少 Location')
    const next = new URL(location, url)
    if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error('拒绝 HTTPS 降级重定向')
    if (next.origin !== url.origin) {
      if (hasCredentials) throw new Error(`拒绝将包含认证凭据的请求跨源重定向至 ${next.origin}`)
      for (const name of sensitive) headers.delete(name)
      crossedOrigin = true
    }
    if (response.status === 303 || ([301, 302].includes(response.status) && (current.method ?? 'GET').toUpperCase() === 'POST')) {
      current = { ...current, method: 'GET', body: undefined }
      headers.delete('content-type')
      headers.delete('content-length')
    }
    current = { ...current, headers }
    url = next
  }
}

function pinnedLookup(addresses: ReadonlyArray<{address: string}>): LookupFunction {
  return ((_hostname, options, callback) => {
    const candidates = addresses.map(({address}) => ({address, family: isIP(address)}))
    const family = typeof options === 'number' ? options : options.family
    const selected = family === 4 || family === 6 ? candidates.filter(item => item.family === family) : candidates
    if (!selected.length) {
      callback(new Error('已验证的 DNS 地址不支持请求的地址族'), '', 0)
    } else if (typeof options === 'object' && options.all) {
      callback(null, selected)
    } else {
      callback(null, selected[0]!.address, selected[0]!.family)
    }
  }) as LookupFunction
}
