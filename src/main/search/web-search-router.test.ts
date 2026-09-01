import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { WebSearchRepository } from './web-search-repository'
import { WebSearchService } from './web-search-service'
import { WebSearchRouter, buildSearchQuery, deduplicateWebSearchResults, resolveWebSearchDecision, shouldAutoSearch } from './web-search-router'
import type { WebSearchProviderAdapter } from './web-search-adapters'

function setup(adapter?: WebSearchProviderAdapter) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const repository = new WebSearchRepository(database, new MemorySecretStore())
  const provider = repository.addProvider('KEENABLE').providers[0]!
  repository.updateSettings({ mode: 'AUTO' })
  const service = new WebSearchService(repository, adapter ? [adapter] : [])
  return { database, repository, provider, router: new WebSearchRouter(repository, service) }
}

describe('WebSearchRouter', () => {
  it('keeps AUTO conservative and FORCE request-scoped', () => {
    expect(shouldAutoSearch('解释一下 electric current 是什么')).toBe(false)
    expect(shouldAutoSearch('最近有什么更新？')).toBe(true)
    expect(shouldAutoSearch('current weather in Tokyo')).toBe(true)
    expect(resolveWebSearchDecision('AUTO', '解释这篇文章')).toMatchObject({ status: 'NOT_NEEDED', required: false })
    expect(resolveWebSearchDecision('FORCE', '解释这篇文章')).toMatchObject({ status: 'TRIGGERED', required: true })
    expect(resolveWebSearchDecision('OFF', 'search the web')).toMatchObject({ status: 'NOT_NEEDED' })
  })

  it('freezes the exact query/provider/timeout before I/O and does not persist FORCE', () => {
    const { database, repository, provider, router } = setup()
    try {
      const prepared = router.prepareSearch('FORCE', '后来有什么进展？', 'OrigRead release')
      expect(prepared.plan).toMatchObject({
        mode: 'FORCE',
        query: 'OrigRead release — 后来有什么进展？',
        providerId: provider.id,
        providerName: 'Keenable',
        decision: { status: 'TRIGGERED', required: true }
      })
      expect(prepared.plan.request?.query).toBe(prepared.plan.query)
      expect(prepared.plan.request?.timeoutMs).toBe(12_000)
      expect(repository.current().mode).toBe('AUTO')
    } finally { database.close() }
  })

  it('maps empty/failure results differently for AUTO and FORCE and preserves caller cancellation', async () => {
    const failingAdapter: WebSearchProviderAdapter = {
      kind: 'KEENABLE',
      async search() { throw new Error('fixture down') }
    }
    const { database, router } = setup(failingAdapter)
    try {
      const auto = await router.executePreparedSearch(router.prepareSearch('AUTO', '最新消息是什么？'))
      expect(auto).toMatchObject({ status: 'FAILED_FALLBACK', requiredFailure: false })
      const forced = await router.executePreparedSearch(router.prepareSearch('FORCE', '普通问题'))
      expect(forced).toMatchObject({ status: 'FAILED_REQUIRED', requiredFailure: true })
    } finally { database.close() }
  })

  it('deduplicates tracking-only URL variants without collapsing meaningful query parameters', () => {
    const response = deduplicateWebSearchResults({
      providerId: 'p', providerName: 'P', backendKind: 'RAW_SEARCH', answer: null,
      results: [
        { title: 'A', url: 'https://example.com/post?id=1&utm_source=x#top', snippet: '', publishedAt: null, source: 'example.com', content: null },
        { title: 'A2', url: 'https://example.com/post?id=1&utm_medium=y', snippet: '', publishedAt: null, source: 'example.com', content: null },
        { title: 'B', url: 'https://example.com/post?id=2', snippet: '', publishedAt: null, source: 'example.com', content: null }
      ]
    })
    expect(response.results.map((item) => item.title)).toEqual(['A', 'B'])
    expect(buildSearchQuery('A very long title', 'A very long title latest')).toBe('A very long title latest')
  })
})
