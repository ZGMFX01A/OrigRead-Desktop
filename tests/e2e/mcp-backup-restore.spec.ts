import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('MCP configuration restore invalidates live connection, catalog, and ToolRuntime even when server IDs are unchanged', async () => {
  test.setTimeout(30_000)
  const tempDir = await mkdtemp(join(tmpdir(), 'origread-mcp-backup-'))
  const backupPath = join(tempDir, 'configuration.json')
  const fixtureLogPath = join(tempDir, 'stdio-fixture.log')
  const fixturePath = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mcp-stdio-fixture.cjs')
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await testApp.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, backupPath)

    const serverId = await page.evaluate(async ({ command, fixturePath: childScript, cwd, fixtureLogPath: childLog }) => {
      const added = await window.origread.addMcpLocalServer()
      const server = added.servers[0]
      if (!server) throw new Error('Local MCP server missing')
      await window.origread.updateMcpLocalServer({
        id: server.id,
        name: 'Backup restore fixture',
        command,
        args: [childScript, '--profile=backup-restore'],
        cwd,
        environment: `ORIGREAD_MCP_FIXTURE_LOG=${childLog}\nFIXTURE_SECRET=local-secret-value`,
        enabled: true
      })
      await window.origread.connectMcpLocalServer(server.id)
      await window.origread.refreshMcpToolCatalog(server.id)
      return server.id
    }, { command: process.execPath, fixturePath, cwd: process.cwd(), fixtureLogPath })

    const beforeRestore = await page.evaluate(async (id) => ({
      state: (await window.origread.getMcpLocalConnectionStates()).find((item) => item.serverId === id),
      catalog: await window.origread.getMcpToolCatalog(),
      manualTools: await window.origread.listLlmManualTools(),
      environment: await window.origread.revealMcpLocalEnvironment(id)
    }), serverId)
    expect(beforeRestore.state).toMatchObject({ status: 'CONNECTED' })
    expect(beforeRestore.catalog.servers).toEqual([
      expect.objectContaining({ serverId, stale: false, tools: expect.arrayContaining([expect.objectContaining({ rawName: 'read_local_note' })]) })
    ])
    expect(beforeRestore.manualTools.some((tool) => tool.name.includes('read_local_note'))).toBe(true)
    expect(beforeRestore.environment).toContain('FIXTURE_SECRET=local-secret-value')

    const exported = await page.evaluate(() => window.origread.exportConfigurationBackup('backup-pass'))
    expect(exported).toMatchObject({ ok: true, cancelled: false, path: backupPath })

    // The backup contains the same server ID as the currently live runtime. Restore must still
    // tear down that connection and discard its frozen catalog/tool registrations immediately.
    const restored = await page.evaluate(() => window.origread.restoreConfigurationBackup('backup-pass'))
    expect(restored).toMatchObject({ ok: true, cancelled: false, path: backupPath })

    const afterRestore = await page.evaluate(async (id) => ({
      settings: await window.origread.getMcpLocalSettings(),
      state: (await window.origread.getMcpLocalConnectionStates()).find((item) => item.serverId === id),
      catalog: await window.origread.getMcpToolCatalog(),
      manualTools: await window.origread.listLlmManualTools(),
      environment: await window.origread.revealMcpLocalEnvironment(id)
    }), serverId)
    expect(afterRestore.settings.servers[0]).toMatchObject({
      id: serverId,
      name: 'Backup restore fixture',
      enabled: true,
      hasEnvironment: true
    })
    expect(afterRestore.environment).toContain('FIXTURE_SECRET=local-secret-value')
    expect(afterRestore.state).toMatchObject({ status: 'DISCONNECTED' })
    expect(afterRestore.catalog.servers).toEqual([])
    expect(afterRestore.manualTools.some((tool) => tool.name.includes('read_local_note'))).toBe(false)

    // Restored profiles/secrets remain usable, but only through a fresh connection/catalog cycle.
    const reconnected = await page.evaluate(async (id) => {
      const state = await window.origread.connectMcpLocalServer(id)
      const catalog = await window.origread.refreshMcpToolCatalog(id)
      return { state, catalog, manualTools: await window.origread.listLlmManualTools() }
    }, serverId)
    expect(reconnected.state).toMatchObject({ status: 'CONNECTED' })
    expect(reconnected.catalog.servers[0]).toMatchObject({ serverId, stale: false })
    expect(reconnected.manualTools.some((tool) => tool.name.includes('read_local_note'))).toBe(true)
  } finally {
    await testApp.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})
