import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import type { McpLocalConnector, McpLocalConnectorFactory } from './mcp-local-client-manager'
import { buildGuardianLaunchEnvironment, McpLocalClientManager } from './mcp-local-client-manager'
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

  it('merges concurrent connect calls for the same server and creates only one connector', async () => {
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
      resolveConnect({ protocolEra: 'MODERN', protocolVersion: '2026-07-28', serverInfo: { name: 'local', version: '1', title: null } })
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

  it('closes connector and leaves no active connection when disconnected during connect', async () => {
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

  it('disconnectAll handles in-flight connections properly', async () => {
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

  it('prevents stale late-resolving connect from reviving after reconfiguration', async () => {
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
      repository.updateServer({ id: serverId, args: ['new-arg.js'] })

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

  it('allows reconnecting after failure and cleans up error state', async () => {
    let attempts = 0
    const { database, serverId, manager } = setup(() => {
      attempts += 1
      if (attempts === 1) {
        return connector({
          connect: async () => { throw new Error('First attempt network fail') }
        })
      }
      return connector({
        connect: async () => ({ protocolEra: 'MODERN', protocolVersion: 'v2', serverInfo: { name: 'retry', version: '2', title: null } })
      })
    })

    try {
      await expect(manager.connect(serverId)).rejects.toThrow('First attempt network fail')
      expect(manager.state(serverId).status).toBe('ERROR')

      const second = await manager.connect(serverId)
      expect(second.status).toBe('CONNECTED')
      expect(second.serverInfo?.name).toBe('retry')
      expect(manager.state(serverId).status).toBe('CONNECTED')
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
            serverInfo: { name: 'old-server', version: '1', title: null }
          }),
          callTool: async () => {
            throw new Error('old tool execution failure')
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
          serverInfo: { name: 'new-server', version: '2', title: null }
        }),
        callTool: async () => ({ content: [{ type: 'text', text: 'new success' }] }),
        close: async () => {
          newClosed += 1
        }
      })
    })

    try {
      // 1. 先连接 old
      const firstConn = await manager.connect(serverId)
      expect(firstConn.serverInfo?.name).toBe('old-server')
      expect(manager.state(serverId).status).toBe('CONNECTED')

      // 2. 触发 old 调用失败，进入 markConnectionError，使 old.close 挂起
      const oldCallPromise = manager.callTool(serverId, 'read', {})
      await new Promise((resolve) => setTimeout(resolve, 20))

      // 3. 在此期间 connect new 并等待 CONNECTED
      const newConn = await manager.connect(serverId)
      expect(newConn.serverInfo?.name).toBe('new-server')
      expect(manager.state(serverId).status).toBe('CONNECTED')
      expect(manager.state(serverId).serverInfo?.name).toBe('new-server')

      // 4. 再释放 old.close
      resolveOldClose()

      // 5. 断言 old 调用仍按原错误 reject
      await expect(oldCallPromise).rejects.toThrow('old tool execution failure')

      // 6. 断言 manager.state/serverInfo 与 active 仍属于 new 且 CONNECTED，new 未被 close
      expect(manager.state(serverId).status).toBe('CONNECTED')
      expect(manager.state(serverId).serverInfo?.name).toBe('new-server')
      expect(newClosed).toBe(0)
    } finally {
      await manager.disconnectAll()
      database.close()
    }
  })
})

describe('guardian environment isolation', () => {
  it('places user variables only inside the child JSON and cleans inherited control keys', () => {
    const environment = buildGuardianLaunchEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', ORIGREAD_MCP_ATTACK: 'bad', origread_mcp_other: 'bad', NODE_OPTIONS: 'bad' }, { API_TOKEN: 'secret', MODE: 'test' })
    expect(environment).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', ORIGREAD_MCP_CHILD_ENV_JSON: JSON.stringify({ API_TOKEN: 'secret', MODE: 'test' }) })
    expect(environment.API_TOKEN).toBeUndefined()
    expect(environment.MODE).toBeUndefined()
    for (const name of ['NODE_OPTIONS', 'node_options', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'ELECTRON_RUN_AS_NODE', 'ORIGREAD_MCP_CHILD_ENV_JSON']) expect(() => buildGuardianLaunchEnvironment({}, { [name]: 'bad' })).toThrow('高危环境变量')
  })
  it('runs the real guardian with safe user values but no internal flags or injected runtime controls', async () => {
    const environment = buildGuardianLaunchEnvironment({ PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }, { SAFE_USER_TOKEN: 'guardian-test' })
    // 模拟绕过管理器直接调用 Guardian：子进程仍需过滤高危 JSON 键。
    environment.ORIGREAD_MCP_CHILD_ENV_JSON = JSON.stringify({ SAFE_USER_TOKEN: 'guardian-test', NODE_OPTIONS: '--invalid-option', ELECTRON_RUN_AS_NODE: 'evil', ORIGREAD_MCP_ATTACK: 'evil', PATH: 'evil' })
    const child = spawn(process.execPath, [path.resolve('src/main/mcp/mcp-stdio-guardian.cjs'), String(process.pid), process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
        timer = setTimeout(() => { child.kill(); reject(new Error('guardian test timed out')) }, 5000)
      })
      expect(code, stderr).toBe(0)
      const received = JSON.parse(stdout)
      expect(received.SAFE_USER_TOKEN).toBe('guardian-test')
      for (const name of ['ELECTRON_RUN_AS_NODE', 'ORIGREAD_MCP_CHILD_ENV_JSON', 'ORIGREAD_MCP_ATTACK', 'NODE_OPTIONS']) expect(received[name]).toBeUndefined()
      expect(received.PATH).not.toBe('evil')
    } finally {
      clearTimeout(timer)
      child.stdin.destroy()
      if (child.exitCode === null) child.kill()
    }
  })
  it('resolves Windows taskkill from an absolute system root with a safe fallback', () => {
    const source = readFileSync('src/main/mcp/mcp-stdio-guardian.cjs', 'utf8')
    const definition = source.match(/function resolveWindowsTaskkillPath\(\) \{[\s\S]*?\n\}/)![0]
    const resolve = (env: Record<string, string>): string => runInNewContext(`${definition}; resolveWindowsTaskkillPath()`, { path, process: { env } })
    expect(resolve({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe')
    expect(resolve({ WINDIR: 'E:\\Windows' })).toBe('E:\\Windows\\System32\\taskkill.exe')
    expect(resolve({ SystemRoot: 'relative' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(resolve({})).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(source).toContain('spawnSync(resolveWindowsTaskkillPath(),')
  })
})
