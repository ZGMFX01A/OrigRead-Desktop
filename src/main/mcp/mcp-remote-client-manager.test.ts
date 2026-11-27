import { createMcpRemoteFetch } from './mcp-remote-client-manager'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
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

  it('merges concurrent connect calls for the same remote server and creates only one connector', async () => {
    let created = 0
    let closed = 0
    let resolveConnect: (val: any) => void = () => {}
    const { database, serverId, manager } = setup(() => {
      created += 1
      return connector({
        connect: () => new Promise((resolve) => { resolveConnect = resolve }),
        close: async () => { closed += 1 }
      })
    })
    try {
      const p1 = manager.connect(serverId)
      const p2 = manager.connect(serverId)
      expect(created).toBe(1)

      await new Promise((r) => setTimeout(r, 0))
      resolveConnect({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: { name: 'remote', version: '1', title: null } })
      const [s1, s2] = await Promise.all([p1, p2])
      expect(s1).toBe(s2)
      expect(s1.status).toBe('CONNECTED')
      expect(created).toBe(1)
      expect(closed).toBe(0)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('closes connector and leaves no active connection when disconnected during remote connect', async () => {
    let heldResource: { id: number } | null = null
    let closed = 0
    let resolveConnect: (val: any) => void = () => {}
    const { database, serverId, manager } = setup(() => connector({
      connect: () => new Promise((resolve) => {
        resolveConnect = (val: any) => {
          heldResource = { id: 1 }
          resolve(val)
        }
      }),
      close: async () => {
        heldResource = null
        closed += 1
      }
    }))
    try {
      const connectingPromise = manager.connect(serverId)
      expect(manager.state(serverId).status).toBe('CONNECTING')

      await manager.disconnect(serverId)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')

      resolveConnect({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: null })
      await connectingPromise

      expect(heldResource).toBeNull()
      expect(closed).toBeGreaterThanOrEqual(1)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })

  it('disconnectAll handles in-flight remote connections properly', async () => {
    let heldResource: { id: number } | null = null
    let closed = 0
    let resolveConnect: (val: any) => void = () => {}
    const { database, serverId, manager } = setup(() => connector({
      connect: () => new Promise((resolve) => {
        resolveConnect = (val: any) => {
          heldResource = { id: 1 }
          resolve(val)
        }
      }),
      close: async () => {
        heldResource = null
        closed += 1
      }
    }))
    try {
      const connectingPromise = manager.connect(serverId)
      await manager.disconnectAll()

      resolveConnect({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: null })
      await connectingPromise

      expect(heldResource).toBeNull()
      expect(closed).toBeGreaterThanOrEqual(1)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
    } finally {
      database.close()
    }
  })

  it('prevents stale late-resolving connect from reviving after remote reconfiguration', async () => {
    let resolveFirst: (val: any) => void = () => {}
    let closedCount = 0
    let connectorIndex = 0

    const { database, repository, serverId, manager } = setup(() => {
      connectorIndex += 1
      const currentIndex = connectorIndex
      if (currentIndex === 1) {
        return connector({
          connect: () => new Promise((resolve) => { resolveFirst = resolve }),
          close: async () => { closedCount += 1 }
        })
      }
      return connector({
        connect: async () => ({ protocolEra: 'MODERN', protocolVersion: 'v2', serverInfo: { name: 'second', version: '2', title: null } }),
        close: async () => { closedCount += 1 }
      })
    })

    try {
      const firstPromise = manager.connect(serverId)
      repository.updateServer({ id: serverId, url: 'https://new-url.example.com/mcp' })

      const secondResult = await manager.connect(serverId)
      expect(secondResult.serverInfo?.name).toBe('second')
      expect(manager.state(serverId).status).toBe('CONNECTED')

      resolveFirst({ protocolEra: 'MODERN', protocolVersion: 'v1', serverInfo: { name: 'first', version: '1', title: null } })
      await firstPromise

      expect(closedCount).toBeGreaterThanOrEqual(1)
      expect(manager.state(serverId).serverInfo?.name).toBe('second')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })


  it('cancels pending OAuth authorization when normal connect or disconnectAll is called', async () => {
    let observedAbort = false
    let resolveAuth: (val: any) => void = () => {}
    const factory: McpRemoteConnectorFactory = () => connector({
      authorize: (signal) => new Promise((resolve, reject) => {
        resolveAuth = resolve
        signal?.addEventListener('abort', () => {
          observedAbort = true
          reject(signal.reason)
        })
      }),
      close: async () => {}
    })
    const { database, repository, serverId, manager } = setup(factory)
    try {
      repository.updateServer({ id: serverId, authMode: 'OAUTH' })
      const pendingAuth = manager.authorize(serverId)
      await new Promise((r) => setTimeout(r, 0))

      // 调用 disconnectAll，应当立即中止 OAuth
      await manager.disconnectAll()
      await expect(pendingAuth).rejects.toMatchObject({ name: 'AbortError' })
      expect(observedAbort).toBe(true)
      expect(manager.state(serverId).status).toBe('DISCONNECTED')
    } finally {
      database.close()
    }
  })

  it('prevents stale late OAuth authorization from reviving after server reconfigured', async () => {
    let resolveAuth: (val: any) => void = () => {}
    let closedCount = 0
    let connectorIndex = 0

    const { database, repository, serverId, manager } = setup(() => {
      connectorIndex += 1
      const idx = connectorIndex
      if (idx === 1) {
        return connector({
          authorize: () => new Promise((resolve) => { resolveAuth = resolve }),
          close: async () => { closedCount += 1 }
        })
      }
      return connector({
        connect: async () => ({ protocolEra: 'MODERN', protocolVersion: 'v2', serverInfo: { name: 'new-conn', version: '2', title: null } }),
        close: async () => { closedCount += 1 }
      })
    })

    try {
      repository.updateServer({ id: serverId, authMode: 'OAUTH' })
      const authPromise = manager.authorize(serverId)

      // 修改配置
      repository.updateServer({ id: serverId, authMode: 'NONE', url: 'https://other.example.com/mcp' })
      const newConnect = await manager.connect(serverId)
      expect(newConnect.serverInfo?.name).toBe('new-conn')
      expect(manager.state(serverId).status).toBe('CONNECTED')

      // 迟到的 OAuth 完成
      resolveAuth({ protocolEra: 'MODERN', protocolVersion: 'v1', serverInfo: { name: 'stale-oauth', version: '1', title: null } })
      await authPromise

      // 验证迟到 connector 被关闭，且没有覆盖新连接
      expect(closedCount).toBeGreaterThanOrEqual(1)
      expect(manager.state(serverId).serverInfo?.name).toBe('new-conn')
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })


  it('prevents delayed safeClose during markConnectionError from overwriting newer connection', async () => {
    let connectorIndex = 0
    let resolveOldClose: () => void = () => {}
    let newClosed = 0

    const { database, serverId, manager } = setup(() => {
      connectorIndex += 1
      if (connectorIndex === 1) {
        return connector({
          connect: async () => ({
            protocolEra: 'MODERN',
            protocolVersion: '2026-07-28',
            serverInfo: { name: 'old-remote', version: '1', title: null }
          }),
          callTool: async () => {
            throw Object.assign(new Error('old remote tool failure'), { code: 'ECONNRESET' })
          },
          close: () => new Promise<void>((resolve) => {
            resolveOldClose = resolve
          })
        })
      }
      return connector({
        connect: async () => ({
          protocolEra: 'MODERN',
          protocolVersion: '2026-07-28',
          serverInfo: { name: 'new-remote', version: '2', title: null }
        }),
        callTool: async () => ({ content: [{ type: 'text', text: 'new remote success' }] }),
        close: async () => {
          newClosed += 1
        }
      })
    })

    try {
      // 1. 先连接 old
      const firstConn = await manager.connect(serverId)
      expect(firstConn.serverInfo?.name).toBe('old-remote')
      expect(manager.state(serverId).status).toBe('CONNECTED')

      // 2. 触发 old 调用失败，进入 markConnectionError，使 old.close 挂起
      const oldCallPromise = manager.callTool(serverId, 'read', {})
      await new Promise((resolve) => setTimeout(resolve, 20))

      // 3. 在此期间 connect new 并等待 CONNECTED
      const newConn = await manager.connect(serverId)
      expect(newConn.serverInfo?.name).toBe('new-remote')
      expect(manager.state(serverId).status).toBe('CONNECTED')
      expect(manager.state(serverId).serverInfo?.name).toBe('new-remote')

      // 4. 再释放 old.close
      resolveOldClose()

      // 5. 断言 old 调用仍按原错误 reject
      await expect(oldCallPromise).rejects.toThrow('old remote tool failure')

      // 6. 断言 manager.state/serverInfo 与 active 仍属于 new 且 CONNECTED，new 未被 close
      expect(manager.state(serverId).status).toBe('CONNECTED')
      expect(manager.state(serverId).serverInfo?.name).toBe('new-remote')
      expect(newClosed).toBe(0)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })
})
describe('createMcpRemoteFetch security', () => {
  const lookup = async () => [{ address: '1.1.1.1' }]
  it.each(['http://auth.example.com/metadata', 'https://169.254.169.254/latest', 'https://127.0.0.1/metadata'])('rejects third-party discovery %s', async (target) => {
    let calls = 0
    const fetchImpl: typeof fetch = async () => { calls++; return new Response('ok') }
    const request = createMcpRemoteFetch('https://mcp.example.com/mcp', { timeoutMs: 1000, authMode: 'OAUTH', fetchImpl, lookup })
    await expect(request(target)).rejects.toThrow()
    expect(calls).toBe(0)
  })
  it('rejects discovery DNS resolving to private addresses', async () => {
    let calls = 0
    const request = createMcpRemoteFetch('https://mcp.example.com/mcp', { timeoutMs: 1000, authMode: 'OAUTH', fetchImpl: async () => { calls++; return new Response('ok') }, lookup: async () => [{ address: '10.0.0.1' }] })
    await expect(request('https://auth.example.com/metadata')).rejects.toThrow('DNS')
    expect(calls).toBe(0)
  })
  it('rejects authenticated public HTTP even on configured origins', async () => {
    const request = createMcpRemoteFetch('http://mcp.example.com/mcp', { timeoutMs: 1000, authMode: 'BEARER', lookup })
    await expect(request('http://mcp.example.com/mcp', { headers: { Authorization: 'secret' } })).rejects.toThrow('HTTPS')
  })
  it.each(['Authorization', 'X-Api-Key', 'X-Custom-Token'])('rejects cross-origin redirect with %s', async (name) => {
    let calls = 0
    const request = createMcpRemoteFetch('https://mcp.example.com/mcp', { timeoutMs: 1000, authMode: 'CUSTOM_HEADERS', customHeaderNames: ['X-Custom-Token'], lookup, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }) } })
    await expect(request('https://mcp.example.com/mcp', { headers: { [name]: 'secret' } })).rejects.toThrow('跨源')
    expect(calls).toBe(1)
  })
  it.each(['https://mcp.example.com/mcp', 'http://127.0.0.1:1234/mcp'])('allows same-origin redirects %s', async (url) => {
    let calls = 0
    const request = createMcpRemoteFetch(url, { timeoutMs: 0, authMode: 'OAUTH', lookup, fetchImpl: async (_input, init) => {
      expect(init?.redirect).toBe('manual')
      return ++calls === 1 ? new Response(null, { status: 307, headers: { location: '/next' } }) : new Response('ok')
    } })
    expect(await (await request(url, { headers: { Authorization: 'secret' } })).text()).toBe('ok')
    expect(calls).toBe(2)
  })
  it('preserves caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    const request = createMcpRemoteFetch('http://127.0.0.1/mcp', { timeoutMs: Infinity, authMode: 'NONE', fetchImpl: async (_input, init) => { init?.signal?.throwIfAborted(); return new Response('ok') } })
    await expect(request('http://127.0.0.1/mcp', { signal: controller.signal })).rejects.toThrow('caller cancelled')
  })
})


it.each([new DOMException('Cancelled', 'AbortError'), Object.assign(new Error('Invalid tool arguments'), { code: -32602 })])('preserves the connection after a single call fails: %s', async error => {
  const close = vi.fn(async () => {})
  const callTool = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ content: [], isError: true })
  const factory = vi.fn(() => connector({ callTool, close }))
  const { database, serverId, manager } = setup(factory)
  try {
    await expect(manager.callTool(serverId, 'tool', {})).rejects.toThrow(error.message)
    expect(manager.state(serverId).status).toBe('CONNECTED')
    expect(close).not.toHaveBeenCalled()
    expect(await manager.callTool(serverId, 'tool', {})).toEqual({ content: [], isError: true })
    expect(factory).toHaveBeenCalledOnce()
  } finally { await manager.disconnectAll(); database.close() }
})

it('clears the response-header timeout while an SSE body remains open and preserves cancellation', async () => {
  vi.useFakeTimers()
  const caller = new AbortController()
  let requestSignal: AbortSignal | null | undefined
  const fetcher = createMcpRemoteFetch('http://127.0.0.1/mcp', { timeoutMs: 60_000, authMode: 'NONE', fetchImpl: async (_url, init) => {
    requestSignal = init?.signal
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': open\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  try {
    const response = await fetcher('http://127.0.0.1/mcp', { method: 'GET', signal: caller.signal })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(requestSignal?.aborted).toBe(false)
    caller.abort()
    expect(requestSignal?.aborted).toBe(true)
    await response.body?.cancel()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
