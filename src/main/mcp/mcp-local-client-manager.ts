import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { MCP_STDIO_GUARDIAN_PATH } from './mcp-stdio-guardian-path'
import type {
  McpConnectionSnapshot,
  McpLocalServerHealthResult,
  McpLocalServerProfile,
  McpProtocolEra,
  McpServerIdentity
} from '../../shared/mcp'
import type { McpLocalRepository } from './mcp-local-repository'

const HEALTH_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const MAX_STDERR_TAIL_CHARS = 16_384
const MAX_STDIO_BUFFER_BYTES = 10 * 1024 * 1024

interface McpLocalConnectorInfo {
  protocolEra: McpProtocolEra
  protocolVersion: string | null
  serverInfo: McpServerIdentity | null
}

export interface McpLocalConnector {
  connect(signal?: AbortSignal): Promise<McpLocalConnectorInfo>
  listTools(signal?: AbortSignal): Promise<{ tools: unknown[] }>
  callTool(name: string, argumentsValue: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}

export type McpLocalConnectorFactory = (
  server: McpLocalServerProfile,
  options: { requestTimeoutMs: number }
) => McpLocalConnector

interface ActiveConnection {
  fingerprint: string
  connector: McpLocalConnector
  snapshot: McpConnectionSnapshot
}

export class McpLocalClientManager {
  private readonly active = new Map<string, ActiveConnection>()
  private readonly states = new Map<string, McpConnectionSnapshot>()

  constructor(
    private readonly repository: McpLocalRepository,
    private readonly connectorFactory: McpLocalConnectorFactory
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
    await assertWorkingDirectory(server)
    const fingerprint = catalogFingerprint(this.repository, server.id)
    const existing = this.active.get(server.id)
    if (existing?.fingerprint === fingerprint && existing.snapshot.status === 'CONNECTED') return existing.snapshot
    if (existing) await this.disconnect(server.id)

    this.setState({ ...disconnectedState(server.id), status: 'CONNECTING', updatedAt: Date.now() })
    const connector = this.connectorFactory(server, { requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS })
    try {
      const info = await connector.connect(AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS))
      const snapshot = connectedState(server.id, info)
      this.active.set(server.id, { fingerprint, connector, snapshot })
      this.setState(snapshot)
      return snapshot
    } catch (error) {
      await safeClose(connector)
      this.setErrorState(server.id, error)
      throw error
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const id = serverId.trim()
    const existing = this.active.get(id)
    this.active.delete(id)
    if (existing) await safeClose(existing.connector)
    this.setState(disconnectedState(id))
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map((id) => this.disconnect(id)))
  }

  async invalidate(serverId: string): Promise<void> {
    await this.disconnect(serverId)
  }

  async listTools(serverId: string, signal?: AbortSignal): Promise<{ tools: unknown[] }> {
    const connection = await this.ensureConnection(serverId)
    try {
      return await connection.connector.listTools(signal)
    } catch (error) {
      await this.markConnectionError(serverId, error)
      throw error
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
      await this.markConnectionError(serverId, error)
      throw error
    }
  }

  async checkHealth(serverId: string): Promise<McpLocalServerHealthResult> {
    const server = this.repository.requireConfiguredServer(serverId)
    await assertWorkingDirectory(server)
    const connector = this.connectorFactory(server, { requestTimeoutMs: HEALTH_REQUEST_TIMEOUT_MS })
    const startedAt = performance.now()
    try {
      const signal = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
      const info = await connector.connect(signal)
      const result = await connector.listTools(signal)
      return {
        serverId: server.id,
        serverName: server.name,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        protocolEra: info.protocolEra,
        protocolVersion: info.protocolVersion,
        serverInfo: info.serverInfo,
        toolCount: result.tools.length
      }
    } finally {
      await safeClose(connector)
    }
  }

  private async ensureConnection(serverId: string): Promise<ActiveConnection> {
    const server = this.repository.requireConfiguredServer(serverId)
    const fingerprint = catalogFingerprint(this.repository, server.id)
    const existing = this.active.get(server.id)
    if (existing?.fingerprint === fingerprint && existing.snapshot.status === 'CONNECTED') return existing
    await this.connect(server.id)
    const connected = this.active.get(server.id)
    if (!connected) throw new Error(`本地 MCP 连接建立失败：${server.name}`)
    return connected
  }

  private async markConnectionError(serverId: string, error: unknown): Promise<void> {
    const id = serverId.trim()
    const existing = this.active.get(id)
    this.active.delete(id)
    if (existing) await safeClose(existing.connector)
    this.setErrorState(id, error)
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

export function createSdkMcpLocalConnectorFactory(
  clientName: string,
  clientVersion: string,
  repository: McpLocalRepository
): McpLocalConnectorFactory {
  const normalizedClientName = clientName.trim() || 'OrigRead Desktop'
  const normalizedClientVersion = clientVersion.trim() || '0.0.0'
  return (server, options) => {
    let client: Client | null = null
    let transport: StdioClientTransport | null = null
    let stderrTail = ''

    const closeCurrent = async (): Promise<void> => {
      const closingClient = client
      const closingTransport = transport
      client = null
      transport = null
      if (closingClient) {
        try { await closingClient.close() } catch { /* best effort */ }
      } else if (closingTransport) {
        try { await closingTransport.close() } catch { /* best effort */ }
      }
    }

    const connect = async (signal?: AbortSignal): Promise<McpLocalConnectorInfo> => {
      await closeCurrent()
      stderrTail = ''
      const environment = {
        ...getDefaultEnvironment(),
        ...repository.runtimeEnvironment(server.id)
      }
      const childElectronRunAsNode = environment.ELECTRON_RUN_AS_NODE ?? ''
      const nextTransport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_STDIO_GUARDIAN_PATH, String(process.pid), server.command, ...server.args],
        ...(server.cwd ? { cwd: server.cwd } : {}),
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: '1',
          ORIGREAD_MCP_CHILD_ELECTRON_RUN_AS_NODE: childElectronRunAsNode
        },
        stderr: 'pipe',
        maxBufferSize: MAX_STDIO_BUFFER_BYTES
      })
      nextTransport.stderr?.on('data', (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        stderrTail = tail(`${stderrTail}${text}`, MAX_STDERR_TAIL_CHARS)
      })
      const nextClient = new Client(
        { name: normalizedClientName, version: normalizedClientVersion },
        { versionNegotiation: { mode: 'auto' }, listMaxPages: 64 }
      )
      client = nextClient
      transport = nextTransport
      try {
        await withAbort(nextClient.connect(nextTransport), signal, options.requestTimeoutMs)
        return connectorInfo(nextClient)
      } catch (error) {
        const detail = stderrTail.trim()
        await closeCurrent()
        if (detail) throw new Error(`${errorMessage(error)}\n\nServer stderr:\n${detail}`)
        throw error
      }
    }

    return {
      connect,
      async listTools(signal) {
        if (!client) throw new Error('本地 MCP 尚未连接')
        const result = await client.listTools(undefined, requestOptions(signal, options.requestTimeoutMs))
        return { tools: result.tools }
      },
      async callTool(name, argumentsValue, signal) {
        if (!client) throw new Error('本地 MCP 尚未连接')
        return client.callTool(
          { name: name.trim(), arguments: argumentsValue },
          requestOptions(signal, options.requestTimeoutMs)
        )
      },
      close: closeCurrent
    }
  }
}

async function assertWorkingDirectory(server: McpLocalServerProfile): Promise<void> {
  if (!server.cwd) return
  let info
  try { info = await stat(server.cwd) } catch { throw new Error(`本地 MCP 工作目录不存在：${server.cwd}`) }
  if (!info.isDirectory()) throw new Error(`本地 MCP 工作目录不是文件夹：${server.cwd}`)
}

function requestOptions(signal: AbortSignal | undefined, timeoutMs: number): { requestSignal: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs)
  return { requestSignal: signal ? AbortSignal.any([signal, timeout]) : timeout }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (combined.aborted) throw combined.reason
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => combined.addEventListener('abort', () => reject(combined.reason), { once: true }))
  ])
}

function connectorInfo(client: Client): McpLocalConnectorInfo {
  const era = client.getProtocolEra()
  if (era !== 'modern' && era !== 'legacy') throw new Error('MCP Server 未返回可识别的协议版本')
  return {
    protocolEra: era === 'modern' ? 'MODERN' : 'LEGACY',
    protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
    serverInfo: normalizeServerInfo(client.getServerVersion())
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

function connectedState(serverId: string, info: McpLocalConnectorInfo): McpConnectionSnapshot {
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

function catalogFingerprint(repository: McpLocalRepository, serverId: string): string {
  return repository.requireCatalogServer(serverId).fingerprint
}

async function safeClose(connector: McpLocalConnector): Promise<void> {
  try { await connector.close() } catch { /* connection teardown must not mask primary failure */ }
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
