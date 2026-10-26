import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WEB_SEARCH_PROVIDER_KINDS,
  webSearchProviderDefinition,
  type WebSearchProviderProfile,
  type WebSearchRequest
} from '../../shared/web-search'
import { MemorySecretStore } from '../security/secret-store'
import { DeepSeekWebSearchAdapter, WebSearchException, parseDeepSeekResponse } from './web-search-adapters'
import { WebSearchRepository } from './web-search-repository'
import { WebSearchService } from './web-search-service'
import { WebSearchRouter, buildDeepSeekSearchQuery, buildSearchQuery } from './web-search-router'

const servers: Server[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const database of databases.splice(0)) database.close()
})

describe('DeepSeek standalone Web Search parity with Android', () => {
  it('registers an opt-in provider without changing existing defaults or enabling search', () => {
    const repository = createRepository()
    new WebSearchService(repository)
    expect(repository.current()).toMatchObject({ mode: 'OFF', providers: [], defaultProviderId: null })
    const existing = repository.addProvider('TAVILY').providers[0]!
    const deepseek = repository.addProvider('DEEPSEEK').providers.find((item) => item.kind === 'DEEPSEEK')!
    expect(deepseek).toMatchObject({
      name: 'DeepSeek Search', endpoint: 'https://api.deepseek.com/v1/tools/search', hasApiKey: false
    })
    expect(repository.current()).toMatchObject({ mode: 'OFF', defaultProviderId: existing.id })
    expect(repository.isConfigured(deepseek.id)).toBe(false)
    repository.updateProvider({ id: deepseek.id, apiKey: 'deepseek-fixture-key' })
    expect(repository.isConfigured(deepseek.id)).toBe(true)
    expect(repository.current().defaultProviderId).toBe(existing.id)
  })

  it('sends the frozen long-title query with the standalone protocol and original credential', async () => {
    const fixture = await fixtureServer({ results: [searchResult({ content: '' })] })
    const { repository, router, provider } = configuredSearch(fixture.url)
    const prepared = router.prepareSearch('FORCE', 'latest updates', 'A'.repeat(200))
    repository.updateProvider({ id: provider.id, endpoint: 'http://127.0.0.1:1/unused', apiKey: 'changed-fixture-key' })
    const outcome = await router.executePreparedSearch(prepared)

    expect(prepared.plan.query).toBe('A'.repeat(111) + ' — latest updates')
    expect(prepared.plan.request?.query).toBe(prepared.plan.query)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]).toMatchObject({
      method: 'POST', url: '/custom/search',
      headers: { authorization: 'Bearer deepseek-fixture-key', accept: 'application/json', 'content-type': 'application/json' }
    })
    expect(JSON.parse(fixture.requests[0]!.body)).toEqual({
      query: prepared.plan.query, count: 7, need_content: false
    })
    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.response?.results[0]).toMatchObject({
      snippet: 'short preview', content: 'long evidence', publishedAt: null, source: 'example.com'
    })
  })

  it('uses the registered adapter for a minimal health check', async () => {
    const fixture = await fixtureServer({ results: [searchResult()] })
    const { service, provider } = configuredSearch(fixture.url)
    expect(await service.checkHealth(provider.id)).toMatchObject({ providerId: provider.id, resultCount: 1 })
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ count: 1, need_content: false })
  })

  it('counts Unicode code points for the added title without splitting emoji', () => {
    const input = '🚀'.repeat(10)
    const query = buildDeepSeekSearchQuery('🌍'.repeat(200), input)
    expect(query).toBe('🌍'.repeat(115) + ' — ' + input)
    expect(Array.from(query)).toHaveLength(128)
    expect(buildDeepSeekSearchQuery('OrigRead', 'latest updates')).toBe('OrigRead — latest updates')
    expect(buildDeepSeekSearchQuery('OrigRead', 'latest OrigRead version')).toBe('latest OrigRead version')
    expect(buildDeepSeekSearchQuery(null, 'latest updates')).toBe('latest updates')
    expect(buildDeepSeekSearchQuery('Article context', '问'.repeat(126))).toBe('问'.repeat(126))
  })

  it('sends all 128 user code points and includes page content only when requested', async () => {
    const fixture = await fixtureServer({ results: [searchResult()] })
    const { service, router } = configuredSearch(fixture.url)
    const input = '😀'.repeat(128)
    const prepared = router.prepareSearch('FORCE', input, 'Article context')
    const response = await service.searchPrepared(
      { ...prepared.plan.request!, includeContent: true },
      prepared.providerSnapshot!
    )
    expect(prepared.plan.query).toBe(input)
    expect(prepared.plan.request?.query).toBe(input)
    expect(JSON.parse(fixture.requests[0]!.body)).toEqual({ query: input, count: 7, need_content: true })
    expect(response.results[0]?.content).toBe('long evidence\n\npage evidence')
  })

  it.each([129, 600])('keeps a %i-code-point question intact and rejects it before HTTP', async (count) => {
    const fixture = await fixtureServer({ results: [] })
    const { service, router } = configuredSearch(fixture.url)
    const input = '😀'.repeat(count)
    const prepared = router.prepareSearch('FORCE', input, 'Article context')
    expect(prepared.plan.query).toBe(input)
    expect(prepared.plan.request?.query).toBe(input)
    await expect(service.searchPrepared(prepared.plan.request!, prepared.providerSnapshot!)).rejects.toThrow('128')
    expect(fixture.requests).toHaveLength(0)
  })

  it('maps an oversized question to AUTO fallback or FORCE failure without changing it', async () => {
    const fixture = await fixtureServer({ results: [] })
    const { router } = configuredSearch(fixture.url)
    const input = 'latest ' + '问'.repeat(129)
    expect(await router.executePreparedSearch(router.prepareSearch('AUTO', input, 'Context')))
      .toMatchObject({ status: 'FAILED_FALLBACK', requiredFailure: false })
    expect(await router.executePreparedSearch(router.prepareSearch('FORCE', input, 'Context')))
      .toMatchObject({ status: 'FAILED_REQUIRED', requiredFailure: true })
    expect(fixture.requests).toHaveLength(0)
  })

  it('keeps the existing query composition for every other provider', () => {
    const title = 'A'.repeat(350)
    const input = 'B'.repeat(150)
    for (const kind of WEB_SEARCH_PROVIDER_KINDS.filter((value) => value !== 'DEEPSEEK')) {
      const repository = createRepository()
      const provider = repository.addProvider(kind).providers[0]!
      repository.updateProvider({ id: provider.id, endpoint: 'http://127.0.0.1:1/unused', apiKey: 'fixture-key' })
      const prepared = new WebSearchRouter(repository, new WebSearchService(repository)).prepareSearch('FORCE', input, title)
      expect(prepared.plan.query, kind).toBe(buildSearchQuery(title, input))
      expect(prepared.plan.request?.query, kind).toBe(prepared.plan.query)
    }
  })

  it('preserves ranking, summary evidence and missing, null or string dates', () => {
    const missingDate = searchResult({ title: 'Missing date' })
    delete missingDate.date
    const payload = { results: [
      missingDate,
      searchResult({ title: 'Null date', date: null }),
      searchResult({ title: 'Known date', date: '2026-10-17T00:00:00Z' }),
      searchResult({ title: 'Empty date', date: '' })
    ] }
    const response = parseDeepSeekResponse(profile(), payload)
    expect(response.results.map((item) => item.title)).toEqual(['Missing date', 'Null date', 'Known date', 'Empty date'])
    expect(response.results.map((item) => item.publishedAt)).toEqual([null, null, '2026-10-17T00:00:00Z', ''])
    expect(response.results.every((item) => item.content === 'long evidence')).toBe(true)
    expect(parseDeepSeekResponse(profile(), payload, true).results[0]?.content).toBe('long evidence\n\npage evidence')
    expect(parseDeepSeekResponse(profile(), { results: [] }).results).toEqual([])
  })

  it.each([
    { payload: null }, { payload: [] }, { payload: {} },
    { payload: { results: null } }, { payload: { results: {} } }, { payload: { results: [null] } }
  ])(
    'rejects malformed envelopes instead of reporting an empty successful search: %j', ({ payload }) => {
      expect(() => parseDeepSeekResponse(profile(), payload)).toThrow(WebSearchException)
    }
  )

  it('rejects missing or incorrectly typed evidence, invalid dates and non-web URLs', () => {
    const missingSummary = searchResult()
    delete missingSummary.summary
    const invalidResults = [
      missingSummary,
      searchResult({ summary: {} }),
      searchResult({ content: null }),
      searchResult({ title: 42 }),
      searchResult({ snippet: false }),
      searchResult({ date: false }),
      searchResult({ date: 123 }),
      searchResult({ date: {} }),
      searchResult({ url: 'javascript:alert(1)' }),
      searchResult({ url: 'not a URL' })
    ]
    for (const result of invalidResults) {
      expect(() => parseDeepSeekResponse(profile(), { results: [result] })).toThrow(WebSearchException)
    }
  })

  it.each([401, 429, 500])('preserves HTTP %i errors even with a valid empty result body', async (status) => {
    const fixture = await fixtureServer({ results: [] }, status)
    await expect(new DeepSeekWebSearchAdapter().search(profile(fixture.url), 'fixture-key', request()))
      .rejects.toThrow(`HTTP ${status}`)
  })

  it('preserves caller cancellation while the response body is still arriving', async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => { resolveStarted = resolve })
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"results":[')
      resolveStarted()
    })
    const url = await listen(server)
    const { router } = configuredSearch(url)
    const controller = new AbortController()
    const reason = new DOMException('fixture cancelled', 'AbortError')
    const pending = router.executePreparedSearch(router.prepareSearch('FORCE', 'latest news'), controller.signal)
    await started
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })
})

function createRepository(): WebSearchRepository {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  databases.push(database)
  return new WebSearchRepository(database, new MemorySecretStore())
}

function configuredSearch(endpoint: string) {
  const repository = createRepository()
  const provider = repository.addProvider('DEEPSEEK').providers[0]!
  repository.updateProvider({ id: provider.id, endpoint, apiKey: 'deepseek-fixture-key' })
  repository.updateSettings({ mode: 'AUTO', maxResults: 7 })
  const service = new WebSearchService(repository)
  return { repository, provider, service, router: new WebSearchRouter(repository, service) }
}

function profile(endpoint = 'https://api.deepseek.com/v1/tools/search'): WebSearchProviderProfile {
  return { id: 'deepseek-fixture', kind: 'DEEPSEEK', name: webSearchProviderDefinition('DEEPSEEK').defaultName,
    endpoint, enabled: true, hasApiKey: true, apiKeyLength: 11 }
}

function request(): WebSearchRequest {
  return { query: 'latest news', maxResults: 5, includeContent: false, timeoutMs: 5_000 }
}

function searchResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { rerank_score: 2.4, title: 'Search result', url: 'https://example.com/article',
    snippet: 'short preview', summary: 'long evidence', content: 'page evidence',
    site_name: 'Example', site_icon: null, date: null, authority: 3, ...overrides }
}

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture port missing')
  return `http://127.0.0.1:${address.port}/custom/search`
}

async function fixtureServer(payload: unknown, status = 200) {
  const requests: Array<{ headers: IncomingHttpHeaders; method: string; url: string; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ headers: request.headers, method: request.method ?? '', url: request.url ?? '', body })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })
  return { url: await listen(server), requests }
}
