import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { createMcpOAuthProviderSession } from './mcp-oauth-provider'
import { McpRemoteClientManager, createSdkMcpRemoteConnectorFactory } from './mcp-remote-client-manager'
import { McpRemoteRepository } from './mcp-remote-repository'

const servers: import('node:http').Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('Remote MCP OAuth integration', () => {
  it('completes discovery + PKCE authorization and silently refreshes after a later 401', async () => {
    const fixture = await startOAuthMcpFixture()
    const database = new DatabaseSync(':memory:')
    database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
    const secrets = new MemorySecretStore()
    const repository = new McpRemoteRepository(database, secrets)
    const server = repository.addServer().servers[0]!
    repository.updateServer({ id: server.id, url: fixture.mcpUrl, enabled: true, authMode: 'OAUTH' })
    const openedAuthorizationUrls: string[] = []
    const manager = new McpRemoteClientManager(
      repository,
      createSdkMcpRemoteConnectorFactory(
        'OrigRead Test',
        '1.0.0',
        (profile) => repository.runtimeAuth(profile.id),
        (profile) => createMcpOAuthProviderSession({
          serverId: profile.id,
          clientName: 'OrigRead Test',
          secrets,
          openExternal: async (authorizationUrl) => {
            openedAuthorizationUrls.push(authorizationUrl)
            await fixture.completeAuthorization(authorizationUrl)
          }
        })
      )
    )

    try {
      const authorized = await manager.authorize(server.id)
      expect(authorized).toMatchObject({ status: 'CONNECTED', protocolEra: 'LEGACY', protocolVersion: '2025-11-25' })
      expect(openedAuthorizationUrls).toHaveLength(1)
      expect(repository.current().servers[0]!.oauthAuthorized).toBe(true)
      expect(fixture.authorizationCodeExchanges).toBe(1)
      expect(fixture.lastCodeVerifierChallenge).toBe(fixture.lastAuthorizationChallenge)
      expect(await manager.listTools(server.id)).toEqual({ tools: expect.arrayContaining([expect.objectContaining({ name: 'read_article' })]) })

      fixture.requireAccessToken('access-2')
      const refreshedTools = await manager.listTools(server.id)
      expect(refreshedTools.tools).toHaveLength(1)
      expect(fixture.refreshExchanges).toBe(1)
      expect(openedAuthorizationUrls).toHaveLength(1)
      expect(fixture.seenAuthorizationHeaders).toContain('Bearer access-2')

      const persistedSettings = database.prepare('SELECT value FROM app_settings WHERE key=?').get('llm.mcp.remote') as { value: string }
      expect(persistedSettings.value).not.toContain('access-1')
      expect(persistedSettings.value).not.toContain('refresh-1')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })
})

async function startOAuthMcpFixture(): Promise<{
  mcpUrl: string
  completeAuthorization(url: string): Promise<void>
  requireAccessToken(token: string): void
  readonly authorizationCodeExchanges: number
  readonly refreshExchanges: number
  readonly lastAuthorizationChallenge: string
  readonly lastCodeVerifierChallenge: string
  readonly seenAuthorizationHeaders: string[]
}> {
  let origin = ''
  let requiredAccessToken = 'access-1'
  let authorizationChallenge = ''
  let verifierChallenge = ''
  let authorizationCodeExchanges = 0
  let refreshExchanges = 0
  const seenAuthorizationHeaders: string[] = []

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        respondJson(response, { resource: `${origin}/mcp`, authorization_servers: [origin] })
        return
      }
      if (request.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
        respondJson(response, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none']
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse(await readBody(request)) as { redirect_uris?: string[] }
        respondJson(response, {
          client_id: 'origread-test-client',
          redirect_uris: body.redirect_uris ?? [],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }, 201)
        return
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(request))
        if (form.get('grant_type') === 'authorization_code') {
          authorizationCodeExchanges += 1
          verifierChallenge = sha256Base64Url(form.get('code_verifier') ?? '')
          respondJson(response, { access_token: 'access-1', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
          return
        }
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
          refreshExchanges += 1
          respondJson(response, { access_token: 'access-2', token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 })
          return
        }
        respondJson(response, { error: 'invalid_grant' }, 400)
        return
      }
      if (url.pathname === '/mcp') {
        const authorization = request.headers.authorization ?? ''
        seenAuthorizationHeaders.push(authorization)
        if (authorization !== `Bearer ${requiredAccessToken}`) {
          response.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
          })
          response.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        if (request.method === 'GET') {
          response.writeHead(405).end()
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(202).end()
          return
        }
        const message = JSON.parse(await readBody(request)) as { id?: string | number; method?: string }
        if (message.method === 'server/discover') {
          respondJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        if (message.method === 'initialize') {
          respondJson(response, {
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'oauth-fixture', version: '1.0.0' } }
          })
          return
        }
        if (message.method === 'tools/list') {
          respondJson(response, { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'read_article', inputSchema: { type: 'object' } }] } })
          return
        }
        response.writeHead(202).end()
        return
      }
      response.writeHead(404).end()
    } catch (error) {
      respondJson(response, { error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OAuth MCP fixture port missing')
  origin = `http://127.0.0.1:${address.port}`

  return {
    mcpUrl: `${origin}/mcp`,
    async completeAuthorization(authorizationUrl: string) {
      const url = new URL(authorizationUrl)
      authorizationChallenge = url.searchParams.get('code_challenge') ?? ''
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      const redirectUri = url.searchParams.get('redirect_uri')
      if (!redirectUri) throw new Error('OAuth authorization URL missing redirect_uri')
      const callback = new URL(redirectUri)
      callback.searchParams.set('code', 'fixture-authorization-code')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      callback.searchParams.set('iss', origin)
      const response = await fetch(callback)
      if (!response.ok) throw new Error(`Loopback callback failed: ${response.status}`)
    },
    requireAccessToken(token: string) { requiredAccessToken = token },
    get authorizationCodeExchanges() { return authorizationCodeExchanges },
    get refreshExchanges() { return refreshExchanges },
    get lastAuthorizationChallenge() { return authorizationChallenge },
    get lastCodeVerifierChallenge() { return verifierChallenge },
    seenAuthorizationHeaders
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function respondJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}
