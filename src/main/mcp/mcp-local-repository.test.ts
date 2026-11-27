import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { assertSafeLocalCommand, isBlockedMcpEnvironmentName, parseMcpLocalEnvironment, McpLocalRepository } from './mcp-local-repository'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)')
  const secrets = new MemorySecretStore()
  return { database, secrets, repository: new McpLocalRepository(database, secrets) }
}

describe('McpLocalRepository', () => {
  it('stores command/args/cwd publicly but keeps environment values only in SecretStore', () => {
    const { database, repository } = setup()
    try {
      const created = repository.addServer().servers[0]!
      const cwd = resolve('mcp')
      const updated = repository.updateServer({
        id: created.id,
        command: 'node',
        args: ['server.js', '--stdio'],
        cwd,
        environment: 'API_TOKEN=secret-value\nMODE=test'
      })
      expect(updated.servers[0]).toMatchObject({
        command: 'node', args: ['server.js', '--stdio'], cwd, hasEnvironment: true
      })
      expect(JSON.stringify(updated)).not.toContain('secret-value')
      expect(repository.getEnvironment(created.id)).toBe('API_TOKEN=secret-value\nMODE=test')
      expect(repository.runtimeEnvironment(created.id)).toEqual({ API_TOKEN: 'secret-value', MODE: 'test' })
    } finally { database.close() }
  })

  it('changes the catalog fingerprint when process config or secret environment changes', () => {
    const { database, repository } = setup()
    try {
      const created = repository.addServer().servers[0]!
      repository.updateServer({ id: created.id, command: 'node', args: ['a.js'], environment: 'A=1' })
      const first = repository.currentCatalogServers().find((server) => server.id === created.id)!.fingerprint
      repository.updateServer({ id: created.id, environment: 'A=2' })
      const second = repository.currentCatalogServers().find((server) => server.id === created.id)!.fingerprint
      repository.updateServer({ id: created.id, args: ['b.js'] })
      const third = repository.currentCatalogServers().find((server) => server.id === created.id)!.fingerprint
      expect(second).not.toBe(first)
      expect(third).not.toBe(second)
    } finally { database.close() }
  })

  it('rejects shell launchers and package runners that may download a server', () => {
    expect(() => assertSafeLocalCommand('cmd.exe', ['/c', 'server'])).toThrow('Shell')
    expect(() => assertSafeLocalCommand('powershell', ['-Command', 'server'])).toThrow('Shell')
    expect(() => assertSafeLocalCommand('npx', ['some-mcp-server'])).toThrow('--no-install')
    expect(() => assertSafeLocalCommand('npx', ['--no-install', 'some-mcp-server'])).not.toThrow()
    expect(() => assertSafeLocalCommand('pnpm', ['dlx', 'some-mcp-server'])).toThrow('pnpm dlx')
    expect(() => assertSafeLocalCommand('bunx', ['some-mcp-server'])).toThrow('自动获取')
  })

  it('validates argument/environment/cwd boundaries before saving', () => {
    const { database, repository } = setup()
    try {
      const created = repository.addServer().servers[0]!
      expect(() => repository.updateServer({ id: created.id, cwd: 'relative/path' })).toThrow('绝对路径')
      expect(() => repository.updateServer({ id: created.id, args: ['ok\nbad'] })).toThrow('无效字符')
      expect(() => repository.updateServer({ id: created.id, environment: 'BAD-NAME=value' })).toThrow('名称无效')
    } finally { database.close() }
  })
})


describe('local MCP launch boundaries', () => {
  it.each(['NODE_OPTIONS', 'node_options', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'NODE_REDIRECT_WARNINGS', 'LD_PRELOAD', 'LD_AUDIT', 'LD_CUSTOM', 'DYLD_INSERT_LIBRARIES', 'DYLD_CUSTOM', 'PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_CUSTOM', 'ORIGREAD_MCP_CHILD_ENV_JSON', 'origread_mcp_any', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'IFS', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'])('rejects unsafe environment name %s', (name) => {
    expect(isBlockedMcpEnvironmentName(name)).toBe(true)
    expect(() => parseMcpLocalEnvironment(`${name}=evil`)).toThrow('高危环境变量')
  })
  it.each([
    ['npm', ['-f', 'exec', 'pkg']], ['npm', ['-C', 'exec', 'pkg']], ['npm', ['-p', 'exec', 'pkg']],
    ['pnpm', ['-F', 'app', 'exec', 'pkg']],
    ['npm', ['--workspace', 'app', 'exec', 'pkg']], ['npm', ['-w', 'app', 'exec', 'pkg']],
    ['npm', ['--unknown-value-option', 'app', 'exec', 'pkg']], ['npm', ['--workspace', '--yes', 'exec', 'pkg']],
    ['pnpm', ['--filter', 'app', 'exec', 'pkg']], ['uv', ['--directory', '/tmp', 'tool', 'run', 'pkg']],
    ['pnpm', ['install']], ['pnpm', ['i']], ['yarn', ['install']], ['yarn', []],
    ['pnpm', ['add', 'pkg']], ['yarn', ['add', 'pkg']], ['npm', ['add', 'pkg']],
    ['npm', ['--prefix', '/tmp', 'exec', 'pkg']], ['npm', ['x', 'pkg']], ['npm', ['--cache=/tmp', 'i', 'pkg']],
    ['npm', ['--config', '/tmp/config', 'install', 'pkg']], ['npm', ['--', 'create', 'pkg']],
    ['pnpm', ['--dir', '/tmp', 'dlx', 'pkg']], ['pnpm', ['--registry', 'https://example.com', 'exec', 'pkg']],
    ['yarn', ['--cwd', '/tmp', 'dlx', 'pkg']], ['pipx', ['--quiet', 'run', 'pkg']], ['pipx', ['install', 'pkg']],
    ['npx', ['evil', '--', '--no-install']], ['npx', ['evil', '--no-install']], ['npx', ['--no-install', '-y', 'evil']],
    ['npx', ['--no-install', '--yes', 'evil']],
    ['npx', ['--no-install', '-y=true', 'evil']], ['npx', ['--no-install', '--no-yes=false', 'evil']],
    ['npx', ['--NO-INSTALL', 'evil']], ['npx', ['--no-install ', 'evil']],
    ['npx', ['--no-install', '-qy', 'evil']], ['npx', ['--no-install', '--no-install=false', 'evil']],
    ['npx', ['--no-install', '--package', '--yes', 'evil']], ['npx', ['--no-install', '--unknown', 'evil']], ['npx', ['--', '--no-install', 'evil']],
    ['uv', ['tool', 'run', 'pkg']], ['uv', ['x', 'pkg']], ['bunx', ['pkg']], ['uvx', ['pkg']], ['corepack', ['pkg']],
    ...['wscript', 'cscript', 'mshta', 'dash', 'ksh', 'csh', 'tcsh'].map((command) => [command, []])
  ] as Array<[string, string[]]>)('blocks command bypass %s %j', (command, args) => {
    expect(() => assertSafeLocalCommand(command, args)).toThrow()
  })
  it('allows direct executables and explicitly local npx', () => {
    expect(() => assertSafeLocalCommand('node', ['server.js'])).not.toThrow()
    expect(() => assertSafeLocalCommand('node', ['--inspect', 'server.js'])).not.toThrow()
    expect(() => assertSafeLocalCommand('npm', ['--workspace=app', '--quiet', 'run', 'mcp'])).not.toThrow()
    expect(() => assertSafeLocalCommand('npx', ['--no-install', 'my-mcp'])).not.toThrow()
    expect(() => assertSafeLocalCommand('npx', ['-p', 'my-mcp', '--no-install', 'my-mcp'])).not.toThrow()
    expect(parseMcpLocalEnvironment('API_TOKEN=secret')).toEqual({ API_TOKEN: 'secret' })
  })
  it('restores enabled backup entries as disabled', () => {
    const { database, repository } = setup()
    try {
      const created = repository.addServer().servers[0]!
      repository.updateServer({ id: created.id, command: 'node', args: ['server.js'], enabled: true })
      const backup = repository.exportBackupState()
      expect(backup.servers[0]!.enabled).toBe(true)
      expect(repository.restoreBackupState(backup).servers[0]!.enabled).toBe(false)
    } finally { database.close() }
  })
})


it('validates the full local edit before changing credentials and rolls back failed saves', () => {
  const { database, repository, secrets } = setup()
  try {
    const server = repository.addServer().servers[0]!
    repository.updateServer({ id: server.id, command: 'node', args: ['server.js'], environment: 'TOKEN=old' })
    const snapshot = secrets.snapshot()
    const current = repository.current()
    expect(() => repository.updateServer({ id: server.id, args: ['bad\0arg'], environment: 'TOKEN=new' })).toThrow()
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.current()).toEqual(current)
    expect(() => repository.updateServer({ id: server.id, environment: 'not-an-assignment' })).toThrow()
    expect(secrets.snapshot()).toEqual(snapshot)
    database.exec("CREATE TRIGGER fail_local BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'settings blocked'); END")
    expect(() => repository.updateServer({ id: server.id, name: 'changed', environment: 'TOKEN=new' })).toThrow('settings blocked')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.current()).toEqual(current)
  } finally { database.close() }
})

it('rolls back committed settings as well as secrets if rendering the saved result fails', () => {
  const { database, repository, secrets } = setup()
  try {
    const server = repository.addServer().servers[0]!
    repository.updateServer({ id: server.id, command: 'node', args: ['server.js'], environment: 'TOKEN=old' })
    const current = repository.current()
    const snapshot = secrets.snapshot()
    const get = secrets.get.bind(secrets)
    secrets.get = (key) => {
      const value = get(key)
      if (value === 'TOKEN=new') throw new Error('decrypt failed')
      return value
    }
    expect(() => repository.updateServer({ id: server.id, name: 'changed', environment: 'TOKEN=new' })).toThrow('decrypt failed')
    expect(secrets.snapshot()).toEqual(snapshot)
    expect(repository.current()).toEqual(current)
  } finally { database.close() }
})
