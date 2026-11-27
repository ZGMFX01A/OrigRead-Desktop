import { describe, expect, it, vi } from 'vitest'
import { defaultArticlePageFetcher } from '../content/article-full-content-service'
import { defaultWebsiteFetcher } from '../sources/website/website-source-support'
import { fetchJsonText } from '../sources/json/json-source-service'
import { fetchRssPayload } from '../sources/rss/rss-discovery-service'
import { fetchIconPayload, MAX_ICON_RESPONSE_BYTES } from '../sources/rss/best-icon-finder'
import { fetchRssHubPayload } from '../sources/rsshub/rsshub-resolver'
import { fetchPage } from '../ai/ai-rule-generation-service'
import type { SafeFetchOptions } from './safe-fetch'

const entries = [
  ['article', (url: string, options: SafeFetchOptions) => defaultArticlePageFetcher(url, undefined, options)],
  ['website', (url: string, options: SafeFetchOptions) => defaultWebsiteFetcher(url, undefined, options)],
  ['json', (url: string, options: SafeFetchOptions) => fetchJsonText(url, undefined, options)],
  ['rss', (url: string, options: SafeFetchOptions) => fetchRssPayload(url, {}, undefined, options)],
  ['icon', (url: string, options: SafeFetchOptions) => fetchIconPayload(url, options)],
  ['rsshub', (url: string, options: SafeFetchOptions) => fetchRssHubPayload(url, {}, undefined, options)],
  ['ai', (url: string, options: SafeFetchOptions) => fetchPage(url, options)]
] as const

describe.each(entries)('%s fetch security', (_name, run) => {
  it('blocks initial loopback and private URLs before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    for (const url of ['http://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/']) {
      await expect(run(url, { fetchImpl })).rejects.toThrow('私网')
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['https://127.0.0.1/', 'https://10.0.0.1/', 'https://internal.example/'])('blocks redirect to %s', async location => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status: 302, headers: { location }}))
    const lookup = async (host: string) => [{address: host === 'internal.example' ? '192.168.1.1' : '1.1.1.1'}]
    await expect(run('https://public.example/', {fetchImpl, lookup})).rejects.toThrow(/私网/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

it('limits icon streams even without content-length', async () => {
  const cancel = vi.fn()
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_ICON_RESPONSE_BYTES + 1)) }, cancel
  })))
  await expect(fetchIconPayload('https://public.example/icon', {fetchImpl, lookup: async () => [{address:'1.1.1.1'}]})).rejects.toThrow('超过限制')
  expect(cancel).toHaveBeenCalledOnce()
})

it('permits an explicit self-hosted first hop but blocks loopback redirects', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {status:302, headers:{location:'http://127.0.0.1:1234/next'}}))
  await expect(fetchRssHubPayload('http://127.0.0.1:1234/feed', {}, undefined, {
    fetchImpl, allowedInitialOrigins: new Set(['http://127.0.0.1:1234'])
  })).rejects.toThrow('私网')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})
