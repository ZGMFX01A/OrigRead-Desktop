import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client'
import type { SecretStore } from '../security/secret-store'
import { mcpOAuthSecretKey } from './mcp-remote-repository'

const CALLBACK_PATH = '/oauth/mcp/callback'
const CALLBACK_TIMEOUT_MS = 5 * 60_000

export class McpOAuthAuthorizationRequiredError extends Error {
  constructor() {
    super('MCP OAuth 需要先完成浏览器授权')
    this.name = 'McpOAuthAuthorizationRequiredError'
  }
}

export interface McpOAuthProviderSession extends OAuthClientProvider {
  setInteractiveAllowed(value: boolean): void
  wasAuthorizationRedirected(): boolean
  waitForCallback(signal?: AbortSignal): Promise<URLSearchParams>
  close(): Promise<void>
}

export async function createMcpOAuthProviderSession(options: {
  serverId: string
  clientName: string
  secrets: SecretStore
  openExternal: (url: string) => Promise<void>
}): Promise<McpOAuthProviderSession> {
  const listener = await createLoopbackListener(options.serverId)
  return new ElectronMcpOAuthProvider({ ...options, ...listener })
}

interface LoopbackListener {
  server: Server
  redirectUrl: URL
  callback: Promise<URLSearchParams>
  rejectCallback(error: Error): void
}

class ElectronMcpOAuthProvider implements McpOAuthProviderSession {
  private interactiveAllowed = false
  private authorizationRedirected = false
  private callbackConsumed = false

  constructor(private readonly options: {
    serverId: string
    clientName: string
    secrets: SecretStore
    openExternal: (url: string) => Promise<void>
    server: Server
    redirectUrl: URL
    callback: Promise<URLSearchParams>
    rejectCallback(error: Error): void
  }) {}

  get redirectUrl(): URL { return this.options.redirectUrl }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    const value = randomBytes(32).toString('base64url')
    this.putRaw('state', value)
    return value
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    return this.readEnvelope<StoredOAuthClientInformation>('client', ctx?.issuer)
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    this.writeEnvelope('client', clientInformation, ctx?.issuer)
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.readEnvelope<StoredOAuthTokens>('tokens', ctx?.issuer)
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    this.writeEnvelope('tokens', tokens, ctx?.issuer)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactiveAllowed) throw new McpOAuthAuthorizationRequiredError()
    if (authorizationUrl.protocol !== 'http:' && authorizationUrl.protocol !== 'https:') {
      throw new Error('MCP OAuth 授权地址必须使用 HTTP/HTTPS')
    }
    await this.options.openExternal(authorizationUrl.toString())
    this.authorizationRedirected = true
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.putRaw('verifier', codeVerifier)
  }

  codeVerifier(): string {
    const verifier = this.options.secrets.get(mcpOAuthSecretKey(this.options.serverId, 'verifier'))
    if (!verifier) throw new Error('MCP OAuth PKCE verifier 已丢失，请重新授权')
    return verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.options.secrets.put(mcpOAuthSecretKey(this.options.serverId, 'discovery'), JSON.stringify(state))
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const raw = this.options.secrets.get(mcpOAuthSecretKey(this.options.serverId, 'discovery'))
    if (!raw) return undefined
    try { return JSON.parse(raw) as OAuthDiscoveryState } catch { return undefined }
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      for (const kind of ['client', 'tokens', 'verifier', 'state', 'discovery'] as const) this.options.secrets.delete(mcpOAuthSecretKey(this.options.serverId, kind))
      return
    }
    this.options.secrets.delete(mcpOAuthSecretKey(this.options.serverId, scope))
  }

  setInteractiveAllowed(value: boolean): void {
    this.interactiveAllowed = value
  }

  wasAuthorizationRedirected(): boolean {
    return this.authorizationRedirected
  }

  async waitForCallback(signal?: AbortSignal): Promise<URLSearchParams> {
    if (this.callbackConsumed) throw new Error('MCP OAuth 回调已处理')
    this.callbackConsumed = true
    const timeout = AbortSignal.timeout(CALLBACK_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const params = await Promise.race([
      this.options.callback,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(combined.reason instanceof Error ? combined.reason : new DOMException('OAuth callback cancelled', 'AbortError'))
        if (combined.aborted) abort()
        else combined.addEventListener('abort', abort, { once: true })
      })
    ])
    const expectedState = this.options.secrets.get(mcpOAuthSecretKey(this.options.serverId, 'state'))
    const actualState = params.get('state') || ''
    if (!expectedState || actualState !== expectedState) throw new Error('MCP OAuth state 校验失败，请重新授权')
    this.options.secrets.delete(mcpOAuthSecretKey(this.options.serverId, 'state'))
    return params
  }

  async close(): Promise<void> {
    this.options.rejectCallback(new DOMException('OAuth session closed', 'AbortError'))
    await new Promise<void>((resolve) => {
      if (!this.options.server.listening) { resolve(); return }
      this.options.server.close(() => resolve())
    })
  }

  private putRaw(kind: 'verifier' | 'state', value: string): void {
    this.options.secrets.put(mcpOAuthSecretKey(this.options.serverId, kind), value)
  }

  private readEnvelope<T>(kind: 'client' | 'tokens', issuer?: string): T | undefined {
    const raw = this.options.secrets.get(mcpOAuthSecretKey(this.options.serverId, kind))
    if (!raw) return undefined
    try {
      const envelope = JSON.parse(raw) as { issuer?: unknown; value?: unknown }
      if (!envelope || typeof envelope !== 'object' || envelope.value == null) return undefined
      if (issuer && typeof envelope.issuer === 'string' && envelope.issuer !== issuer) return undefined
      return envelope.value as T
    } catch { return undefined }
  }

  private writeEnvelope(kind: 'client' | 'tokens', value: unknown, issuer?: string): void {
    this.options.secrets.put(mcpOAuthSecretKey(this.options.serverId, kind), JSON.stringify({ issuer: issuer || null, value }))
  }
}

async function createLoopbackListener(serverId: string): Promise<LoopbackListener> {
  let resolveCallback!: (params: URLSearchParams) => void
  let rejectCallback!: (error: Error) => void
  let settled = false
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // A session can be closed before any caller starts waiting for the browser callback.
  // Mark the promise as observed so teardown never creates an unhandled rejection;
  // waitForCallback still awaits the original promise and receives the same error.
  void callback.catch(() => undefined)
  const finishReject = (error: Error): void => {
    if (settled) return
    settled = true
    rejectCallback(error)
  }
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' || !request.url) {
        response.writeHead(405).end()
        return
      }
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('OAuth loopback address missing')
      const url = new URL(request.url, `http://127.0.0.1:${address.port}`)
      if (url.pathname !== CALLBACK_PATH || url.searchParams.get('server') !== serverId) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>OrigRead</title><p>Authorization response received. You can close this window and return to OrigRead.</p>')
      if (!settled) {
        settled = true
        resolveCallback(new URLSearchParams(url.searchParams))
      }
    } catch (error) {
      response.writeHead(500).end()
      finishReject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP OAuth loopback port missing')
  const redirectUrl = new URL(`http://127.0.0.1:${address.port}${CALLBACK_PATH}`)
  redirectUrl.searchParams.set('server', serverId)
  return { server, redirectUrl, callback, rejectCallback: finishReject }
}

