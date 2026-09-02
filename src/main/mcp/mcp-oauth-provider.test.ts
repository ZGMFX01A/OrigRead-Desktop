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

      provider.setInteractiveAllowed(true)
      await provider.redirectToAuthorization(authorizeUrl)
      expect(openExternal).toHaveBeenCalledOnce()
      expect(openExternal).toHaveBeenCalledWith(authorizeUrl.toString())
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
      await provider.state?.()
      const callbackUrl = new URL(provider.redirectUrl!)
      callbackUrl.searchParams.set('code', 'authorization-code')
      callbackUrl.searchParams.set('state', 'attacker-state')
      const response = await fetch(callbackUrl)
      expect(response.status).toBe(200)
      await expect(provider.waitForCallback()).rejects.toThrow('state 校验失败')
    } finally {
      await provider.close()
    }
  })
})

