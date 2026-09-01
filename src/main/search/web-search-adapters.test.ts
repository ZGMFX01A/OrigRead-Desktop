import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSearchProviderProfile, WebSearchRequest } from '../../shared/web-search'
import { ExaWebSearchAdapter, KeenableWebSearchAdapter, TavilyWebSearchAdapter, resolveKeenableEndpoint } from './web-search-adapters'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('Dedicated Search provider adapters', () => {
  it('uses current Tavily Bearer contract and normalizes results', async () => {
    const fixture = await fixtureServer((_request, body) => ({
      results: [{ title: 'Tavily result', url: 'https://example.com/a', content: 'snippet', score: 0.9 }],
      _capturedBody: body
    }))
    const response = await new TavilyWebSearchAdapter().search(profile('TAVILY', fixture.url), 'tvly-key', request())
    expect(fixture.requests[0]?.headers.authorization).toBe('Bearer tvly-key')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'latest OpenAI news', max_results: 5, search_depth: 'basic', include_answer: false, include_raw_content: false })
    expect(response.results[0]).toMatchObject({ title: 'Tavily result', source: 'example.com', snippet: 'snippet' })
  })

  it('uses Exa x-api-key/numResults contract and prefers highlights as snippet', async () => {
    const fixture = await fixtureServer(() => ({
      results: [{ title: 'Exa result', url: 'https://exa.example/item', publishedDate: '2026-09-01T00:00:00Z', highlights: ['first', 'second'], text: 'full text' }]
    }))
    const response = await new ExaWebSearchAdapter().search(profile('EXA', fixture.url), 'exa-key', request())
    expect(fixture.requests[0]?.headers['x-api-key']).toBe('exa-key')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'latest OpenAI news', numResults: 5, type: 'auto', contents: { highlights: true } })
    expect(response.results[0]).toMatchObject({ snippet: 'first … second', publishedAt: '2026-09-01T00:00:00Z', content: 'full text' })
  })

  it('supports keyless Keenable custom endpoints and preserves official public/private endpoint semantics', async () => {
    const fixture = await fixtureServer(() => ({ results: [{ title: 'Keenable result', url: 'https://keen.example/x', snippet: 'fast result' }] }))
    const response = await new KeenableWebSearchAdapter().search(profile('KEENABLE', fixture.url), '', request())
    expect(fixture.requests[0]?.headers['x-keenable-title']).toBe('OrigRead')
    expect(fixture.requests[0]?.headers['x-api-key']).toBeUndefined()
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'latest OpenAI news', max_results: 5 })
    expect(response.results[0]).toMatchObject({ title: 'Keenable result', snippet: 'fast result' })
    expect(resolveKeenableEndpoint('https://api.keenable.ai/v1/search/public', true)).toBe('https://api.keenable.ai/v1/search')
    expect(resolveKeenableEndpoint('https://api.keenable.ai/v1/search', false)).toBe('https://api.keenable.ai/v1/search/public')
  })
})

function request(): WebSearchRequest {
  return { query: 'latest OpenAI news', maxResults: 5, includeContent: false, timeoutMs: 5_000 }
}

function profile(kind: WebSearchProviderProfile['kind'], endpoint: string): WebSearchProviderProfile {
  return { id: `${kind.toLowerCase()}-id`, kind, name: kind, endpoint, enabled: true, hasApiKey: false, apiKeyLength: 0 }
}

async function fixtureServer(payload: (request: { headers: Record<string, string | undefined> }, body: string) => unknown) {
  const requests: Array<{ headers: Record<string, string | undefined>; body: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
      requests.push({ headers, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload({ headers }, body)))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port missing')
  return { url: `http://127.0.0.1:${address.port}/search`, requests }
}
