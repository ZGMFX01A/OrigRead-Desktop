import { describe, expect, it, vi } from 'vitest'
import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { MemorySecretStore } from '../security/secret-store'
import { mcpOAuthSecretKey } from './mcp-remote-repository'
import { createMcpOAuthProviderSession, McpOAuthAuthorizationRequiredError } from './mcp-oauth-provider'

describe('MCP OAuth provider session', () => {
  it('keeps client information, tokens, verifier and state in SecretStore', async () => {
    const secrets = new MemorySecretStore()
    const provider = await createMcpOAuthProviderSession({
      serverId: 'server-1',
      clientName: 'OrigRead Desktop',
      secrets,
      openExternal: async () => {}
    })
    try {
      const client = { client_id: 'client-1' } as StoredOAuthClientInformation
      const tokens = { access_token: 'access-secret', token_type: 'Bearer', refresh_token: 'refresh-secret' } as StoredOAuthTokens
      provider.saveClientInformation?.(client, { issuer: 'https://auth.example.com' })
      provider.saveTokens(tokens, { issuer: 'https://auth.example.com' })
      provider.saveCodeVerifier('pkce-secret')
      const discovery: OAuthDiscoveryState = { authorizationServerUrl: 'https://auth.example.com' }
      provider.saveDiscoveryState?.(discovery)
      const state = await provider.state?.()

      expect(provider.clientInformation({ issuer: 'https://auth.example.com' })).toEqual(client)
      expect(provider.clientInformation({ issuer: 'https://other.example.com' })).toBeUndefined()
      expect(provider.tokens({ issuer: 'https://auth.example.com' })).toEqual(tokens)
      expect(provider.tokens()).toEqual(tokens)
      expect(provider.codeVerifier()).toBe('pkce-secret')
      expect(provider.discoveryState?.()).toEqual(discovery)
      expect(state).toBeTruthy()
      expect(secrets.get(mcpOAuthSecretKey('server-1', 'tokens'))).toContain('access-secret')
      expect(secrets.get(mcpOAuthSecretKey('server-1', 'verifier'))).toBe('pkce-secret')
      expect(secrets.get(mcpOAuthSecretKey('server-1', 'state'))).toBe(state)
      expect(secrets.get(mcpOAuthSecretKey('server-1', 'discovery'))).toContain('auth.example.com')
    } finally {
      await provider.close()
    }
  })

  it('does not open a browser unless the host explicitly enables interactive authorization', async () => {
    const openExternal = vi.fn(async () => {})
    const provider = await createMcpOAuthProviderSession({
      serverId: 'server-2',
      clientName: 'OrigRead Desktop',
      secrets: new MemorySecretStore(),
      openExternal
    })
    try {
      const authorizeUrl = new URL('https://auth.example.com/authorize')
      await expect(provider.redirectToAuthorization(authorizeUrl)).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError)
      expect(openExternal).not.toHaveBeenCalled()

      await provider.setInteractiveAllowed(true)
      await provider.redirectToAuthorization(authorizeUrl)
      expect(openExternal).toHaveBeenCalledOnce()
      expect(openExternal).toHaveBeenCalledWith(authorizeUrl.toString())

      await expect(provider.redirectToAuthorization(new URL('file:///tmp/steal'))).rejects.toThrow('HTTP/HTTPS')
      expect(openExternal).toHaveBeenCalledOnce()
    } finally {
      await provider.close()
    }
  })

  it('validates state before returning callback parameters to finishAuth', async () => {
    const secrets = new MemorySecretStore()
    const provider = await createMcpOAuthProviderSession({
      serverId: 'server-3',
      clientName: 'OrigRead Desktop',
      secrets,
      openExternal: async () => {}
    })
    try {
      await provider.setInteractiveAllowed(true)
      const state = await provider.state?.()
      const callbackUrl = new URL(provider.redirectUrl!)
      callbackUrl.searchParams.set('code', 'authorization-code')
      callbackUrl.searchParams.set('state', String(state))
      const response = await fetch(callbackUrl)
      expect(response.status).toBe(200)

      const params = await provider.waitForCallback()
      expect(params.get('code')).toBe('authorization-code')
      expect(params.get('state')).toBe(state)
      expect(secrets.contains(mcpOAuthSecretKey('server-3', 'state'))).toBe(false)
    } finally {
      await provider.close()
    }
  })

  it('rejects a callback with the wrong state', async () => {
    const provider = await createMcpOAuthProviderSession({
      serverId: 'server-4',
      clientName: 'OrigRead Desktop',
      secrets: new MemorySecretStore(),
      openExternal: async () => {}
    })
    try {
      await provider.setInteractiveAllowed(true)
      const state = await provider.state?.()
      const callbackUrl = new URL(provider.redirectUrl!)
      callbackUrl.searchParams.set('code', 'authorization-code')
      callbackUrl.searchParams.set('state', 'attacker-state')
      const response = await fetch(callbackUrl)
      expect(response.status).toBe(400)
      callbackUrl.searchParams.set('state', String(state))
      expect((await fetch(callbackUrl)).status).toBe(200)
      expect((await provider.waitForCallback()).get('code')).toBe('authorization-code')
    } finally {
      await provider.close()
    }
  })
})


describe('OAuth URL and discovery cache security', () => {
  it.each(['http://auth.example.com/authorize', 'https://169.254.169.254/authorize', 'https://127.0.0.1/authorize', 'https://user:secret@auth.example.com'])('rejects unsafe browser target %s', async (url) => {
    const openExternal = vi.fn(async () => {})
    const provider = await createMcpOAuthProviderSession({ serverId: 'security', clientName: 'test', secrets: new MemorySecretStore(), openExternal })
    try {
      await provider.setInteractiveAllowed(true)
      await expect(provider.redirectToAuthorization(new URL(url))).rejects.toThrow()
      expect(openExternal).not.toHaveBeenCalled()
    } finally { await provider.close() }
  })
  it.each(['http://auth.example.com', 'https://169.254.169.254', 'https://10.0.0.1', 'https://[::ffff:a9fe:a9fe]'])('invalidates poisoned discovery URL %s', async (url) => {
    const secrets = new MemorySecretStore()
    const provider = await createMcpOAuthProviderSession({ serverId: 'security', clientName: 'test', secrets, openExternal: async () => {} })
    try {
      for (const state of [{ authorizationServerUrl: url }, { authorizationServerMetadata: { token_endpoint: url } }]) {
        secrets.put(mcpOAuthSecretKey('security', 'discovery'), JSON.stringify(state))
        expect(provider.discoveryState?.()).toBeUndefined()
        expect(secrets.get(mcpOAuthSecretKey('security', 'discovery'))).toBe('')
      }
      for (const raw of ['broken', '[]', '{"authorizationServerUrl":123}', '{"authorizationServerMetadata":[]}']) {
        secrets.put(mcpOAuthSecretKey('security', 'discovery'), raw)
        expect(provider.discoveryState?.()).toBeUndefined()
        expect(secrets.get(mcpOAuthSecretKey('security', 'discovery'))).toBe('')
      }
    } finally { await provider.close() }
  })
  it('permits loopback OAuth only for a configured loopback server', async () => {
    const openExternal = vi.fn(async () => {})
    const provider = await createMcpOAuthProviderSession({ serverId: 'local', serverUrl: 'http://localhost/mcp', clientName: 'test', secrets: new MemorySecretStore(), openExternal })
    try {
      await provider.setInteractiveAllowed(true)
      await provider.redirectToAuthorization(new URL('http://127.0.0.1/authorize'))
      expect(openExternal).toHaveBeenCalledTimes(1)
      await expect(provider.redirectToAuthorization(new URL('http://10.0.0.1/authorize'))).rejects.toThrow()
      await expect(provider.redirectToAuthorization(new URL('https://169.254.169.254/authorize'))).rejects.toThrow()
    } finally { await provider.close() }
  })
})


it('keeps silent sessions off the loopback network', async () => {
  const provider = await createMcpOAuthProviderSession({ serverId: 'silent', clientName: 'test', secrets: new MemorySecretStore(), openExternal: async () => {} })
  try {
    expect(new URL(provider.redirectUrl!).port).toBe('0')
    await provider.setInteractiveAllowed(false)
    expect(new URL(provider.redirectUrl!).port).toBe('0')
    await provider.setInteractiveAllowed(true)
    expect(new URL(provider.redirectUrl!).port).not.toBe('0')
  } finally { await provider.close() }
})
