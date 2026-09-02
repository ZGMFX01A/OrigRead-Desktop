import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebSearchProviderProfile, WebSearchRequest } from '../../shared/web-search'
import {
  BraveWebSearchAdapter,
  ExaWebSearchAdapter,
  FirecrawlWebSearchAdapter,
  KeenableWebSearchAdapter,
  LinkupWebSearchAdapter,
  PerplexityWebSearchAdapter,
  SearxngWebSearchAdapter,
  TavilyWebSearchAdapter,
  resolveKeenableEndpoint
} from './web-search-adapters'

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

  it('supports Brave Search GET contract and extra snippets', async () => {
    const fixture = await fixtureServer(() => ({
      web: { results: [{ title: 'Brave result', url: 'https://brave.example/item', description: 'main', extra_snippets: ['extra'], page_age: '2026-09-01' }] }
    }))
    const response = await new BraveWebSearchAdapter().search(profile('BRAVE', fixture.url), 'brave-key', request())
    expect(fixture.requests[0]?.method).toBe('GET')
    expect(fixture.requests[0]?.headers['x-subscription-token']).toBe('brave-key')
    const url = new URL(fixture.requests[0]!.url)
    expect(url.searchParams.get('q')).toBe('latest OpenAI news')
    expect(url.searchParams.get('count')).toBe('5')
    expect(url.searchParams.get('extra_snippets')).toBe('false')
    expect(response.results[0]).toMatchObject({ title: 'Brave result', snippet: 'main\nextra', publishedAt: '2026-09-01' })
  })

  it('supports Perplexity Search API contract', async () => {
    const fixture = await fixtureServer(() => ({ results: [{ title: 'PPLX result', url: 'https://pplx.example/item', snippet: 'snippet', date: '2026-09-01' }] }))
    const response = await new PerplexityWebSearchAdapter().search(profile('PERPLEXITY', fixture.url), 'pplx-key', request())
    expect(fixture.requests[0]?.headers.authorization).toBe('Bearer pplx-key')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'latest OpenAI news', max_results: 5, max_tokens_per_page: 512 })
    expect(response.results[0]).toMatchObject({ title: 'PPLX result', snippet: 'snippet', publishedAt: '2026-09-01' })
  })

  it('supports Linkup searchResults contract and caps returned results', async () => {
    const fixture = await fixtureServer(() => ({ results: Array.from({ length: 7 }, (_, index) => ({ name: `Result ${index}`, url: `https://linkup.example/${index}`, content: `content ${index}` })) }))
    const response = await new LinkupWebSearchAdapter().search(profile('LINKUP', fixture.url), 'linkup-key', request())
    expect(fixture.requests[0]?.headers.authorization).toBe('Bearer linkup-key')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ q: 'latest OpenAI news', depth: 'standard', outputType: 'searchResults' })
    expect(response.results).toHaveLength(5)
    expect(response.results[0]).toMatchObject({ title: 'Result 0', snippet: 'content 0' })
  })

  it('supports Firecrawl v2 web search contract', async () => {
    const fixture = await fixtureServer(() => ({ data: { web: [{ title: 'Firecrawl result', url: 'https://firecrawl.example/item', description: 'description', markdown: '# content' }] } }))
    const response = await new FirecrawlWebSearchAdapter().search(profile('FIRECRAWL', fixture.url), 'firecrawl-key', { ...request(), includeContent: true })
    expect(fixture.requests[0]?.headers.authorization).toBe('Bearer firecrawl-key')
    expect(JSON.parse(fixture.requests[0]!.body)).toMatchObject({ query: 'latest OpenAI news', limit: 5, sources: ['web'], scrapeOptions: { formats: [{ type: 'markdown' }] } })
    expect(response.results[0]).toMatchObject({ title: 'Firecrawl result', snippet: 'description', content: '# content' })
  })

  it('supports keyless SearXNG JSON Search API and caps results', async () => {
    const fixture = await fixtureServer(() => ({ results: Array.from({ length: 7 }, (_, index) => ({ title: `Result ${index}`, url: `https://searx.example/${index}`, content: `snippet ${index}`, publishedDate: '2026-09-01' })) }))
    const response = await new SearxngWebSearchAdapter().search(profile('SEARXNG', fixture.url), '', request())
    expect(fixture.requests[0]?.method).toBe('GET')
    const url = new URL(fixture.requests[0]!.url)
    expect(url.searchParams.get('q')).toBe('latest OpenAI news')
    expect(url.searchParams.get('format')).toBe('json')
    expect(response.results).toHaveLength(5)
    expect(response.results[0]).toMatchObject({ title: 'Result 0', snippet: 'snippet 0', publishedAt: '2026-09-01' })
  })
})

function request(): WebSearchRequest {
  return { query: 'latest OpenAI news', maxResults: 5, includeContent: false, timeoutMs: 5_000 }
}

function profile(kind: WebSearchProviderProfile['kind'], endpoint: string): WebSearchProviderProfile {
  return { id: `${kind.toLowerCase()}-id`, kind, name: kind, endpoint, enabled: true, hasApiKey: false, apiKeyLength: 0 }
}

async function fixtureServer(payload: (request: { headers: Record<string, string | undefined>; method: string; url: string }, body: string) => unknown) {
  const requests: Array<{ headers: Record<string, string | undefined>; body: string; method: string; url: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
      const captured = { headers, body, method: request.method ?? 'GET', url: `http://${request.headers.host}${request.url ?? '/'}` }
      requests.push(captured)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload(captured, body)))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture port missing')
  return { url: `http://127.0.0.1:${address.port}/search`, requests }
}
