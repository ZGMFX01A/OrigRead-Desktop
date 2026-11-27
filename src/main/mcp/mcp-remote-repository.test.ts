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
    const { database, repository, secrets } = setup()
    try {
      const server = repository.addServer().servers[0]!
      repository.updateServer({ id: server.id, url: 'https://example.com/mcp', enabled: true, authMode: 'BEARER', credential: 'secret-bearer' })
      expect(repository.current().servers[0]).toMatchObject({ authMode: 'BEARER', hasCredential: true, credentialLength: 13 })
      expect(repository.runtimeAuth(server.id)).toEqual({ mode: 'BEARER', bearerToken: 'secret-bearer', headers: {}, oauthScopes: '' })
      const stored = database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.mcp.remote') as { value: string }
      expect(stored.value).not.toContain('secret-bearer')

      repository.updateServer({ id: server.id, authMode: 'CUSTOM_HEADERS', credential: 'X-Api-Key: abc123\nX-Tenant=docs' })
      expect(repository.runtimeAuth(server.id)).toEqual({ mode: 'CUSTOM_HEADERS', bearerToken: null, headers: { 'X-Api-Key': 'abc123', 'X-Tenant': 'docs' }, oauthScopes: '' })
      expect(() => repository.updateServer({ id: server.id, credential: 'MCP-Protocol-Version: nope' })).toThrow('不允许覆盖 MCP 传输 Header')
      expect(repository.runtimeAuth(server.id).headers).toEqual({ 'X-Api-Key': 'abc123', 'X-Tenant': 'docs' })
      // Keep runtime validation covered for credentials restored by older clients.
      secrets.put(`mcp:${server.id}:credential`, 'MCP-Protocol-Version: nope')
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


describe('Remote MCP transport and backup security', () => {
  it.each(['BEARER', 'CUSTOM_HEADERS', 'OAUTH'] as const)('rejects public HTTP with %s including two-step and backup paths', (authMode) => {
    const { database, repository } = setup()
    try {
      const server = repository.addServer().servers[0]!
      expect(() => repository.updateServer({ id: server.id, url: 'http://mcp.example.com/mcp', authMode })).toThrow('HTTPS')
      repository.updateServer({ id: server.id, url: 'http://mcp.example.com/mcp', authMode: 'NONE' })
      expect(() => repository.updateServer({ id: server.id, authMode })).toThrow('HTTPS')
      const backup = repository.exportBackupState()
      backup.servers[0]!.authMode = authMode
      expect(() => repository.validateBackupState(backup)).toThrow('HTTPS')
      expect(() => repository.restoreBackupState(backup)).toThrow('HTTPS')
      database.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(backup), 'llm.mcp.remote')
      expect(repository.current().servers).toEqual([])
    } finally { database.close() }
  })
  it.each(['127.0.0.1', 'localhost', '[::ffff:7f00:1]'])('allows explicitly configured local HTTP %s', (host) => {
    const { database, repository } = setup()
    try {
      const server = repository.addServer().servers[0]!
      expect(repository.updateServer({ id: server.id, url: `http://${host}/mcp`, enabled: true, authMode: 'OAUTH' }).servers[0]!.authMode).toBe('OAUTH')
      expect(repository.requireConfiguredServer(server.id).url).toContain('http:')
    } finally { database.close() }
  })
  it('exports and restores only durable OAuth secrets, clearing old discovery', () => {
    const { database, repository, secrets } = setup()
    try {
      const server = repository.addServer().servers[0]!
      repository.updateServer({ id: server.id, url: 'https://mcp.example.com', authMode: 'OAUTH' })
      const key = repository.oauthSecretKey(server.id, 'discovery')
      secrets.put(key, '{"authorizationServerUrl":"https://auth.example.com"}')
      secrets.put(repository.oauthSecretKey(server.id, 'client'), '{"client_id":"client"}')
      expect(repository.exportBackupSecrets().oauth[server.id]).toEqual({ client: '{"client_id":"client"}' })
      repository.restoreBackupState(repository.exportBackupState(), undefined, { [server.id]: { client: '{"client_id":"restored"}', discovery: '{"authorizationServerUrl":"http://169.254.169.254/latest"}' } })
      expect(secrets.get(key)).toBe('')
      expect(secrets.get(repository.oauthSecretKey(server.id, 'client'))).toContain('restored')
      expect(() => repository.validateBackupState(repository.exportBackupState(), undefined, { [server.id]: { discovery: 123 as unknown as string } })).toThrow('discovery')
    } finally { database.close() }
  })
})


it('validates the full remote edit before touching OAuth and credentials and rolls back failed saves', () => {
  const { database, repository, secrets } = setup()
  try {
    const server = repository.addServer().servers[0]!
    repository.updateServer({ id: server.id, url: 'https://example.com/mcp', authMode: 'BEARER', credential: 'old' })
    secrets.put(`mcp:${server.id}:oauth:tokens`, '{"access_token":"oauth-old"}')
    const snapshot = secrets.snapshot()
    const current = repository.current()
    expect(() => repository.updateServer({ id: server.id, url: 'http://example.com/mcp', credential: 'new' })).toThrow('HTTPS')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(() => repository.updateServer({ id: server.id, authMode: 'CUSTOM_HEADERS', credential: 'invalid-header' })).toThrow()
    expect(secrets.snapshot()).toEqual(snapshot)
    database.exec("CREATE TRIGGER fail_remote BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'settings blocked'); END")
    expect(() => repository.updateServer({ id: server.id, url: 'https://other.example/mcp', credential: 'new' })).toThrow('settings blocked')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.current()).toEqual(current)
  } finally { database.close() }
})

it('rolls back committed settings as well as secrets if rendering the saved result fails', () => {
  const { database, repository, secrets } = setup()
  try {
    const server = repository.addServer().servers[0]!
    repository.updateServer({ id: server.id, url: 'https://example.com/mcp', authMode: 'BEARER', credential: 'old' })
    const current = repository.current()
    const snapshot = secrets.snapshot()
    const get = secrets.get.bind(secrets)
    secrets.get = (key) => {
      const value = get(key)
      if (value === 'new') throw new Error('decrypt failed')
      return value
    }
    expect(() => repository.updateServer({ id: server.id, url: 'https://other.example/mcp', credential: 'new' })).toThrow('decrypt failed')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.current()).toEqual(current)
  } finally { database.close() }
})
