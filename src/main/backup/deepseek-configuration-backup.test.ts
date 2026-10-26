import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigurationBackup } from '../../shared/configuration-backup'
import { WebSearchRepository } from '../search/web-search-repository'
import { createConfigurationBackupFixture } from './configuration-backup-test-support'

const fixtures: ReturnType<typeof createConfigurationBackupFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

describe('DeepSeek configuration backup compatibility', () => {
  it('round-trips the new provider through normal validation and encrypted secrets', () => {
    const fixture = createFixture()
    const provider = fixture.webSearch.addProvider('DEEPSEEK').providers[0]!
    fixture.webSearch.updateProvider({
      id: provider.id, name: 'Custom DeepSeek Search',
      endpoint: 'https://search.example/v1/tools/search', apiKey: 'deepseek-backup-fixture-key'
    })
    fixture.webSearch.updateSettings({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })
    const content = fixture.backup.exportBackup('backup-fixture-password')
    const exported = JSON.parse(content) as ConfigurationBackup

    expect(exported.webSearch).toMatchObject({
      mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8,
      providers: [{ id: provider.id, kind: 'DEEPSEEK', name: 'Custom DeepSeek Search',
        endpoint: 'https://search.example/v1/tools/search', enabled: true }]
    })
    expect(content).not.toContain('deepseek-backup-fixture-key')
    fixture.webSearch.removeProvider(provider.id)
    fixture.backup.restoreBackup(content, 'backup-fixture-password')
    const reloaded = new WebSearchRepository(fixture.database.connection, fixture.secrets)
    expect(reloaded.current()).toMatchObject({ mode: 'AUTO', defaultProviderId: provider.id, maxResults: 8 })
    expect(reloaded.current().providers[0]).toMatchObject({
      id: provider.id, kind: 'DEEPSEEK', name: 'Custom DeepSeek Search', hasApiKey: true
    })
    expect(reloaded.getApiKey(provider.id)).toBe('deepseek-backup-fixture-key')
    expect(reloaded.isConfigured(provider.id)).toBe(true)
  })

  it('keeps local credentials for an unencrypted backup and retains settings for older backups', () => {
    const fixture = createFixture()
    const provider = fixture.webSearch.addProvider('DEEPSEEK').providers[0]!
    fixture.webSearch.updateProvider({ id: provider.id, apiKey: 'keep-local-fixture-key' })
    fixture.webSearch.updateSettings({ mode: 'AUTO', maxResults: 9 })
    const content = fixture.backup.exportBackup()
    expect(content).not.toContain('keep-local-fixture-key')

    fixture.webSearch.updateProvider({ id: provider.id, name: 'Changed name' })
    fixture.backup.restoreBackup(content)
    expect(fixture.webSearch.current().providers[0]).toMatchObject({
      id: provider.id, kind: 'DEEPSEEK', name: 'DeepSeek Search', hasApiKey: true
    })
    expect(fixture.webSearch.getApiKey(provider.id)).toBe('keep-local-fixture-key')

    const legacy = JSON.parse(content) as ConfigurationBackup
    delete legacy.webSearch
    const before = fixture.webSearch.current()
    fixture.backup.restoreBackup(JSON.stringify(legacy))
    expect(fixture.webSearch.current()).toEqual(before)
    expect(fixture.webSearch.getApiKey(provider.id)).toBe('keep-local-fixture-key')
  })
})

function createFixture() {
  const fixture = createConfigurationBackupFixture(mkdtempSync(join(tmpdir(), 'origread-deepseek-backup-')))
  fixtures.push(fixture)
  return fixture
}
