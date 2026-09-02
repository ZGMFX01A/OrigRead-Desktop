import type { McpToolCallSource } from './mcp-tool-runtime-bridge'
import type { McpCatalogServerProfile, McpToolCatalogRegistry, McpToolListSource } from './mcp-tool-catalog-service'
import type { McpLocalClientManager } from './mcp-local-client-manager'
import type { McpLocalRepository } from './mcp-local-repository'
import type { McpRemoteClientManager } from './mcp-remote-client-manager'
import type { McpRemoteRepository } from './mcp-remote-repository'

/**
 * One routing surface for the shared catalog and ToolRuntime. Transport-specific
 * repositories/managers remain isolated; server IDs decide which transport owns a call.
 */
export class McpCombinedRuntime implements McpToolCatalogRegistry, McpToolListSource, McpToolCallSource {
  constructor(
    private readonly remoteRepository: McpRemoteRepository,
    private readonly remoteClient: McpRemoteClientManager,
    private readonly localRepository: McpLocalRepository,
    private readonly localClient: McpLocalClientManager
  ) {}

  currentCatalogServers(): McpCatalogServerProfile[] {
    const servers = [
      ...this.remoteRepository.currentCatalogServers(),
      ...this.localRepository.currentCatalogServers()
    ]
    const seen = new Set<string>()
    for (const server of servers) {
      if (seen.has(server.id)) throw new Error(`MCP Server ID 冲突：${server.id}`)
      seen.add(server.id)
    }
    return servers
  }

  requireCatalogServer(serverId: string): McpCatalogServerProfile {
    const id = serverId.trim()
    if (this.localRepository.getServer(id)) return this.localRepository.requireCatalogServer(id)
    return this.remoteRepository.requireCatalogServer(id)
  }

  listTools(serverId: string, signal?: AbortSignal): Promise<{ tools: unknown[] }> {
    const id = serverId.trim()
    return this.localRepository.getServer(id)
      ? this.localClient.listTools(id, signal)
      : this.remoteClient.listTools(id, signal)
  }

  callTool(
    serverId: string,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const id = serverId.trim()
    return this.localRepository.getServer(id)
      ? this.localClient.callTool(id, name, argumentsValue, signal)
      : this.remoteClient.callTool(id, name, argumentsValue, signal)
  }
}
