import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import type { McpLocalConnector, McpLocalConnectorFactory } from './mcp-local-client-manager'
import { McpLocalClientManager } from './mcp-local-client-manager'
import { McpLocalRepository } from './mcp-local-repository'

vi.mock('./mcp-stdio-guardian-path', () => ({ MCP_STDIO_GUARDIAN_PATH: 'mcp-stdio-guardian.cjs' }))

function connector(overrides: Partial<McpLocalConnector> = {}): McpLocalConnector {
  return {
    connect: async () => ({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: { name: 'local', version: '1', title: null } }),
    listTools: async () => ({ tools: [{ name: 'read' }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {},
    ...overrides
  }
}

function setup(factory: McpLocalConnectorFactory) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const repository = new McpLocalRepository(database, new MemorySecretStore())
  const created = repository.addServer().servers[0]!
  repository.updateServer({ id: created.id, command: 'node', args: ['fixture.js'], enabled: true })
  return { database, repository, serverId: created.id, manager: new McpLocalClientManager(repository, factory) }
}

describe('McpLocalClientManager', () => {
  it('starts lazily, reuses a live stdio client, and invalidates after process config changes', async () => {
    let created = 0
    let closed = 0
    const { database, repository, serverId, manager } = setup(() => {
      created += 1
      return connector({ close: async () => { closed += 1 } })
    })
    try {
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
      await manager.listTools(serverId)
      await manager.listTools(serverId)
      expect(created).toBe(1)

      repository.updateServer({ id: serverId, args: ['changed.js'] })
      await manager.listTools(serverId)
      expect(created).toBe(2)
      expect(closed).toBe(1)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('invalidates an active process when secret environment identity changes', async () => {
    let created = 0
    const { database, repository, serverId, manager } = setup(() => { created += 1; return connector() })
    try {
      repository.updateServer({ id: serverId, environment: 'TOKEN=one' })
      await manager.listTools(serverId)
      repository.updateServer({ id: serverId, environment: 'TOKEN=two' })
      await manager.listTools(serverId)
      expect(created).toBe(2)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('uses an isolated short-lived process for health checks', async () => {
    let closed = 0
    let timeout = 0
    const { database, serverId, manager } = setup((_server, options) => {
      timeout = options.requestTimeoutMs
      return connector({ listTools: async () => ({ tools: [{}, {}, {}] }), close: async () => { closed += 1 } })
    })
    try {
      await expect(manager.checkHealth(serverId)).resolves.toMatchObject({
        serverId, protocolEra: 'MODERN', protocolVersion: '2026-07-28', toolCount: 3
      })
      expect(timeout).toBe(10_000)
      expect(closed).toBe(1)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
    } finally { database.close() }
  })

  it('routes tools/call over the active local connection', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const { database, serverId, manager } = setup(() => connector({
      callTool: async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: 'done' }] }
      }
    }))
    try {
      await expect(manager.callTool(serverId, 'read', { id: 3 })).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
      expect(calls).toEqual([{ name: 'read', args: { id: 3 } }])
      expect(manager.state(serverId).status).toBe('CONNECTED')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('redacts secret-shaped stdio errors before rejection/state reaches Renderer', async () => {
    const { database, serverId, manager } = setup(() => connector({
      connect: async () => { throw new Error('Authorization: Bearer stdio-secret TOKEN=env-secret') }
    }))
    try {
      await expect(manager.connect(serverId)).rejects.toThrow('[redacted]')
      const state = manager.state(serverId)
      expect(state.status).toBe('ERROR')
      expect(state.errorMessage).toContain('[redacted]')
      expect(state.errorMessage).not.toContain('stdio-secret')
      expect(state.errorMessage).not.toContain('env-secret')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })
})
