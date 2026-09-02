import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { McpRemoteRepository } from './mcp-remote-repository'

function setup(): { database: DatabaseSync; repository: McpRemoteRepository; secrets: MemorySecretStore } {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const secrets = new MemorySecretStore()
  return { database, repository: new McpRemoteRepository(database, secrets), secrets }
}

describe('McpRemoteRepository', () => {
  it('persists normalized Streamable HTTP server profiles without enabling incomplete entries', () => {
    const { database, repository } = setup()
    try {
      expect(repository.current()).toEqual({ servers: [] })
      const created = repository.addServer().servers[0]!
      expect(created).toMatchObject({ name: 'MCP Server 1', url: '', enabled: false, transport: 'STREAMABLE_HTTP', authMode: 'NONE', hasCredential: false, oauthAuthorized: false })

      const updated = repository.updateServer({
        id: created.id,
        name: '  Docs MCP  ',
        url: 'https://mcp.example.com/service#ignored',
        enabled: true
      }).servers[0]!
      expect(updated).toEqual({
        id: created.id,
        name: 'Docs MCP',
        url: 'https://mcp.example.com/service',
        enabled: true,
        transport: 'STREAMABLE_HTTP',
        authMode: 'NONE',
        oauthScopes: '',
        hasCredential: false,
        credentialLength: 0,
        oauthAuthorized: false
      })
      expect(repository.requireConfiguredServer(created.id)).toEqual(updated)
    } finally { database.close() }
  })

  it('rejects non-HTTP transports and disabled/incomplete runtime profiles', () => {
    const { database, repository } = setup()
    try {
      const created = repository.addServer().servers[0]!
      expect(() => repository.updateServer({ id: created.id, url: 'file:///tmp/mcp' })).toThrow('HTTP/HTTPS')
      expect(() => repository.requireConfiguredServer(created.id)).toThrow('已停用')
      repository.updateServer({ id: created.id, enabled: true })
      expect(() => repository.requireConfiguredServer(created.id)).toThrow('尚未配置 URL')
    } finally { database.close() }
  })

  it('drops malformed legacy entries instead of breaking settings startup', () => {
    const { database, repository } = setup()
    try {
      database.prepare('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)').run(
        'llm.mcp.remote',
        JSON.stringify({ servers: [
          { id: 'good', name: 'Good', url: 'https://example.com/mcp', enabled: true, transport: 'STREAMABLE_HTTP' },
          { id: 'bad', name: 'Bad', url: 'javascript:alert(1)', enabled: true },
          { id: 'good', name: 'Duplicate', url: 'https://other.example.com/mcp', enabled: true }
        ] }),
        1
      )
      expect(repository.current().servers).toEqual([{
        id: 'good', name: 'Good', url: 'https://example.com/mcp', enabled: true, transport: 'STREAMABLE_HTTP',
        authMode: 'NONE', oauthScopes: '', hasCredential: false, credentialLength: 0, oauthAuthorized: false
      }])
    } finally { database.close() }
  })

  it('keeps bearer/custom-header credentials out of app_settings and validates runtime headers', () => {
    const { database, repository } = setup()
    try {
      const server = repository.addServer().servers[0]!
      repository.updateServer({ id: server.id, url: 'https://example.com/mcp', enabled: true, authMode: 'BEARER', credential: 'secret-bearer' })
      expect(repository.current().servers[0]).toMatchObject({ authMode: 'BEARER', hasCredential: true, credentialLength: 13 })
      expect(repository.runtimeAuth(server.id)).toEqual({ mode: 'BEARER', bearerToken: 'secret-bearer', headers: {}, oauthScopes: '' })
      const stored = database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.mcp.remote') as { value: string }
      expect(stored.value).not.toContain('secret-bearer')

      repository.updateServer({ id: server.id, authMode: 'CUSTOM_HEADERS', credential: 'X-Api-Key: abc123\nX-Tenant=docs' })
      expect(repository.runtimeAuth(server.id)).toEqual({ mode: 'CUSTOM_HEADERS', bearerToken: null, headers: { 'X-Api-Key': 'abc123', 'X-Tenant': 'docs' }, oauthScopes: '' })
      repository.updateServer({ id: server.id, credential: 'MCP-Protocol-Version: nope' })
      expect(() => repository.runtimeAuth(server.id)).toThrow('不允许覆盖 MCP 传输 Header')
    } finally { database.close() }
  })

  it('does not reuse OAuth authorization after endpoint, auth mode, or requested scope changes', () => {
    const { database, repository, secrets } = setup()
    try {
      const server = repository.addServer().servers[0]!
      repository.updateServer({ id: server.id, url: 'https://example.com/mcp', enabled: true, authMode: 'OAUTH' })
      const tokenKey = repository.oauthSecretKey(server.id, 'tokens')
      const clientKey = repository.oauthSecretKey(server.id, 'client')
      secrets.put(tokenKey, '{"access_token":"a"}')
      secrets.put(clientKey, '{"client_id":"client"}')
      expect(repository.current().servers[0]!.oauthAuthorized).toBe(true)

      repository.updateServer({ id: server.id, oauthScopes: 'tools.read tools.write' })
      expect(repository.current().servers[0]!.oauthAuthorized).toBe(false)
      expect(secrets.contains(clientKey)).toBe(true)

      secrets.put(tokenKey, '{"access_token":"b"}')
      repository.updateServer({ id: server.id, url: 'https://other.example.com/mcp' })
      expect(secrets.contains(tokenKey)).toBe(false)
      expect(secrets.contains(clientKey)).toBe(false)

      secrets.put(tokenKey, '{"access_token":"c"}')
      repository.updateServer({ id: server.id, authMode: 'NONE' })
      expect(secrets.contains(tokenKey)).toBe(false)
    } finally { database.close() }
  })
})

