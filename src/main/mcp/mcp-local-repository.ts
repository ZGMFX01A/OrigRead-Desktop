import { rollbackSettingsAndSecrets } from '../storage/settings-rollback'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { McpBackup } from '../../shared/configuration-backup'
import type {
  McpLocalServerPatch,
  McpLocalServerProfile,
  McpLocalSettings
} from '../../shared/mcp'
import type { SecretStore } from '../security/secret-store'
import type { McpCatalogServerProfile, McpToolCatalogRegistry } from './mcp-tool-catalog-service'

const SETTINGS_KEY = 'llm.mcp.local'
const MAX_SERVER_COUNT = 100
const MAX_SERVER_NAME_LENGTH = 80
const MAX_COMMAND_LENGTH = 2_048
const MAX_ARG_COUNT = 128
const MAX_ARG_LENGTH = 8_192
const MAX_CWD_LENGTH = 4_096
const MAX_ENV_LINES = 128
const MAX_ENV_VALUE_LENGTH = 16_384

interface StoredMcpLocalServerProfile {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  cwd: string
}

interface StoredMcpLocalSettings {
  servers: StoredMcpLocalServerProfile[]
}

export class McpLocalRepository implements McpToolCatalogRegistry {
  constructor(private readonly database: DatabaseSync, private readonly secrets: SecretStore) {}

  current(): McpLocalSettings {
    const stored = normalizeSettings(this.read())
    return { servers: stored.servers.map((server) => this.toPublic(server)) }
  }

  addServer(): McpLocalSettings {
    const current = this.toStored(this.current())
    if (current.servers.length >= MAX_SERVER_COUNT) throw new Error(`本地 MCP Server 最多 ${MAX_SERVER_COUNT} 个`)
    const server: StoredMcpLocalServerProfile = {
      id: `local-${randomUUID()}`,
      name: `Local MCP ${current.servers.length + 1}`,
      enabled: false,
      command: '',
      args: [],
      cwd: ''
    }
    return this.save({ servers: [...current.servers, server] })
  }

  updateServer(patch: McpLocalServerPatch): McpLocalSettings {
    const current = this.toStored(this.current())
    const existing = current.servers.find((server) => server.id === patch.id.trim())
    if (!existing) throw new Error('本地 MCP Server 不存在')
    const updated = normalizeServer({
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.command === undefined ? {} : { command: patch.command }),
      ...(patch.args === undefined ? {} : { args: patch.args }),
      ...(patch.cwd === undefined ? {} : { cwd: patch.cwd })
    })
    if (patch.environment !== undefined) parseMcpLocalEnvironment(patch.environment)
    const secretSnapshot = this.secrets.snapshot()
    this.database.exec('SAVEPOINT mcp_local_update')
    try {
      if (patch.environment !== undefined) this.secrets.put(environmentSecretKey(existing.id), normalizeEnvironmentText(patch.environment))
      const result = this.save({ servers: current.servers.map((server) => server.id === updated.id ? updated : server) })
      this.database.exec('RELEASE SAVEPOINT mcp_local_update')
      return result
    } catch (error) {
      rollbackSettingsAndSecrets(this.database, 'mcp_local_update', this.secrets, secretSnapshot, error)
    }
  }

  removeServer(serverId: string): McpLocalSettings {
    const id = serverId.trim()
    this.secrets.delete(environmentSecretKey(id))
    const current = this.toStored(this.current())
    return this.save({ servers: current.servers.filter((server) => server.id !== id) })
  }

  getServer(serverId: string): McpLocalServerProfile | null {
    const id = serverId.trim()
    return this.current().servers.find((server) => server.id === id) ?? null
  }

  requireConfiguredServer(serverId: string): McpLocalServerProfile {
    const server = this.getServer(serverId)
    if (!server) throw new Error('本地 MCP Server 不存在')
    if (!server.enabled) throw new Error(`本地 MCP Server 已停用：${server.name}`)
    if (!server.command) throw new Error(`本地 MCP Server 尚未配置可执行程序：${server.name}`)
    assertSafeLocalCommand(server.command, server.args)
    return server
  }

  getEnvironment(serverId: string): string {
    return this.secrets.get(environmentSecretKey(serverId.trim()))
  }

  runtimeEnvironment(serverId: string): Record<string, string> {
    return parseMcpLocalEnvironment(this.getEnvironment(serverId))
  }

  currentCatalogServers(): McpCatalogServerProfile[] {
    return this.current().servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      fingerprint: localCatalogFingerprint(server, this.getEnvironment(server.id))
    }))
  }

  requireCatalogServer(serverId: string): McpCatalogServerProfile {
    const server = this.requireConfiguredServer(serverId)
    return {
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      fingerprint: localCatalogFingerprint(server, this.getEnvironment(server.id))
    }
  }

  exportBackupState(): McpBackup['local'] {
    return structuredClone(this.toStored(this.current()))
  }

  exportBackupEnvironments(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const server of this.current().servers) {
      const environment = this.getEnvironment(server.id)
      if (environment) result[server.id] = environment
    }
    return result
  }

  validateBackupState(value: McpBackup['local'], environments?: Record<string, string>): void {
    const normalized = normalizeBackupSettings(value)
    validateBackupEnvironments(normalized, environments)
  }

  restoreBackupState(value: McpBackup['local'], environments?: Record<string, string>): McpLocalSettings {
    const normalized = normalizeBackupSettings(value)
    validateBackupEnvironments(normalized, environments)
    const idsToClear = new Set([
      ...this.current().servers.map((server) => server.id),
      ...normalized.servers.map((server) => server.id)
    ])
    for (const id of idsToClear) this.secrets.delete(environmentSecretKey(id))
    this.save({ servers: normalized.servers.map((server) => ({ ...server, enabled: false })) })
    for (const [serverId, environment] of Object.entries(environments ?? {})) {
      if (environment) this.secrets.put(environmentSecretKey(serverId), normalizeEnvironmentText(environment))
    }
    return this.current()
  }

  private toPublic(server: StoredMcpLocalServerProfile): McpLocalServerProfile {
    const key = environmentSecretKey(server.id)
    const hasEnvironment = this.secrets.contains(key) && this.secrets.get(key).length > 0
    return {
      ...server,
      args: [...server.args],
      hasEnvironment,
      environmentLength: hasEnvironment ? this.secrets.get(key).length : 0
    }
  }

  private toStored(settings: McpLocalSettings): StoredMcpLocalSettings {
    return {
      servers: settings.servers.map(({ hasEnvironment: _hasEnvironment, environmentLength: _environmentLength, ...server }) => ({
        ...server,
        args: [...server.args]
      }))
    }
  }

  private save(settings: StoredMcpLocalSettings): McpLocalSettings {
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
}

export function parseMcpLocalEnvironment(value: string): Record<string, string> {
  const normalized = normalizeEnvironmentText(value)
  if (!normalized) return {}
  const lines = normalized.split('\n')
  if (lines.length > MAX_ENV_LINES) throw new Error(`环境变量最多 ${MAX_ENV_LINES} 行`)
  const result: Record<string, string> = {}
  for (const line of lines) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error('环境变量格式应为 KEY=VALUE')
    const name = line.slice(0, separator).trim()
    const envValue = line.slice(separator + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`环境变量名称无效：${name}`)
    if (isBlockedMcpEnvironmentName(name)) throw new Error(`不允许覆盖高危环境变量：${name}`)
    if (envValue.length > MAX_ENV_VALUE_LENGTH || envValue.includes('\0')) throw new Error(`环境变量值过长或无效：${name}`)
    result[name] = envValue
  }
  return result
}

const BLOCKED_ENVIRONMENT_NAMES = new Set([
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'NODE_REDIRECT_WARNINGS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH', 'DYLD_FORCE_FLAT_NAMESPACE', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
  'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'COMSPEC', 'PATHEXT', 'PATH', 'SYSTEMROOT', 'WINDIR'
])

export function isBlockedMcpEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase()
  return BLOCKED_ENVIRONMENT_NAMES.has(upper)
    || ['ORIGREAD_MCP_', 'LD_', 'DYLD_', 'ELECTRON_'].some((prefix) => upper.startsWith(prefix))
}

const OPTIONS_WITH_VALUE = new Set(['--prefix', '-C', '--dir', '--cwd', '--userconfig', '--config', '--cache', '--registry', '-p', '--package', '--workspace', '-w', '--filter', '-F', '--directory'])
const COMMAND_SWITCHES = new Set(['--quiet', '-q', '--silent', '-s', '--verbose', '-v', '--offline', '--prefer-offline', '--global', '-g', '--force', '-f', '--ignore-scripts', '--help', '-h', '--version', '--no-progress'])

function leadingCommandOptions(args: readonly string[], blockedSubcommands: readonly string[]): { options: string[]; subcommand: string | undefined } {
  const options: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') return { options, subcommand: args[index + 1] }
    if (!arg.startsWith('-') || arg === '-') return { options, subcommand: arg }
    options.push(arg)
    if (OPTIONS_WITH_VALUE.has(arg)) {
      const value = args[++index]
      if (!value || value.startsWith('-')) throw new Error('本地 MCP 命令选项缺少明确的值')
      // 不同包管理器的短选项含义可能不同，不能让值位置隐藏危险子命令。
      if (blockedSubcommands.includes(value.trim().toLowerCase())) throw new Error('本地 MCP 命令选项包含危险子命令')
    } else if (!arg.includes('=') && !COMMAND_SWITCHES.has(arg)) {
      // 无法确认未知选项是否吞掉下一位置参数时，不能猜测子命令并放行。
      throw new Error(`本地 MCP 命令选项未经允许：${arg}`)
    }
  }
  return { options, subcommand: undefined }
}

function hasSafeNpxOptions(args: readonly string[]): boolean {
  // 参数必须保持原文。npx 将 --no-install 改写为 --yes=false，其他 yes 形式可覆盖它。
  const valueOptions = new Set(['--prefix', '-C', '--dir', '--cwd', '--userconfig', '--config', '--cache', '--registry', '-p', '--package'])
  const switches = new Set(['--quiet', '-q', '--offline', '--prefer-offline'])
  let noInstall = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--' || !arg.startsWith('-') || arg === '-') break
    if (arg === '--no-install') { noInstall = true; continue }
    if (switches.has(arg)) continue
    const separator = arg.indexOf('=')
    const name = separator < 0 ? arg : arg.slice(0, separator)
    if (!valueOptions.has(name)) return false
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1)
    // 不把另一个选项误当作值跳过，避免隐藏后续 --yes/-y。
    if (!value || value.startsWith('-')) return false
  }
  return noInstall
}

export function assertSafeLocalCommand(command: string, args: readonly string[]): void {
  const normalizedCommand = normalizeCommand(command)
  if (!normalizedCommand) throw new Error('本地 MCP 可执行程序不能为空')
  const executable = basename(normalizedCommand.replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '')
  const blockedShells = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'wscript', 'cscript', 'mshta'])
  if (blockedShells.has(executable)) {
    throw new Error('本地 MCP 不允许通过 Shell 启动。请直接填写服务器可执行程序和独立参数。')
  }
  // 只承认目标包之前的选项，包名之后的参数不能为启动器授权。
  if (executable === 'npx' && !hasSafeNpxOptions(args)) {
    throw new Error('为避免自动下载软件包，npx 仅允许配合 --no-install 使用且禁止 -y/--yes')
  }
  if (['bunx', 'uvx', 'corepack'].includes(executable)) {
    throw new Error(`不允许使用可能自动获取软件包的命令：${executable}`)
  }
  const blockedSubcommands: Record<string, string[]> = {
    npm: ['exec', 'x', 'i', 'install', 'add', 'init', 'create'],
    pnpm: ['dlx', 'exec', 'create', 'init', 'install', 'i', 'add'],
    yarn: ['dlx', 'create', 'install', 'add'],
    pipx: ['run', 'install'],
    uv: ['tool', 'x']
  }
  const blocked = blockedSubcommands[executable]
  if (!blocked) return
  const { subcommand } = leadingCommandOptions(args, blocked)
  if (!subcommand && executable === 'yarn') throw new Error('不允许使用 yarn 默认安装依赖')
  if (subcommand && blocked.includes(subcommand.trim().toLowerCase())) {
    throw new Error(`不允许使用 ${executable} ${subcommand} 自动获取 MCP Server`)
  }
}

function normalizeSettings(value: unknown): StoredMcpLocalSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { servers: [] }
  const record = value as { servers?: unknown }
  const seen = new Set<string>()
  const servers = Array.isArray(record.servers)
    ? record.servers.flatMap((item) => {
        try {
          const server = normalizeServer(item)
          if (seen.has(server.id) || seen.size >= MAX_SERVER_COUNT) return []
          seen.add(server.id)
          return [server]
        } catch { return [] }
      })
    : []
  return { servers }
}

function normalizeBackupSettings(value: unknown): StoredMcpLocalSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份中的本地 MCP 配置无效')
  const record = value as { servers?: unknown }
  if (!Array.isArray(record.servers) || record.servers.length > MAX_SERVER_COUNT) throw new Error('备份中的本地 MCP Server 列表无效')
  const ids = new Set<string>()
  const servers = record.servers.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('备份包含无效本地 MCP Server')
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || !raw.id.trim()) throw new Error('备份包含无效本地 MCP Server ID')
    if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('备份包含无效本地 MCP Server 名称')
    if (typeof raw.enabled !== 'boolean' || typeof raw.command !== 'string' || !Array.isArray(raw.args) || typeof raw.cwd !== 'string') throw new Error('备份包含无效本地 MCP Server 配置')
    const server = normalizeServer(raw)
    if (ids.has(server.id)) throw new Error(`备份包含重复本地 MCP Server：${server.id}`)
    ids.add(server.id)
    return server
  })
  return { servers }
}

function validateBackupEnvironments(settings: StoredMcpLocalSettings, environments: Record<string, string> | undefined): void {
  const servers = new Set(settings.servers.map((server) => server.id))
  for (const [serverId, environment] of Object.entries(environments ?? {})) {
    if (!servers.has(serverId)) throw new Error('本地 MCP 环境变量引用了不存在的 Server')
    if (typeof environment !== 'string' || !environment.trim() || environment.length > MAX_ENV_LINES * (MAX_ENV_VALUE_LENGTH + 256) || environment.includes('\0')) throw new Error('备份中的本地 MCP 环境变量无效')
    parseMcpLocalEnvironment(environment)
  }
}

function normalizeServer(value: unknown): StoredMcpLocalServerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地 MCP Server 配置无效')
  const record = value as Partial<StoredMcpLocalServerProfile>
  const id = typeof record.id === 'string' ? record.id.trim().slice(0, 512) : ''
  if (!id) throw new Error('本地 MCP Server ID 不能为空')
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_SERVER_NAME_LENGTH) : ''
  const command = normalizeCommand(typeof record.command === 'string' ? record.command : '')
  const args = normalizeArgs(record.args)
  const cwd = normalizeCwd(typeof record.cwd === 'string' ? record.cwd : '')
  // Invalid/incomplete commands may remain saved while disabled so the UI can explain/fix them,
  // but enabling is the explicit trust boundary and therefore requires a runnable safe command.
  if (record.enabled === true) {
    if (!command) throw new Error('启用本地 MCP 前必须填写可执行程序')
    assertSafeLocalCommand(command, args)
  }
  return { id, name: name || 'Local MCP', enabled: record.enabled === true, command, args, cwd }
}

function normalizeCommand(value: string): string {
  const command = value.trim().slice(0, MAX_COMMAND_LENGTH)
  if (/[\0\r\n]/.test(command)) throw new Error('本地 MCP 可执行程序包含无效字符')
  return command
}

function normalizeArgs(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ARG_COUNT) throw new Error(`本地 MCP 参数最多 ${MAX_ARG_COUNT} 个`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('本地 MCP 参数必须是字符串')
    if (item.length > MAX_ARG_LENGTH || /[\0\r\n]/.test(item)) throw new Error('本地 MCP 参数过长或包含无效字符')
    return item
  })
}

function normalizeCwd(value: string): string {
  const cwd = value.trim().slice(0, MAX_CWD_LENGTH)
  if (!cwd) return ''
  if (/[\0\r\n]/.test(cwd)) throw new Error('工作目录包含无效字符')
  if (!isAbsolute(cwd)) throw new Error('工作目录必须使用绝对路径')
  return cwd
}

function normalizeEnvironmentText(value: string): string {
  if (value.includes('\0')) throw new Error('环境变量包含无效字符')
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function environmentSecretKey(serverId: string): string {
  return `mcp:local:${serverId}:environment`
}

function localCatalogFingerprint(server: Pick<McpLocalServerProfile, 'command' | 'args' | 'cwd'>, environment: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['STDIO', server.command, server.args, server.cwd, environment]))
    .digest('hex')
}
