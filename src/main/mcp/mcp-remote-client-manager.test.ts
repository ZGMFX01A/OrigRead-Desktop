import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import type { McpRemoteConnector, McpRemoteConnectorFactory } from './mcp-remote-client-manager'
import { McpRemoteClientManager } from './mcp-remote-client-manager'
import { McpRemoteRepository } from './mcp-remote-repository'

function setup(factory: McpRemoteConnectorFactory) {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const repository = new McpRemoteRepository(database, new MemorySecretStore())
  const created = repository.addServer().servers[0]!
  repository.updateServer({ id: created.id, url: 'https://example.com/mcp', enabled: true })
  return { database, repository, serverId: created.id, manager: new McpRemoteClientManager(repository, factory) }
}

function connector(overrides: Partial<McpRemoteConnector> = {}): McpRemoteConnector {
  return {
    connect: async () => ({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: { name: 'test', version: '1', title: null } }),
    listTools: async () => ({ tools: [{ name: 'read' }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {},
    ...overrides
  }
}

describe('McpRemoteClientManager', () => {
  it('redacts secret-shaped Remote MCP errors before rejection/state reaches Renderer', async () => {
    const { database, serverId, manager } = setup(() => connector({
      connect: async () => { throw new Error('Authorization: Bearer remote-secret api_key=header-secret') }
    }))
    try {
      await expect(manager.connect(serverId)).rejects.toThrow('[redacted]')
      const state = manager.state(serverId)
      expect(state.status).toBe('ERROR')
      expect(state.errorMessage).toContain('[redacted]')
      expect(state.errorMessage).not.toContain('remote-secret')
      expect(state.errorMessage).not.toContain('header-secret')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('lazily connects, reuses a healthy connection, and invalidates it after config changes', async () => {
    let createdConnectors = 0
    let closes = 0
    const factory: McpRemoteConnectorFactory = () => {
      createdConnectors += 1
      return connector({ close: async () => { closes += 1 } })
    }
    const { database, repository, serverId, manager } = setup(factory)
    try {
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
      await manager.listTools(serverId)
      await manager.listTools(serverId)
      expect(createdConnectors).toBe(1)
      expect(manager.state(serverId)).toMatchObject({ status: 'CONNECTED', protocolEra: 'MODERN', protocolVersion: '2026-07-28' })

      repository.updateServer({ id: serverId, url: 'https://changed.example.com/mcp' })
      await manager.listTools(serverId)
      expect(createdConnectors).toBe(2)
      expect(closes).toBe(1)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('isolates a failed server connection and retries on the next use', async () => {
    let attempts = 0
    const factory: McpRemoteConnectorFactory = () => connector({
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('server offline')
        return { protocolEra: 'LEGACY', protocolVersion: '2025-11-25', serverInfo: null }
      }
    })
    const { database, serverId, manager } = setup(factory)
    try {
      await expect(manager.listTools(serverId)).rejects.toThrow('server offline')
      expect(manager.state(serverId)).toMatchObject({ status: 'ERROR', errorMessage: 'server offline' })
      await expect(manager.listTools(serverId)).resolves.toEqual({ tools: [{ name: 'read' }] })
      expect(attempts).toBe(2)
      expect(manager.state(serverId)).toMatchObject({ status: 'CONNECTED', protocolEra: 'LEGACY' })
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('uses an isolated short-lived connection for health checks', async () => {
    let closes = 0
    let factoryTimeout = 0
    const factory: McpRemoteConnectorFactory = (_server, options) => {
      factoryTimeout = options.requestTimeoutMs
      return connector({
        listTools: async () => ({ tools: [{}, {}, {}] }),
        close: async () => { closes += 1 }
      })
    }
    const { database, serverId, manager } = setup(factory)
    try {
      const health = await manager.checkHealth(serverId)
      expect(health).toMatchObject({ serverId, protocolEra: 'MODERN', protocolVersion: '2026-07-28', toolCount: 3 })
      expect(factoryTimeout).toBe(10_000)
      expect(closes).toBe(1)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
    } finally { database.close() }
  })

  it('reuses the active connection for tools/call and forwards arguments', async () => {
    const calls: Array<{ name: string; argumentsValue: Record<string, unknown> }> = []
    const { database, serverId, manager } = setup(() => connector({
      callTool: async (name, argumentsValue) => {
        calls.push({ name, argumentsValue })
        return { content: [{ type: 'text', text: 'done' }] }
      }
    }))
    try {
      await manager.listTools(serverId)
      await expect(manager.callTool(serverId, 'read', { id: 7 })).resolves.toEqual({
        content: [{ type: 'text', text: 'done' }]
      })
      expect(calls).toEqual([{ name: 'read', argumentsValue: { id: 7 } }])
      expect(manager.state(serverId).status).toBe('CONNECTED')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('runs OAuth only through the explicit authorize path and keeps the resulting connection active', async () => {
    let ordinaryConnects = 0
    let authorizations = 0
    const factory: McpRemoteConnectorFactory = () => connector({
      connect: async () => {
        ordinaryConnects += 1
        throw new Error('authorization required')
      },
      authorize: async () => {
        authorizations += 1
        return { protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: { name: 'oauth', version: '1', title: null } }
      }
    })
    const { database, repository, serverId, manager } = setup(factory)
    try {
      repository.updateServer({ id: serverId, authMode: 'OAUTH' })
      await expect(manager.connect(serverId)).rejects.toThrow('authorization required')
      expect(authorizations).toBe(0)

      await expect(manager.authorize(serverId)).resolves.toMatchObject({ status: 'CONNECTED', protocolEra: 'MODERN' })
      expect(ordinaryConnects).toBe(1)
      expect(authorizations).toBe(1)
      await expect(manager.listTools(serverId)).resolves.toEqual({ tools: [{ name: 'read' }] })
      expect(manager.state(serverId).status).toBe('CONNECTED')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('cancels a pending OAuth authorization when the server is disconnected', async () => {
    let closed = 0
    let observedAbort = false
    const factory: McpRemoteConnectorFactory = () => connector({
      authorize: async (signal) => await new Promise((_resolve, reject) => {
        const abort = () => {
          observedAbort = true
          reject(signal?.reason ?? new DOMException('cancelled', 'AbortError'))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      }),
      close: async () => { closed += 1 }
    })
    const { database, repository, serverId, manager } = setup(factory)
    try {
      repository.updateServer({ id: serverId, authMode: 'OAUTH' })
      const pending = manager.authorize(serverId)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await manager.disconnect(serverId)
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(observedAbort).toBe(true)
      expect(closed).toBeGreaterThanOrEqual(1)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })
})

