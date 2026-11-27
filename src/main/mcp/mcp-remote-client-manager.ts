import { safeFetch, isLoopbackHost, type DnsLookupFn } from '../network/safe-fetch'
import { performance } from 'node:perf_hooks'
import { Client, StreamableHTTPClientTransport, extractWWWAuthenticateParams, auth, UnauthorizedError, type AuthProvider, type OAuthClientProvider } from '@modelcontextprotocol/client'
import type {
  McpConnectionSnapshot,
  McpRemoteAuthMode,
  McpProtocolEra,
  McpRemoteRuntimeAuth,
  McpRemoteServerHealthResult,
  McpRemoteServerProfile,
  McpServerIdentity
} from '../../shared/mcp'
import type { McpOAuthProviderSession } from './mcp-oauth-provider'
import type { McpRemoteRepository } from './mcp-remote-repository'
import { redactErrorForBoundary, redactSensitiveText } from '../security/sensitive-text'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const HEALTH_REQUEST_TIMEOUT_MS = 10_000

interface McpRemoteConnectorInfo {
  protocolEra: McpProtocolEra
  protocolVersion: string | null
  serverInfo: McpServerIdentity | null
}

export interface McpRemoteConnector {
  connect(): Promise<McpRemoteConnectorInfo>
  authorize?(signal?: AbortSignal): Promise<McpRemoteConnectorInfo>
  listTools(signal?: AbortSignal): Promise<{ tools: unknown[] }>
  callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export type McpRemoteConnectorFactory = (server: McpRemoteServerProfile, options: { requestTimeoutMs: number }) => McpRemoteConnector

interface ActiveConnection {
  fingerprint: string
  connector: McpRemoteConnector
  snapshot: McpConnectionSnapshot
}

interface PendingRemoteConnection {
  generation: number
  fingerprint: string
  connector: McpRemoteConnector
  promise: Promise<McpConnectionSnapshot>
}

export class McpRemoteClientManager {
  private readonly active = new Map<string, ActiveConnection>()
  private readonly pending = new Map<string, PendingRemoteConnection>()
  private readonly generations = new Map<string, number>()
  private readonly pendingAuthorizations = new Map<string, { generation: number; connector: McpRemoteConnector; controller: AbortController }>()
  private readonly states = new Map<string, McpConnectionSnapshot>()

  private nextGeneration(serverId: string): number {
    const next = (this.generations.get(serverId) ?? 0) + 1
    this.generations.set(serverId, next)
    return next
  }

  private currentGeneration(serverId: string): number {
    return this.generations.get(serverId) ?? 0
  }

  constructor(
    private readonly repository: McpRemoteRepository,
    private readonly connectorFactory: McpRemoteConnectorFactory
  ) {}

  state(serverId: string): McpConnectionSnapshot {
    const id = serverId.trim()
    return this.states.get(id) ?? disconnectedState(id)
  }

  statesSnapshot(): McpConnectionSnapshot[] {
    return this.repository.current().servers.map((server) => this.state(server.id))
  }

  async connect(serverId: string): Promise<McpConnectionSnapshot> {
    const server = this.repository.requireConfiguredServer(serverId)
    const fingerprint = serverFingerprint(server)
    const existing = this.active.get(server.id)
    if (existing?.fingerprint === fingerprint && existing.snapshot.status === 'CONNECTED') {
      return existing.snapshot
    }

    const ongoing = this.pending.get(server.id)
    if (ongoing && ongoing.fingerprint === fingerprint) {
      return ongoing.promise
    }

    const oldExisting = existing
    const oldOngoing = ongoing
    const oldPendingAuth = this.pendingAuthorizations.get(server.id)
    if (oldExisting) {
      this.active.delete(server.id)
    }
    if (oldOngoing) {
      this.pending.delete(server.id)
    }
    if (oldPendingAuth) {
      this.pendingAuthorizations.delete(server.id)
      oldPendingAuth.controller.abort(new DOMException('MCP OAuth authorization superseded', 'AbortError'))
    }

    const gen = this.nextGeneration(server.id)
    this.setState({ ...disconnectedState(server.id), status: 'CONNECTING', updatedAt: Date.now() })
    const connector = this.connectorFactory(server, { requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS })

    const connectionPromise = (async () => {
      try {
        if (oldExisting) {
          await safeClose(oldExisting.connector)
        }
        if (oldOngoing) {
          await safeClose(oldOngoing.connector)
        }
        if (oldPendingAuth) {
          await safeClose(oldPendingAuth.connector)
        }
        if (this.currentGeneration(server.id) !== gen) {
          return this.state(server.id)
        }
        const info = await connector.connect()
        if (this.currentGeneration(server.id) !== gen) {
          await safeClose(connector)
          return this.state(server.id)
        }
        const snapshot = connectedState(server.id, info)
        this.active.set(server.id, { fingerprint, connector, snapshot })
        this.setState(snapshot)
        return snapshot
      } catch (error) {
        await safeClose(connector)
        if (this.currentGeneration(server.id) === gen) {
          this.setErrorState(server.id, error)
          throw redactErrorForBoundary(error)
        }
        return this.state(server.id)
      } finally {
        const cur = this.pending.get(server.id)
        if (cur?.generation === gen) {
          this.pending.delete(server.id)
        }
      }
    })()

    this.pending.set(server.id, {
      generation: gen,
      fingerprint,
      connector,
      promise: connectionPromise
    })

    return connectionPromise
  }

  async authorize(serverId: string, signal?: AbortSignal): Promise<McpConnectionSnapshot> {
    const server = this.repository.requireConfiguredServer(serverId)
    if (server.authMode !== 'OAUTH') throw new Error(`Remote MCP Server 未启用 OAuth：${server.name}`)
    const oldExisting = this.active.get(server.id)
    const oldPending = this.pending.get(server.id)
    const oldPendingAuth = this.pendingAuthorizations.get(server.id)
    if (oldExisting) this.active.delete(server.id)
    if (oldPending) this.pending.delete(server.id)
    if (oldPendingAuth) {
      this.pendingAuthorizations.delete(server.id)
      oldPendingAuth.controller.abort(new DOMException('MCP OAuth authorization superseded', 'AbortError'))
    }

    this.repository.clearOAuthAuthorization(server.id)
    const gen = this.nextGeneration(server.id)
    this.setState({ ...disconnectedState(server.id), status: 'CONNECTING', updatedAt: Date.now() })
    const refreshedServer = this.repository.requireConfiguredServer(server.id)
    const connector = this.connectorFactory(refreshedServer, { requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS })
    if (!connector.authorize) throw new Error('当前 MCP Client 不支持 OAuth 授权')
    const controller = new AbortController()
    const authorizationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    this.pendingAuthorizations.set(server.id, { generation: gen, connector, controller })

    try {
      if (oldExisting) await safeClose(oldExisting.connector)
      if (oldPending) await safeClose(oldPending.connector)
      if (oldPendingAuth) await safeClose(oldPendingAuth.connector)
      if (this.currentGeneration(server.id) !== gen) {
        await safeClose(connector)
        return this.state(server.id)
      }
      const info = await connector.authorize(authorizationSignal)
      if (this.currentGeneration(server.id) !== gen) {
        await safeClose(connector)
        return this.state(server.id)
      }
      const snapshot = connectedState(server.id, info)
      const currentServer = this.repository.requireConfiguredServer(server.id)
      this.active.set(server.id, { fingerprint: serverFingerprint(currentServer), connector, snapshot })
      this.setState(snapshot)
      return snapshot
    } catch (error) {
      await safeClose(connector)
      if (this.currentGeneration(server.id) === gen) {
        this.setErrorState(server.id, error)
        throw redactErrorForBoundary(error)
      }
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('cancelled') || error.message.includes('aborted'))) {
        throw error
      }
      return this.state(server.id)
    } finally {
      const pending = this.pendingAuthorizations.get(server.id)
      if (pending?.generation === gen) this.pendingAuthorizations.delete(server.id)
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const id = serverId.trim()
    const gen = this.nextGeneration(id)
    const pendingAuth = this.pendingAuthorizations.get(id)
    this.pendingAuthorizations.delete(id)
    if (pendingAuth) {
      pendingAuth.controller.abort(new DOMException('MCP OAuth authorization cancelled', 'AbortError'))
    }
    const pendingConn = this.pending.get(id)
    this.pending.delete(id)
    const existing = this.active.get(id)
    this.active.delete(id)

    await Promise.allSettled([
      existing ? safeClose(existing.connector) : Promise.resolve(),
      pendingConn ? safeClose(pendingConn.connector) : Promise.resolve(),
      pendingAuth ? safeClose(pendingAuth.connector) : Promise.resolve()
    ])
    if (this.currentGeneration(id) === gen) {
      this.setState(disconnectedState(id))
    }
  }

  async disconnectAll(): Promise<void> {
    const ids = [
      ...new Set([
        ...this.active.keys(),
        ...this.pending.keys(),
        ...this.pendingAuthorizations.keys(),
        ...this.repository.current().servers.map((s) => s.id)
      ])
    ]
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
  }

  async invalidate(serverId: string): Promise<void> {
    await this.disconnect(serverId)
  }

  async listTools(serverId: string, signal?: AbortSignal): Promise<{ tools: unknown[] }> {
    const connection = await this.ensureConnection(serverId)
    try {
      return await connection.connector.listTools(signal)
    } catch (error) {
      if (!signal?.aborted) await this.markConnectionError(serverId, connection.connector, error)
      throw redactErrorForBoundary(error)
    }
  }

  async callTool(
    serverId: string,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const connection = await this.ensureConnection(serverId)
    try {
      return await connection.connector.callTool(name, argumentsValue, signal)
    } catch (error) {
      if (!signal?.aborted) await this.markConnectionError(serverId, connection.connector, error)
      throw redactErrorForBoundary(error)
    }
  }

  async checkHealth(serverId: string): Promise<McpRemoteServerHealthResult> {
    const server = this.repository.requireConfiguredServer(serverId)
    const connector = this.connectorFactory(server, { requestTimeoutMs: HEALTH_REQUEST_TIMEOUT_MS })
    const startedAt = performance.now()
    try {
      const info = await connector.connect()
      const result = await connector.listTools(AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS))
      return {
        serverId: server.id,
        serverName: server.name,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        protocolEra: info.protocolEra,
        protocolVersion: info.protocolVersion,
        serverInfo: info.serverInfo,
        toolCount: result.tools.length
      }
    } catch (error) {
      throw redactErrorForBoundary(error)
    } finally {
      await safeClose(connector)
    }
  }

  private async ensureConnection(serverId: string): Promise<ActiveConnection> {
    const server = this.repository.requireConfiguredServer(serverId)
    const existing = this.active.get(server.id)
    if (existing?.fingerprint === serverFingerprint(server) && existing.snapshot.status === 'CONNECTED') return existing
    await this.connect(server.id)
    const connected = this.active.get(server.id)
    if (!connected) throw new Error(`Remote MCP 连接建立失败：${server.name}`)
    return connected
  }

  private async markConnectionError(serverId: string, targetConnector: McpRemoteConnector, error: unknown): Promise<void> {
    if (!isConnectionFailure(error)) return
    const id = serverId.trim()
    const existing = this.active.get(id)
    if (existing?.connector === targetConnector) {
      const errorGen = this.nextGeneration(id)
      this.active.delete(id)
      await safeClose(existing.connector)
      if (this.currentGeneration(id) === errorGen && !this.active.has(id)) {
        this.setErrorState(id, error)
      }
    }
  }

  private setErrorState(serverId: string, error: unknown): void {
    this.setState({
      ...disconnectedState(serverId),
      status: 'ERROR',
      errorMessage: errorMessage(error),
      updatedAt: Date.now()
    })
  }

  private setState(snapshot: McpConnectionSnapshot): void {
    this.states.set(snapshot.serverId, snapshot)
  }
}

export function createSdkMcpRemoteConnectorFactory(
  clientName: string,
  clientVersion: string,
  resolveAuth: (server: McpRemoteServerProfile) => McpRemoteRuntimeAuth = () => ({ mode: 'NONE', bearerToken: null, headers: {}, oauthScopes: '' }),
  createOAuthProvider?: (server: McpRemoteServerProfile) => Promise<McpOAuthProviderSession>
): McpRemoteConnectorFactory {
  const refreshes = new Map<string, Promise<void>>()
  const normalizedClientName = clientName.trim() || 'OrigRead Desktop'
  const normalizedClientVersion = clientVersion.trim() || '0.0.0'
  return (server, options) => {
    let client: Client | null = null
    let transport: StreamableHTTPClientTransport | null = null
    let oauthProvider: McpOAuthProviderSession | null = null

    const closeCurrent = async (): Promise<void> => {
      const closingClient = client
      const closingProvider = oauthProvider
      client = null
      transport = null
      oauthProvider = null
      if (closingClient) {
        try { await closingClient.close() } catch { /* teardown should not mask the primary failure */ }
      }
      if (closingProvider) {
        try { await closingProvider.close() } catch { /* loopback teardown should be best-effort */ }
      }
    }

    const openConnection = async (interactiveOAuth: boolean): Promise<McpRemoteConnectorInfo> => {
      await closeCurrent()
      const auth = resolveAuth(server)
      let provider: McpOAuthProviderSession | null = null
      if (auth.mode === 'OAUTH') {
        if (!createOAuthProvider) throw new Error('当前 MCP Client 未配置 OAuth Provider')
        provider = await createOAuthProvider(server)
        await provider.setInteractiveAllowed(interactiveOAuth)
      }

      const nextClient = new Client(
        { name: normalizedClientName, version: normalizedClientVersion },
        { versionNegotiation: { mode: 'auto' }, listMaxPages: 64 }
      )
      const rejectedTokens = new WeakMap<Response, string | undefined>()
      const remoteFetch = createMcpRemoteFetch(server.url, { timeoutMs: options.requestTimeoutMs, authMode: auth.mode, customHeaderNames: Object.keys(auth.headers) })
      const fetchWithAuthContext: typeof fetch = async (input, init) => {
        const response = await remoteFetch(input, init)
        if (response.status === 401) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          rejectedTokens.set(response, headers.get('authorization')?.replace(/^Bearer /i, ''))
        }
        return response
      }
      const nextTransport = new StreamableHTTPClientTransport(new URL(server.url), {
        ...(auth.mode === 'BEARER' && auth.bearerToken ? { authProvider: { token: async () => auth.bearerToken ?? undefined } } : {}),
        ...(auth.mode === 'CUSTOM_HEADERS' ? { requestInit: { headers: auth.headers } } : {}),
        ...(auth.mode === 'OAUTH' && provider ? { authProvider: singleFlightOAuthProvider(server.id, provider, auth.oauthScopes, refreshes, rejectedTokens) } : {}),
        fetch: fetchWithAuthContext,
        onInsufficientScope: 'throw'
      })
      client = nextClient
      transport = nextTransport
      oauthProvider = provider

      try {
        await nextClient.connect(nextTransport)
        // A normal connected session never needs to keep the loopback port open.
        // The provider remains usable for silent token refresh; an interactive re-auth
        // always creates a fresh loopback listener through authorize().
        if (provider) await provider.close()
        return connectorInfo(nextClient)
      } catch (error) {
        if (!(interactiveOAuth && provider?.wasAuthorizationRedirected())) await closeCurrent()
        throw error
      }
    }

    return {
      connect: () => openConnection(false),
      async authorize(signal) {
        if (resolveAuth(server).mode !== 'OAUTH') throw new Error(`Remote MCP Server 未启用 OAuth：${server.name}`)
        try {
          return await openConnection(true)
        } catch (initialError) {
          const provider = oauthProvider
          const authTransport = transport
          if (!provider?.wasAuthorizationRedirected() || !authTransport) throw initialError
          try {
            const callbackParams = await provider.waitForCallback(signal)
            const code = callbackParams.get('code')
            if (!code) throw new Error(`MCP OAuth 授权失败：${callbackParams.get('error') ?? 'missing code'}`)
            const runtimeAuth = resolveAuth(server)
            const result = await auth(provider, {
              serverUrl: server.url, authorizationCode: code, iss: callbackParams.get('iss') ?? undefined,
              scope: runtimeAuth.oauthScopes.trim() || undefined,
              fetchFn: createMcpRemoteFetch(server.url, { timeoutMs: options.requestTimeoutMs, authMode: 'OAUTH' })
            })
            if (result !== 'AUTHORIZED') throw new UnauthorizedError('MCP OAuth authorization failed')
          } catch (error) {
            await closeCurrent()
            throw error
          }
          await closeCurrent()
          return openConnection(false)
        }
      },
      async listTools(signal) {
        if (!client) throw new Error('Remote MCP 尚未连接')
        const result = await client.listTools(undefined, signal ? { requestSignal: signal } : undefined)
        return { tools: result.tools }
      },
      async callTool(name, argumentsValue, signal) {
        if (!client) throw new Error('Remote MCP 尚未连接')
        return client.callTool(
          { name, arguments: argumentsValue },
          signal ? { requestSignal: signal } : undefined
        )
      },
      close: closeCurrent
    }
  }
}

function connectorInfo(client: Client): McpRemoteConnectorInfo {
  const era = client.getProtocolEra()
  if (era !== 'modern' && era !== 'legacy') throw new Error('MCP Server 未返回可识别的协议版本')
  return {
    protocolEra: era === 'modern' ? 'MODERN' : 'LEGACY',
    protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    serverInfo: normalizeServerInfo(client.getServerVersion())
  }
}

export function createMcpRemoteFetch(serverUrl: string, options: {
  timeoutMs: number
  authMode: McpRemoteAuthMode
  customHeaderNames?: readonly string[]
  fetchImpl?: typeof fetch
  lookup?: DnsLookupFn
}): typeof fetch {
  const serverParsed = new URL(serverUrl)
  const serverOrigin = serverParsed.origin
  const serverIsLoopback = isLoopbackHost(serverParsed.hostname)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(Math.floor(options.timeoutMs), 2_147_483_647) : DEFAULT_REQUEST_TIMEOUT_MS
  return async (input, init) => {
    const targetUrl = new URL(input instanceof Request ? input.url : String(input))
    const sameOrigin = targetUrl.origin === serverOrigin
    const localTest = serverIsLoopback && isLoopbackHost(targetUrl.hostname)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(new DOMException('MCP response headers timed out', 'TimeoutError')), timeoutMs)
    const timeoutSignal = timeoutController.signal
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal
    try {
      return await safeFetch(input, { ...init, signal }, {
        fetchImpl: options.fetchImpl,
        lookup: options.lookup,
        allowLoopbackHttp: localTest,
        requireHttps: sameOrigin ? !serverIsLoopback && options.authMode !== 'NONE' : !localTest,
        blockPrivateNetwork: true,
        sensitiveHeaderNames: ['authorization', ...(options.customHeaderNames ?? [])]
      })
    } finally { clearTimeout(timer) }
  }
}

function normalizeServerInfo(value: ReturnType<Client['getServerVersion']>): McpServerIdentity | null {
  if (!value) return null
  return {
    name: value.name,
    version: value.version,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : null
  }
}

function connectedState(serverId: string, info: McpRemoteConnectorInfo): McpConnectionSnapshot {
  return {
    serverId,
    status: 'CONNECTED',
    protocolEra: info.protocolEra,
    protocolVersion: info.protocolVersion,
    serverInfo: info.serverInfo,
    errorMessage: null,
    updatedAt: Date.now()
  }
}

function disconnectedState(serverId: string): McpConnectionSnapshot {
  return {
    serverId,
    status: 'DISCONNECTED',
    protocolEra: null,
    protocolVersion: null,
    serverInfo: null,
    errorMessage: null,
    updatedAt: Date.now()
  }
}

function serverFingerprint(server: McpRemoteServerProfile): string {
  return JSON.stringify([
    server.transport,
    server.url,
    server.enabled,
    server.authMode,
    server.oauthScopes,
    server.hasCredential,
    server.credentialLength,
    server.oauthAuthorized
  ])
}

async function safeClose(connector: McpRemoteConnector): Promise<void> {
  try { await connector.close() } catch { /* connection teardown must not mask the primary failure */ }
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error))
}


function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false
  const detail = error as Error & { code?: string | number; status?: number }
  return detail.status === 401 || detail.code === 401 || error instanceof UnauthorizedError || error.name === 'McpOAuthAuthorizationRequiredError'
    || ['NOT_CONNECTED', 'CONNECTION_CLOSED', 'CLIENT_HTTP_AUTHENTICATION', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(detail.code))
    || /connection (closed|lost)|not connected|transport.*(closed|disconnected)/i.test(error.message)
    || (error.cause !== undefined && isConnectionFailure(error.cause))
}

/** Share refresh through persistence, so a rotating token is consumed only once per server. */
export function singleFlightOAuthProvider(serverId: string, provider: OAuthClientProvider, scopes: string, flights: Map<string, Promise<void>>, rejectedTokens?: WeakMap<Response, string | undefined>): AuthProvider {
  const adapted: AuthProvider = {
    token: async () => (await provider.tokens())?.access_token,
    async onUnauthorized(ctx) {
      const challenge = extractWWWAuthenticateParams(ctx.response)
      if (await auth(provider, { serverUrl: ctx.serverUrl, resourceMetadataUrl: challenge.resourceMetadataUrl,
        scope: scopes.trim() || challenge.scope, fetchFn: ctx.fetchFn }) !== 'AUTHORIZED') throw new UnauthorizedError()
    }
  }
  // Remember the token used by this provider. A delayed 401 after a completed
  // refresh should retry the new token rather than rotate it a second time.
  let lastToken: string | undefined
  return {
    async token() { lastToken = await adapted.token(); return lastToken },
    async onUnauthorized(ctx) {
      const pending = flights.get(serverId)
      if (pending) return pending
      const current = await adapted.token()
      if (current && current !== (rejectedTokens?.has(ctx.response) ? rejectedTokens.get(ctx.response) : lastToken)) return
      const raced = flights.get(serverId)
      if (raced) return raced
      const refresh = adapted.onUnauthorized!(ctx)
      flights.set(serverId, refresh)
      try { await refresh } finally { if (flights.get(serverId) === refresh) flights.delete(serverId) }
    }
  }
}
