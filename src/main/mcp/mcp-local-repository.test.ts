import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '../security/secret-store'
import { assertSafeLocalCommand, McpLocalRepository } from './mcp-local-repository'

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
