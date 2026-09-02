export const MCP_REMOTE_TRANSPORTS = ['STREAMABLE_HTTP'] as const
export type McpRemoteTransport = typeof MCP_REMOTE_TRANSPORTS[number]
export const MCP_REMOTE_AUTH_MODES = ['NONE', 'BEARER', 'CUSTOM_HEADERS', 'OAUTH'] as const
export type McpRemoteAuthMode = typeof MCP_REMOTE_AUTH_MODES[number]

export type McpProtocolEra = 'MODERN' | 'LEGACY'
export type McpConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'

export interface McpRemoteServerProfile {
  id: string
  name: string
  url: string
  enabled: boolean
  transport: McpRemoteTransport
  authMode: McpRemoteAuthMode
  oauthScopes: string
  hasCredential: boolean
  credentialLength: number
  oauthAuthorized: boolean
}

export interface McpRemoteSettings {
  servers: McpRemoteServerProfile[]
}

export interface McpRemoteServerPatch {
  id: string
  name?: string
  url?: string
  enabled?: boolean
  authMode?: McpRemoteAuthMode
  oauthScopes?: string
  /** Bearer token or newline-delimited custom headers. Never persisted in app_settings. */
  credential?: string
}

export interface McpRemoteRuntimeAuth {
  mode: McpRemoteAuthMode
  bearerToken: string | null
  headers: Record<string, string>
  oauthScopes: string
}

export interface McpServerIdentity {
  name: string
  version: string
  title: string | null
}

export interface McpConnectionSnapshot {
  serverId: string
  status: McpConnectionStatus
  protocolEra: McpProtocolEra | null
  protocolVersion: string | null
  serverInfo: McpServerIdentity | null
  errorMessage: string | null
  updatedAt: number
}

export interface McpRemoteServerHealthResult {
  serverId: string
  serverName: string
  latencyMs: number
  protocolEra: McpProtocolEra
  protocolVersion: string | null
  serverInfo: McpServerIdentity | null
  toolCount: number
}

export interface McpRemoteServerTestResult {
  ok: boolean
  result: McpRemoteServerHealthResult | null
  error: string | null
}

export interface McpLocalServerProfile {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  cwd: string
  /** Environment values stay in Main safeStorage; Renderer only sees presence/length metadata. */
  hasEnvironment: boolean
  environmentLength: number
}

export interface McpLocalSettings {
  servers: McpLocalServerProfile[]
}

export interface McpLocalServerPatch {
  id: string
  name?: string
  enabled?: boolean
  command?: string
  args?: string[]
  cwd?: string
  /** Newline-delimited KEY=VALUE values. Never persisted in app_settings. */
  environment?: string
}

export interface McpLocalServerHealthResult {
  serverId: string
  serverName: string
  latencyMs: number
  protocolEra: McpProtocolEra
  protocolVersion: string | null
  serverInfo: McpServerIdentity | null
  toolCount: number
}

export interface McpLocalServerTestResult {
  ok: boolean
  result: McpLocalServerHealthResult | null
  error: string | null
}

export interface McpToolAnnotationsSnapshot {
  title: string | null
  readOnlyHint: boolean | null
  destructiveHint: boolean | null
  idempotentHint: boolean | null
  openWorldHint: boolean | null
}

export interface McpToolCatalogEntry {
  /** Stable OrigRead identity. Raw MCP names are never used as a global ID. */
  id: string
  serverId: string
  serverName: string
  rawName: string
  /** Provider-safe deterministic function name reserved for D6.6 tool-loop integration. */
  providerName: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  annotations: McpToolAnnotationsSnapshot
}

export interface McpToolCatalogServerSnapshot {
  serverId: string
  serverName: string
  refreshedAt: number
  stale: boolean
  tools: McpToolCatalogEntry[]
}

export interface McpToolCatalogSnapshot {
  servers: McpToolCatalogServerSnapshot[]
}

