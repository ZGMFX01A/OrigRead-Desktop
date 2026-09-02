import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { McpRemoteRepository } from './mcp-remote-repository'
import { McpToolCatalogService, providerSafeToolName, type McpToolListSource } from './mcp-tool-catalog-service'

function setup(source: McpToolListSource) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const remote = new McpRemoteRepository(database, new MemorySecretStore())
  const server = remote.addServer().servers[0]!
  remote.updateServer({ id: server.id, name: 'Docs', url: 'https://example.com/mcp', enabled: true })
  return { database, remote, serverId: server.id, service: new McpToolCatalogService(database, remote, source) }
}

describe('McpToolCatalogService', () => {
  it('refreshes and persists a normalized catalog with stable source-scoped identities', async () => {
    const source: McpToolListSource = {
      listTools: async () => ({ tools: [
        {
          name: 'read/page',
          title: 'Read page',
          description: 'Read one page',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          outputSchema: { type: 'object' },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
        },
        { name: 'write_page', description: 'Write', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }
      ] })
    }
    const { database, remote, serverId, service } = setup(source)
    try {
      const refreshed = await service.refreshServer(serverId)
      expect(refreshed.servers[0]).toMatchObject({ serverId, serverName: 'Docs', stale: false })
      expect(refreshed.servers[0]!.tools).toHaveLength(2)
      expect(refreshed.servers[0]!.tools[0]).toMatchObject({
        id: `mcp:${serverId}:read/page`, serverId, serverName: 'Docs', rawName: 'read/page', title: 'Read page'
      })
      expect(refreshed.servers[0]!.tools[0]!.providerName).toMatch(/^mcp_[a-f0-9]{8}_read_page$/)
      expect(refreshed.servers[0]!.tools[0]!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })

      const reloaded = new McpToolCatalogService(database, remote, { listTools: async () => { throw new Error('must not be called') } })
      expect(reloaded.current()).toEqual(refreshed)
    } finally { database.close() }
  })

  it('marks cached tools stale without touching the network when server configuration changes', async () => {
    let networkCalls = 0
    const { database, remote, serverId, service } = setup({
      listTools: async () => { networkCalls += 1; return { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } }
    })
    try {
      await service.refreshServer(serverId)
      expect(networkCalls).toBe(1)
      remote.updateServer({ id: serverId, url: 'https://changed.example.com/mcp' })
      expect(service.current().servers[0]).toMatchObject({ serverId, stale: true })
      expect(networkCalls).toBe(1)
    } finally { database.close() }
  })

  it('marks cached tools stale when authentication identity changes without exposing the secret', async () => {
    let networkCalls = 0
    const { database, remote, serverId, service } = setup({
      listTools: async () => { networkCalls += 1; return { tools: [{ name: 'read', inputSchema: { type: 'object' } }] } }
    })
    try {
      remote.updateServer({ id: serverId, authMode: 'BEARER', credential: 'token-a' })
      await service.refreshServer(serverId)
      expect(service.current().servers[0]).toMatchObject({ serverId, stale: false })
      remote.updateServer({ id: serverId, credential: 'token-b' })
      expect(service.current().servers[0]).toMatchObject({ serverId, stale: true })
      expect(networkCalls).toBe(1)
      expect(JSON.stringify(service.current())).not.toContain('token-a')
      expect(JSON.stringify(service.current())).not.toContain('token-b')
    } finally { database.close() }
  })

  it('filters malformed and duplicate tools and deletes catalog entries with their server', async () => {
    const { database, serverId, service } = setup({
      listTools: async () => ({ tools: [
        { name: 'valid', inputSchema: { type: 'object' } },
        { name: 'valid', description: 'duplicate', inputSchema: { type: 'object' } },
        { name: '', inputSchema: { type: 'object' } },
        { name: 'missing-schema' }
      ] })
    })
    try {
      const snapshot = await service.refreshServer(serverId)
      expect(snapshot.servers[0]!.tools.map((tool) => tool.rawName)).toEqual(['valid'])
      expect(service.removeServer(serverId)).toEqual({ servers: [] })
    } finally { database.close() }
  })

  it('generates deterministic provider-safe names that cannot collide across servers', () => {
    expect(providerSafeToolName('server-a', 'read/page')).toBe(providerSafeToolName('server-a', 'read/page'))
    expect(providerSafeToolName('server-a', 'read/page')).not.toBe(providerSafeToolName('server-b', 'read/page'))
    expect(providerSafeToolName('server-a', 'read/page')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
})

