import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  McpToolAnnotationsSnapshot,
  McpToolCatalogEntry,
  McpToolCatalogServerSnapshot,
  McpToolCatalogSnapshot
} from '../../shared/mcp'
const SETTINGS_KEY = 'llm.mcp.tool-catalog'
const MAX_CACHED_SERVERS = 100
const MAX_TOOLS_PER_SERVER = 2_000
const MAX_TOOL_NAME_LENGTH = 512
const MAX_TOOL_DESCRIPTION_LENGTH = 16_000

interface StoredCatalogServer {
  serverId: string
  endpointFingerprint: string
  refreshedAt: number
  tools: StoredCatalogTool[]
}

interface StoredCatalogTool {
  rawName: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown> | null
  annotations: McpToolAnnotationsSnapshot
}

interface StoredCatalog {
  servers: StoredCatalogServer[]
}

export interface McpToolListSource {
  listTools(serverId: string, signal?: AbortSignal): Promise<{ tools: unknown[] }>
}

export interface McpCatalogServerProfile {
  id: string
  name: string
  enabled: boolean
  fingerprint: string
}

export interface McpToolCatalogRegistry {
  currentCatalogServers(): McpCatalogServerProfile[]
  requireCatalogServer(serverId: string): McpCatalogServerProfile
}

export class McpToolCatalogService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly registry: McpToolCatalogRegistry,
    private readonly source: McpToolListSource
  ) {}

  current(): McpToolCatalogSnapshot {
    const stored = this.read()
    const profiles = new Map(this.registry.currentCatalogServers().map((server) => [server.id, server]))
    return {
      servers: stored.servers.map((server): McpToolCatalogServerSnapshot => {
        const profile = profiles.get(server.serverId)
        const serverName = profile?.name || server.serverId
        const stale = !profile || !profile.enabled || profile.fingerprint !== server.endpointFingerprint
        return {
          serverId: server.serverId,
          serverName,
          refreshedAt: server.refreshedAt,
          stale,
          tools: server.tools.map((tool) => publicTool(server.serverId, serverName, tool))
        }
      }).sort((left, right) => left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId))
    }
  }

  async refreshServer(serverId: string, signal?: AbortSignal): Promise<McpToolCatalogSnapshot> {
    const profile = this.registry.requireCatalogServer(serverId)
    const result = await this.source.listTools(profile.id, signal)
    const tools = normalizeTools(result.tools)
    const current = this.read()
    const nextServer: StoredCatalogServer = {
      serverId: profile.id,
      endpointFingerprint: profile.fingerprint,
      refreshedAt: Date.now(),
      tools
    }
    const servers = [
      ...current.servers.filter((server) => server.serverId !== profile.id),
      nextServer
    ].slice(-MAX_CACHED_SERVERS)
    this.write({ servers })
    return this.current()
  }

  removeServer(serverId: string): McpToolCatalogSnapshot {
    const id = serverId.trim()
    const current = this.read()
    this.write({ servers: current.servers.filter((server) => server.serverId !== id) })
    return this.current()
  }

  invalidateAll(): McpToolCatalogSnapshot {
    this.write({ servers: [] })
    return this.current()
  }

  private read(): StoredCatalog {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY) as { value: string } | undefined
    if (!row) return { servers: [] }
    try { return normalizeStoredCatalog(JSON.parse(row.value) as unknown) } catch { return { servers: [] } }
  }

  private write(catalog: StoredCatalog): void {
    this.database.prepare(`
      INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    `).run(SETTINGS_KEY, JSON.stringify(catalog), Date.now())
  }
}

function normalizeTools(values: readonly unknown[]): StoredCatalogTool[] {
  const tools: StoredCatalogTool[] = []
  const names = new Set<string>()
  for (const value of values) {
    if (tools.length >= MAX_TOOLS_PER_SERVER) break
    const tool = normalizeTool(value)
    if (!tool || names.has(tool.rawName)) continue
    names.add(tool.rawName)
    tools.push(tool)
  }
  return tools.sort((left, right) => left.rawName.localeCompare(right.rawName))
}

function normalizeTool(value: unknown): StoredCatalogTool | null {
  if (!isObject(value)) return null
  const rawName = typeof value.name === 'string' ? value.name.trim().slice(0, MAX_TOOL_NAME_LENGTH) : ''
  if (!rawName || !isObject(value.inputSchema)) return null
  const outputSchema = value.outputSchema == null ? null : isObject(value.outputSchema) ? structuredClone(value.outputSchema) : null
  return {
    rawName,
    title: textOrNull(value.title, 1_000),
    description: typeof value.description === 'string' ? value.description.trim().slice(0, MAX_TOOL_DESCRIPTION_LENGTH) : '',
    inputSchema: structuredClone(value.inputSchema),
    outputSchema,
    annotations: normalizeAnnotations(value.annotations)
  }
}

function normalizeAnnotations(value: unknown): McpToolAnnotationsSnapshot {
  const record = isObject(value) ? value : {}
  return {
    title: textOrNull(record.title, 1_000),
    readOnlyHint: booleanOrNull(record.readOnlyHint),
    destructiveHint: booleanOrNull(record.destructiveHint),
    idempotentHint: booleanOrNull(record.idempotentHint),
    openWorldHint: booleanOrNull(record.openWorldHint)
  }
}

function normalizeStoredCatalog(value: unknown): StoredCatalog {
  if (!isObject(value) || !Array.isArray(value.servers)) return { servers: [] }
  const servers: StoredCatalogServer[] = []
  const ids = new Set<string>()
  for (const item of value.servers) {
    if (servers.length >= MAX_CACHED_SERVERS || !isObject(item)) break
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim().slice(0, 512) : ''
    const fingerprint = typeof item.endpointFingerprint === 'string' ? item.endpointFingerprint : ''
    if (!serverId || !fingerprint || ids.has(serverId) || !Array.isArray(item.tools)) continue
    ids.add(serverId)
    servers.push({
      serverId,
      endpointFingerprint: fingerprint,
      refreshedAt: Number.isFinite(item.refreshedAt) ? Math.max(0, Math.trunc(Number(item.refreshedAt))) : 0,
      tools: normalizeStoredTools(item.tools)
    })
  }
  return { servers }
}

function normalizeStoredTools(values: readonly unknown[]): StoredCatalogTool[] {
  const tools: StoredCatalogTool[] = []
  const names = new Set<string>()
  for (const value of values) {
    if (tools.length >= MAX_TOOLS_PER_SERVER || !isObject(value)) break
    const rawName = typeof value.rawName === 'string' ? value.rawName.trim().slice(0, MAX_TOOL_NAME_LENGTH) : ''
    if (!rawName || names.has(rawName) || !isObject(value.inputSchema)) continue
    names.add(rawName)
    tools.push({
      rawName,
      title: textOrNull(value.title, 1_000),
      description: typeof value.description === 'string' ? value.description.trim().slice(0, MAX_TOOL_DESCRIPTION_LENGTH) : '',
      inputSchema: structuredClone(value.inputSchema),
      outputSchema: value.outputSchema == null ? null : isObject(value.outputSchema) ? structuredClone(value.outputSchema) : null,
      annotations: normalizeAnnotations(value.annotations)
    })
  }
  return tools.sort((left, right) => left.rawName.localeCompare(right.rawName))
}

function publicTool(serverId: string, serverName: string, tool: StoredCatalogTool): McpToolCatalogEntry {
  return {
    id: `mcp:${serverId}:${tool.rawName}`,
    serverId,
    serverName,
    rawName: tool.rawName,
    providerName: providerSafeToolName(serverId, tool.rawName),
    title: tool.title,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    outputSchema: tool.outputSchema ? structuredClone(tool.outputSchema) : null,
    annotations: { ...tool.annotations }
  }
}

export function providerSafeToolName(serverId: string, rawName: string): string {
  const hash = createHash('sha256').update(`${serverId}\0${rawName}`).digest('hex').slice(0, 8)
  const normalized = rawName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'tool'
  return `mcp_${hash}_${normalized}`
}

function textOrNull(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

