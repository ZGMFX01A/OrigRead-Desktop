import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LlmToolRuntime } from '../llm/tool-runtime'
import { MemorySecretStore } from '../security/secret-store'
import { McpRemoteRepository } from './mcp-remote-repository'
import { McpToolCatalogService } from './mcp-tool-catalog-service'
import { McpToolRuntimeBridge, normalizeMcpToolResult } from './mcp-tool-runtime-bridge'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const repository = new McpRemoteRepository(database, new MemorySecretStore())
  const server = repository.addServer().servers[0]!
  repository.updateServer({ id: server.id, name: 'Docs', url: 'https://example.com/mcp', enabled: true })
  const catalog = new McpToolCatalogService(database, repository, {
    listTools: async () => ({ tools: [
      {
        name: 'read_doc',
        description: 'Read one document',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }
      },
      {
        name: 'publish_doc',
        description: 'Publish one document',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false, destructiveHint: true }
      }
    ] })
  })
  return { database, repository, serverId: server.id, catalog }
}

describe('McpToolRuntimeBridge', () => {
  it('registers only fresh cached MCP tools with conservative local risks and executes raw tools/call', async () => {
    const { database, serverId, catalog } = setup()
    const runtime = new LlmToolRuntime()
    const calls: unknown[] = []
    const bridge = new McpToolRuntimeBridge(catalog, {
      callTool: async (requestedServerId, name, argumentsValue) => {
        calls.push({ requestedServerId, name, argumentsValue })
        return { content: [{ type: 'text', text: 'document body' }] }
      }
    }, runtime)
    try {
      await catalog.refreshServer(serverId)
      bridge.sync()
      const descriptors = runtime.descriptors()
      expect(descriptors).toHaveLength(2)
      expect(descriptors.map((descriptor) => ({ id: descriptor.id, risk: descriptor.risk, source: descriptor.source }))).toEqual([
        { id: `mcp:${serverId}:publish_doc`, risk: 'WRITE', source: 'MCP' },
        { id: `mcp:${serverId}:read_doc`, risk: 'READ_ONLY', source: 'MCP' }
      ])
      expect(bridge.enabledToolIds()).toEqual(descriptors.map((descriptor) => descriptor.id))

      const read = descriptors.find((descriptor) => descriptor.id.endsWith(':read_doc'))!
      await expect(runtime.execute(
        { id: 'call-1', toolId: read.id, argumentsJson: '{"id":"doc-1"}' },
        { enabledToolIds: new Set([read.id]) },
        { confirmed: true }
      )).resolves.toEqual({ status: 'SUCCESS', content: 'document body' })
      expect(calls).toEqual([{ requestedServerId: serverId, name: 'read_doc', argumentsValue: { id: 'doc-1' } }])
    } finally { database.close() }
  })

  it('removes registered tools immediately when their cached catalog becomes stale', async () => {
    const { database, repository, serverId, catalog } = setup()
    const runtime = new LlmToolRuntime()
    const bridge = new McpToolRuntimeBridge(catalog, { callTool: async () => ({}) }, runtime)
    try {
      await catalog.refreshServer(serverId)
      bridge.sync()
      expect(runtime.descriptors()).toHaveLength(2)
      repository.updateServer({ id: serverId, authMode: 'BEARER', credential: 'new-secret' })
      expect(catalog.current().servers[0]?.stale).toBe(true)
      bridge.sync()
      expect(runtime.descriptors()).toEqual([])
      expect(bridge.enabledToolIds()).toEqual([])
    } finally { database.close() }
  })

  it('rejects non-object arguments before any remote call', async () => {
    const { database, serverId, catalog } = setup()
    const runtime = new LlmToolRuntime()
    let calls = 0
    const bridge = new McpToolRuntimeBridge(catalog, {
      callTool: async () => { calls += 1; return {} }
    }, runtime)
    try {
      await catalog.refreshServer(serverId)
      bridge.sync()
      const read = runtime.descriptors().find((descriptor) => descriptor.id.endsWith(':read_doc'))!
      await expect(runtime.execute(
        { id: 'call-2', toolId: read.id, argumentsJson: '[]' },
        { enabledToolIds: new Set([read.id]) },
        { confirmed: true }
      )).resolves.toMatchObject({ status: 'FAILURE', message: 'MCP Tool 参数必须是 JSON object' })
      expect(calls).toBe(0)
    } finally { database.close() }
  })
})

describe('normalizeMcpToolResult', () => {
  it('prefers structured content, surfaces MCP errors, and omits binary blocks', () => {
    expect(normalizeMcpToolResult({ structuredContent: { value: 1 }, content: [] })).toEqual({
      status: 'SUCCESS', content: '{"value":1}'
    })
    expect(normalizeMcpToolResult({ isError: true, content: [{ type: 'text', text: 'permission denied' }] })).toEqual({
      status: 'FAILURE', message: 'permission denied'
    })
    expect(normalizeMcpToolResult({ content: [{ type: 'image', data: 'huge-base64', mimeType: 'image/png' }] })).toEqual({
      status: 'SUCCESS', content: '[MCP image content omitted]'
    })
  })
})
