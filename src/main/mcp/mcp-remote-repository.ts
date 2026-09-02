import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SecretStore } from '../security/secret-store'
import type { McpBackup, McpRemoteOAuthBackupSecrets } from '../../shared/configuration-backup'
import {
  MCP_REMOTE_AUTH_MODES,
  type McpRemoteAuthMode,
  type McpRemoteRuntimeAuth,
  type McpRemoteServerPatch,
  type McpRemoteServerProfile,
  type McpRemoteSettings
} from '../../shared/mcp'
import type { McpCatalogServerProfile, McpToolCatalogRegistry } from './mcp-tool-catalog-service'

const SETTINGS_KEY = 'llm.mcp.remote'
const MAX_SERVER_NAME_LENGTH = 80
const MAX_SERVER_URL_LENGTH = 2_000
const MAX_SERVER_COUNT = 100
const MAX_OAUTH_SCOPES_LENGTH = 2_000
const MAX_CUSTOM_HEADERS = 32
const MAX_HEADER_VALUE_LENGTH = 16_384
const MAX_BACKUP_SECRET_LENGTH = 1_000_000
const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'origin',
  'referer',
  'transfer-encoding'
])

interface StoredMcpRemoteServerProfile {
  id: string
  name: string
  url: string
  enabled: boolean
  transport: 'STREAMABLE_HTTP'
  authMode: McpRemoteAuthMode
  oauthScopes: string
}

interface StoredMcpRemoteSettings {
  servers: StoredMcpRemoteServerProfile[]
}

export class McpRemoteRepository implements McpToolCatalogRegistry {
  constructor(private readonly database: DatabaseSync, private readonly secrets: SecretStore) {}

  current(): McpRemoteSettings {
    const stored = normalizeSettings(this.read())
    return { servers: stored.servers.map((server) => this.toPublic(server)) }
  }

  addServer(): McpRemoteSettings {
    const current = this.toStored(this.current())
    if (current.servers.length >= MAX_SERVER_COUNT) throw new Error(`Remote MCP Server 最多 ${MAX_SERVER_COUNT} 个`)
    const nextIndex = current.servers.length + 1
    const server: StoredMcpRemoteServerProfile = {
      id: randomUUID(),
      name: `MCP Server ${nextIndex}`,
      url: '',
      enabled: false,
      transport: 'STREAMABLE_HTTP',
      authMode: 'NONE',
      oauthScopes: ''
    }
    return this.save({ servers: [...current.servers, server] })
  }

  updateServer(patch: McpRemoteServerPatch): McpRemoteSettings {
    const current = this.toStored(this.current())
    const existing = current.servers.find((server) => server.id === patch.id)
    if (!existing) throw new Error('Remote MCP Server 不存在')
    const normalizedUrl = patch.url === undefined ? existing.url : normalizeUrl(patch.url)
    const nextAuthMode = patch.authMode === undefined ? existing.authMode : patch.authMode
    const nextOAuthScopes = patch.oauthScopes === undefined ? existing.oauthScopes : normalizeOAuthScopes(patch.oauthScopes)
    const endpointChanged = normalizedUrl !== existing.url
    const authModeChanged = nextAuthMode !== existing.authMode
    const oauthScopesChanged = nextOAuthScopes !== existing.oauthScopes
    if (endpointChanged || authModeChanged) this.clearOAuthSecrets(existing.id)
    else if (oauthScopesChanged) this.clearOAuthAuthorization(existing.id)
    if (patch.credential !== undefined) this.secrets.put(credentialSecretKey(existing.id), patch.credential)
    const updated = normalizeServer({
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.authMode === undefined ? {} : { authMode: patch.authMode }),
      ...(patch.oauthScopes === undefined ? {} : { oauthScopes: patch.oauthScopes })
    })
    return this.save({ servers: current.servers.map((server) => server.id === updated.id ? updated : server) })
  }

  removeServer(serverId: string): McpRemoteSettings {
    const id = serverId.trim()
    const current = this.toStored(this.current())
    this.secrets.delete(credentialSecretKey(id))
    this.clearOAuthSecrets(id)
    return this.save({ servers: current.servers.filter((server) => server.id !== id) })
  }

  getServer(serverId: string): McpRemoteServerProfile | null {
    const id = serverId.trim()
    return this.current().servers.find((server) => server.id === id) ?? null
  }

  requireConfiguredServer(serverId: string): McpRemoteServerProfile {
    const server = this.getServer(serverId)
    if (!server) throw new Error('Remote MCP Server 不存在')
    if (!server.enabled) throw new Error(`Remote MCP Server 已停用：${server.name}`)
    if (!server.url) throw new Error(`Remote MCP Server 尚未配置 URL：${server.name}`)
    if ((server.authMode === 'BEARER' || server.authMode === 'CUSTOM_HEADERS') && !server.hasCredential) {
      throw new Error(`Remote MCP Server 尚未保存认证信息：${server.name}`)
    }
    return server
  }

  getCredential(serverId: string): string {
    return this.secrets.get(credentialSecretKey(serverId.trim()))
  }

  runtimeAuth(serverId: string): McpRemoteRuntimeAuth {
    const server = this.getServer(serverId)
    if (!server) throw new Error('Remote MCP Server 不存在')
    const credential = this.getCredential(server.id)
    if (server.authMode === 'BEARER') {
      return { mode: server.authMode, bearerToken: credential || null, headers: {}, oauthScopes: server.oauthScopes }
    }
    if (server.authMode === 'CUSTOM_HEADERS') {
      return { mode: server.authMode, bearerToken: null, headers: parseCustomHeaders(credential), oauthScopes: server.oauthScopes }
    }
    return { mode: server.authMode, bearerToken: null, headers: {}, oauthScopes: server.oauthScopes }
  }

  catalogAuthFingerprint(serverId: string): string {
    const server = this.getServer(serverId)
    if (!server) throw new Error('Remote MCP Server 不存在')
    const credential = server.authMode === 'BEARER' || server.authMode === 'CUSTOM_HEADERS'
      ? this.getCredential(server.id)
      : ''
    const oauthTokens = server.authMode === 'OAUTH'
      ? this.secrets.get(mcpOAuthSecretKey(server.id, 'tokens'))
      : ''
    return createHash('sha256')
      .update(JSON.stringify([server.authMode, server.oauthScopes, credential, oauthTokens]))
      .digest('hex')
  }

  currentCatalogServers(): McpCatalogServerProfile[] {
    return this.current().servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      fingerprint: remoteCatalogFingerprint(server, this.catalogAuthFingerprint(server.id))
    }))
  }

  requireCatalogServer(serverId: string): McpCatalogServerProfile {
    const server = this.requireConfiguredServer(serverId)
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      fingerprint: remoteCatalogFingerprint(server, this.catalogAuthFingerprint(server.id))
    }
  }

  oauthSecretKey(serverId: string, kind: McpOAuthSecretKind): string {
    return mcpOAuthSecretKey(serverId.trim(), kind)
  }

  clearOAuthSecrets(serverId: string): void {
    const id = serverId.trim()
    for (const kind of ['client', 'tokens', 'verifier', 'state', 'discovery'] as const) this.secrets.delete(mcpOAuthSecretKey(id, kind))
  }

  clearOAuthAuthorization(serverId: string): McpRemoteSettings {
    const id = serverId.trim()
    for (const kind of ['tokens', 'verifier', 'state'] as const) this.secrets.delete(mcpOAuthSecretKey(id, kind))
    return this.current()
  }

  exportBackupState(): McpBackup['remote'] {
    return structuredClone(this.toStored(this.current()))
  }

  exportBackupSecrets(): {
    credentials: Record<string, string>
    oauth: Record<string, McpRemoteOAuthBackupSecrets>
  } {
    const credentials: Record<string, string> = {}
    const oauth: Record<string, McpRemoteOAuthBackupSecrets> = {}
    for (const server of this.current().servers) {
      if (server.authMode === 'BEARER' || server.authMode === 'CUSTOM_HEADERS') {
        const credential = this.getCredential(server.id)
        if (credential) credentials[server.id] = credential
      }
      if (server.authMode === 'OAUTH') {
        const saved: McpRemoteOAuthBackupSecrets = {}
        for (const kind of ['client', 'tokens', 'discovery'] as const) {
          const value = this.secrets.get(mcpOAuthSecretKey(server.id, kind))
          if (value) saved[kind] = value
        }
        if (Object.keys(saved).length > 0) oauth[server.id] = saved
      }
    }
    return { credentials, oauth }
  }

  validateBackupState(
    value: McpBackup['remote'],
    credentials?: Record<string, string>,
    oauth?: Record<string, McpRemoteOAuthBackupSecrets>
  ): void {
    const normalized = normalizeBackupSettings(value)
    validateBackupSecrets(normalized, credentials, oauth)
  }

  restoreBackupState(
    value: McpBackup['remote'],
    credentials?: Record<string, string>,
    oauth?: Record<string, McpRemoteOAuthBackupSecrets>
  ): McpRemoteSettings {
    const normalized = normalizeBackupSettings(value)
    validateBackupSecrets(normalized, credentials, oauth)
    const idsToClear = new Set([
      ...this.current().servers.map((server) => server.id),
      ...normalized.servers.map((server) => server.id)
    ])
    for (const id of idsToClear) {
      this.secrets.delete(credentialSecretKey(id))
      this.clearOAuthSecrets(id)
    }
    this.save(normalized)
    for (const [serverId, credential] of Object.entries(credentials ?? {})) {
      if (credential) this.secrets.put(credentialSecretKey(serverId), credential)
    }
    for (const [serverId, values] of Object.entries(oauth ?? {})) {
      for (const kind of ['client', 'tokens', 'discovery'] as const) {
        const secret = values[kind]
        if (secret) this.secrets.put(mcpOAuthSecretKey(serverId, kind), secret)
      }
    }
    return this.current()
  }

  private save(settings: StoredMcpRemoteSettings): McpRemoteSettings {
    const normalized = normalizeSettings(settings)
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(normalized), Date.now())
    return { servers: normalized.servers.map((server) => this.toPublic(server)) }
  }

  private read(): unknown {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.value) as unknown } catch { return null }
  }

  private toPublic(server: StoredMcpRemoteServerProfile): McpRemoteServerProfile {
    const key = credentialSecretKey(server.id)
    const hasCredential = this.secrets.contains(key)
    return {
      ...server,
      hasCredential,
      credentialLength: hasCredential ? this.secrets.get(key).length : 0,
      oauthAuthorized: this.secrets.contains(mcpOAuthSecretKey(server.id, 'tokens'))
    }
  }

  private toStored(settings: McpRemoteSettings): StoredMcpRemoteSettings {
    return {
      servers: settings.servers.map(({ hasCredential: _hasCredential, credentialLength: _credentialLength, oauthAuthorized: _oauthAuthorized, ...server }) => server)
    }
  }
}

function normalizeSettings(value: unknown): StoredMcpRemoteSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { servers: [] }
  const record = value as { servers?: unknown }
  const seen = new Set<string>()
  const servers = Array.isArray(record.servers)
    ? record.servers.flatMap((item) => {
        const server = safeNormalizeServer(item)
        if (!server || seen.has(server.id) || seen.size >= MAX_SERVER_COUNT) return []
        seen.add(server.id)
        return [server]
      })
    : []
  return { servers }
}

function normalizeBackupSettings(value: unknown): StoredMcpRemoteSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份中的 Remote MCP 配置无效')
  const record = value as { servers?: unknown }
  if (!Array.isArray(record.servers) || record.servers.length > MAX_SERVER_COUNT) throw new Error('备份中的 Remote MCP Server 列表无效')
  const ids = new Set<string>()
  const servers = record.servers.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('备份包含无效 Remote MCP Server')
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('备份包含无效 Remote MCP Server ID')
    if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('备份包含无效 Remote MCP Server 名称')
    if (typeof raw.url !== 'string' || typeof raw.enabled !== 'boolean' || raw.transport !== 'STREAMABLE_HTTP') throw new Error('备份包含无效 Remote MCP Server 配置')
    if (typeof raw.authMode !== 'string' || !MCP_REMOTE_AUTH_MODES.includes(raw.authMode as McpRemoteAuthMode)) throw new Error('备份包含未知 Remote MCP 认证方式')
    if (typeof raw.oauthScopes !== 'string') throw new Error('备份包含无效 Remote MCP OAuth Scope')
    const server = normalizeServer(raw)
    if (ids.has(server.id)) throw new Error(`备份包含重复 Remote MCP Server：${server.id}`)
    ids.add(server.id)
    return server
  })
  return { servers }
}

function validateBackupSecrets(
  settings: StoredMcpRemoteSettings,
  credentials: Record<string, string> | undefined,
  oauth: Record<string, McpRemoteOAuthBackupSecrets> | undefined
): void {
  const servers = new Map(settings.servers.map((server) => [server.id, server]))
  for (const [serverId, credential] of Object.entries(credentials ?? {})) {
    const server = servers.get(serverId)
    if (!server) throw new Error('Remote MCP 凭据引用了不存在的 Server')
    if (server.authMode !== 'BEARER' && server.authMode !== 'CUSTOM_HEADERS') throw new Error(`Remote MCP Server ${server.name} 的认证方式不使用独立凭据`)
    if (typeof credential !== 'string' || !credential.trim() || credential.length > MAX_BACKUP_SECRET_LENGTH || credential.includes('\0')) throw new Error(`Remote MCP Server ${server.name} 的备份凭据无效`)
    if (server.authMode === 'CUSTOM_HEADERS') parseCustomHeaders(credential)
  }
  for (const [serverId, values] of Object.entries(oauth ?? {})) {
    const server = servers.get(serverId)
    if (!server) throw new Error('Remote MCP OAuth 凭据引用了不存在的 Server')
    if (server.authMode !== 'OAUTH') throw new Error(`Remote MCP Server ${server.name} 不是 OAuth 配置`)
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Remote MCP Server ${server.name} 的 OAuth 备份无效`)
    const allowedKinds = new Set(['client', 'tokens', 'discovery'])
    for (const kind of Object.keys(values)) {
      if (!allowedKinds.has(kind)) throw new Error(`Remote MCP Server ${server.name} 的 OAuth 备份包含不允许的瞬态状态：${kind}`)
    }
    for (const kind of ['client', 'tokens', 'discovery'] as const) {
      const secret = values[kind]
      if (secret === undefined) continue
      if (typeof secret !== 'string' || !secret.trim() || secret.length > MAX_BACKUP_SECRET_LENGTH || secret.includes('\0')) throw new Error(`Remote MCP Server ${server.name} 的 OAuth ${kind} 备份无效`)
      try { JSON.parse(secret) } catch { throw new Error(`Remote MCP Server ${server.name} 的 OAuth ${kind} 备份已损坏`) }
    }
  }
}

function safeNormalizeServer(value: unknown): StoredMcpRemoteServerProfile | null {
  try { return normalizeServer(value) } catch { return null }
}

function normalizeServer(value: unknown): StoredMcpRemoteServerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Remote MCP Server 配置无效')
  const record = value as Partial<StoredMcpRemoteServerProfile>
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 512) : ''
  if (!id) throw new Error('Remote MCP Server ID 不能为空')
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_SERVER_NAME_LENGTH) : ''
  const url = normalizeUrl(typeof record.url === 'string' ? record.url : '')
  const authMode = typeof record.authMode === 'string' && MCP_REMOTE_AUTH_MODES.includes(record.authMode as McpRemoteAuthMode)
    ? record.authMode as McpRemoteAuthMode
    : 'NONE'
  return {
    id,
    name: name || 'MCP Server',
    url,
    enabled: record.enabled === true,
    transport: 'STREAMABLE_HTTP',
    authMode,
    oauthScopes: typeof record.oauthScopes === 'string' ? normalizeOAuthScopes(record.oauthScopes) : ''
  }
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().slice(0, MAX_SERVER_URL_LENGTH)
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Remote MCP URL 只支持 HTTP/HTTPS')
  url.hash = ''
  return url.toString()
}

function normalizeOAuthScopes(value: string): string {
  return [...new Set(value.trim().slice(0, MAX_OAUTH_SCOPES_LENGTH).split(/\s+/).filter(Boolean))].join(' ')
}

function parseCustomHeaders(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length > MAX_CUSTOM_HEADERS) throw new Error(`Custom Headers 最多 ${MAX_CUSTOM_HEADERS} 行`)
  for (const line of lines) {
    const colon = line.indexOf(':')
    const equals = line.indexOf('=')
    const separator = colon >= 0 && (equals < 0 || colon < equals) ? colon : equals
    if (separator <= 0) throw new Error('Custom Header 格式应为 Name: Value 或 Name=Value')
    const name = line.slice(0, separator).trim()
    const headerValue = line.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`Custom Header 名称无效：${name}`)
    const lowerName = name.toLowerCase()
    if (FORBIDDEN_CUSTOM_HEADERS.has(lowerName) || lowerName.startsWith('mcp-')) throw new Error(`不允许覆盖 MCP 传输 Header：${name}`)
    if (!headerValue || headerValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(headerValue)) throw new Error(`Custom Header 值无效：${name}`)
    result[name] = headerValue
  }
  return result
}

function credentialSecretKey(serverId: string): string {
  return `mcp:${serverId}:credential`
}

export type McpOAuthSecretKind = 'client' | 'tokens' | 'verifier' | 'state' | 'discovery'

export function mcpOAuthSecretKey(serverId: string, kind: McpOAuthSecretKind): string {
  return `mcp:${serverId}:oauth:${kind}`
}

function remoteCatalogFingerprint(server: Pick<McpRemoteServerProfile, 'url' | 'transport'>, authFingerprint: string): string {
  return createHash('sha256').update(`REMOTE\0${server.transport}\0${server.url}\0${authFingerprint}`).digest('hex')
}

