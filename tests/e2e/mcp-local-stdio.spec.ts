import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('Local MCP stdio stays lazy, keeps env secrets out of settings, refreshes tools, and executes through the shared ToolRuntime', async () => {
  test.setTimeout(30_000)
  const tempDir = await mkdtemp(join(tmpdir(), 'origread-mcp-stdio-'))
  const logPath = join(tempDir, 'fixture.log')
  const fixturePath = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mcp-stdio-fixture.cjs')
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    expect(await readFixtureEvents(logPath)).toEqual([])

    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '回答与快捷操作' }).click()

    const section = page.locator('.settings-section').filter({
      has: page.locator('.settings-section-title', { hasText: '本地 MCP（stdio）' })
    })
    await expect(section).toBeVisible()
    const addButton = section.locator('.mcp-remote-toolbar').getByRole('button', { name: '添加' })
    expect(await addButton.evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      flexShrink: getComputedStyle(element).flexShrink
    }))).toEqual({ whiteSpace: 'nowrap', flexShrink: '0' })
    await addButton.click()

    const card = section.locator('.mcp-local-card').first()
    await expect(card).toBeVisible()
    await card.locator('.provider-name').fill('Fixture stdio')
    await card.locator('.provider-name').blur()

    const commandInput = card.locator('.provider-field').filter({ hasText: '可执行程序' }).locator('input')
    await commandInput.fill(process.execPath)
    await commandInput.blur()
    const argsEditor = card.locator('.mcp-local-args-field textarea')
    await argsEditor.fill(`${fixturePath}\n--profile=e2e`)
    await argsEditor.blur()
    const cwdInput = card.locator('.mcp-local-cwd-field input')
    await cwdInput.fill(process.cwd())
    await cwdInput.blur()

    const envEditor = card.locator('.mcp-local-environment-field textarea')
    await envEditor.fill(`ORIGREAD_MCP_FIXTURE_LOG=${logPath}\nFIXTURE_SECRET=local-secret-value`)
    await card.locator('.mcp-local-environment-field').getByRole('button', { name: '保存环境变量' }).click()
    await expect(card.locator('.settings-status')).toContainText('环境变量已保存')

    // Saving and enabling a local MCP configuration must never launch it by itself.
    expect(await readFixtureEvents(logPath)).toEqual([])
    await card.locator('.setting-switch').click()
    await expect(card.locator('.setting-switch input')).toBeChecked()
    expect(await readFixtureEvents(logPath)).toEqual([])

    const publicSettings = await page.evaluate(() => window.origread.getMcpLocalSettings())
    expect(publicSettings.servers).toHaveLength(1)
    expect(publicSettings.servers[0]).toMatchObject({
      name: 'Fixture stdio',
      enabled: true,
      command: process.execPath,
      args: [fixturePath, '--profile=e2e'],
      cwd: process.cwd(),
      hasEnvironment: true
    })
    expect(JSON.stringify(publicSettings)).not.toContain('local-secret-value')
    expect(JSON.stringify(publicSettings)).not.toContain(logPath)

    await card.getByRole('button', { name: '测试连接' }).click()
    await expect(card.locator('.settings-status')).toContainText(/连接正常.*2 个工具.*Legacy.*2025-11-25/)
    const healthEvents = await readFixtureEvents(logPath)
    const startsAfterHealth = healthEvents.filter((event) => event.event === 'started')
    expect(startsAfterHealth.length).toBeGreaterThanOrEqual(2)
    expect(startsAfterHealth.every((event) => event.secretPresent === true)).toBe(true)
    expect(startsAfterHealth.some((event) => Array.isArray(event.args) && event.args.includes('--profile=e2e'))).toBe(true)

    await card.getByRole('button', { name: '刷新工具', exact: true }).click()
    await expect(card.locator('.settings-status')).toContainText('工具目录已刷新 · 2 个工具')
    await expect(card.locator('.mcp-tool-row')).toHaveCount(2)
    await expect(card.locator('.mcp-tool-row').filter({ hasText: 'Read local note' })).toContainText('服务端标记：只读')
    await expect(card.locator('.mcp-tool-row').filter({ hasText: 'Write local note' })).toContainText('服务端标记：可能修改')

    const catalog = await page.evaluate(() => window.origread.getMcpToolCatalog())
    const localCatalog = catalog.servers.find((server) => server.serverName === 'Fixture stdio')
    expect(localCatalog).toMatchObject({ stale: false })
    expect(localCatalog?.tools.map((tool) => tool.rawName)).toEqual(['read_local_note', 'write_local_note'])
    expect(JSON.stringify(catalog)).not.toContain('local-secret-value')

    // A local catalog entry is the same executable ToolRuntime surface used by Remote MCP.
    // The read-only manual path proves stdio tools/call without requiring model tool-calling support.
    const manualResult = await page.evaluate(async () => {
      const conversation = await window.origread.createLlmConversation({ title: 'Local MCP E2E' })
      const tools = await window.origread.listLlmManualTools()
      const tool = tools.find((item) => item.name.includes('read_local_note'))
      if (!tool) throw new Error('Local MCP read tool missing from Manual Tool catalog')
      const context = await window.origread.executeLlmManualTool({
        conversationId: conversation.id,
        toolId: tool.id,
        argumentsJson: JSON.stringify({ id: 'note-7' }),
        confirmed: false
      })
      await window.origread.discardLlmManualToolContext(context.contextId)
      return { tool, context }
    })
    expect(manualResult.tool).toMatchObject({ risk: 'READ_ONLY' })
    expect(manualResult.context.resultPreview).toBe('read_local_note:ok:note-7')
    const executionEvents = await readFixtureEvents(logPath)
    expect(executionEvents).toContainEqual(expect.objectContaining({
      event: 'tool-call',
      name: 'read_local_note',
      secretPresent: true,
      args: { id: 'note-7' }
    }))

    await card.getByRole('button', { name: '断开', exact: true }).click()
    await expect(card.locator('.mcp-connection-badge')).toHaveText('未连接')

    const unsafeRunnerError = await page.evaluate(async () => {
      const next = await window.origread.addMcpLocalServer()
      const server = next.servers.at(-1)
      if (!server) throw new Error('Second local MCP server missing')
      try {
        await window.origread.updateMcpLocalServer({
          id: server.id,
          command: 'npx',
          args: ['@example/mcp-server'],
          enabled: true
        })
        return ''
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(unsafeRunnerError).toContain('--no-install')
  } finally {
    await testApp.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('App quit waits for an active local MCP stdio child process to exit', async () => {
  test.setTimeout(30_000)
  const tempDir = await mkdtemp(join(tmpdir(), 'origread-mcp-stdio-quit-'))
  const logPath = join(tempDir, 'fixture.log')
  const fixturePath = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mcp-stdio-fixture.cjs')
  const testApp = await launchIsolatedOrigRead()
  let appClosed = false
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    const serverId = await page.evaluate(async ({ command, fixturePath: childScript, cwd, logPath: childLog }) => {
      const added = await window.origread.addMcpLocalServer()
      const server = added.servers[0]
      if (!server) throw new Error('Local MCP server missing')
      await window.origread.updateMcpLocalServer({
        id: server.id,
        name: 'Quit cleanup fixture',
        command,
        args: [childScript, '--profile=quit-cleanup'],
        cwd,
        environment: `ORIGREAD_MCP_FIXTURE_LOG=${childLog}\nFIXTURE_SECRET=local-secret-value`,
        enabled: true
      })
      await window.origread.connectMcpLocalServer(server.id)
      return server.id
    }, { command: process.execPath, fixturePath, cwd: process.cwd(), logPath })

    const state = await page.evaluate((id) => window.origread.getMcpLocalConnectionStates().then((items) => items.find((item) => item.serverId === id)), serverId)
    expect(state).toMatchObject({ status: 'CONNECTED' })
    const activePid = await waitForActiveFixturePid(logPath)
    expect(isProcessAlive(activePid)).toBe(true)

    await testApp.close()
    appClosed = true
    await waitForProcessExit(activePid)
    expect(isProcessAlive(activePid)).toBe(false)
  } finally {
    if (!appClosed) await testApp.close().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('A crashed Electron main process does not leave the active stdio MCP fixture orphaned', async () => {
  test.setTimeout(30_000)
  const tempDir = await mkdtemp(join(tmpdir(), 'origread-mcp-stdio-crash-'))
  const logPath = join(tempDir, 'fixture.log')
  const fixturePath = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mcp-stdio-fixture.cjs')
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.evaluate(async ({ command, fixturePath: childScript, cwd, logPath: childLog }) => {
      const added = await window.origread.addMcpLocalServer()
      const server = added.servers[0]
      if (!server) throw new Error('Local MCP server missing')
      await window.origread.updateMcpLocalServer({
        id: server.id,
        name: 'Crash cleanup fixture',
        command,
        args: [childScript, '--profile=crash-cleanup'],
        cwd,
        environment: `ORIGREAD_MCP_FIXTURE_LOG=${childLog}\nFIXTURE_SECRET=local-secret-value`,
        enabled: true
      })
      await window.origread.connectMcpLocalServer(server.id)
    }, { command: process.execPath, fixturePath, cwd: process.cwd(), logPath })

    const activePid = await waitForActiveFixturePid(logPath)
    expect(isProcessAlive(activePid)).toBe(true)

    const mainPid = await testApp.app.evaluate(() => process.pid)
    if (!Number.isInteger(mainPid) || mainPid <= 0) throw new Error('Electron Main PID missing')
    process.kill(mainPid, 'SIGKILL')
    await waitForProcessExit(mainPid)
    await waitForProcessExit(activePid)
    expect(isProcessAlive(mainPid)).toBe(false)
    expect(isProcessAlive(activePid)).toBe(false)
  } finally {
    await testApp.close()
    await rm(tempDir, { recursive: true, force: true })
  }
})

interface FixtureEvent {
  event?: string
  pid?: number
  secretPresent?: boolean
  args?: unknown
  name?: string
}

async function readFixtureEvents(path: string): Promise<FixtureEvent[]> {
  let content = ''
  try { content = await readFile(path, 'utf8') } catch { return [] }
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as FixtureEvent] } catch { return [] }
    })
}

async function waitForActiveFixturePid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const starts = (await readFixtureEvents(path)).filter((event): event is FixtureEvent & { pid: number } => event.event === 'started' && Number.isInteger(event.pid))
    for (const event of starts.reverse()) if (isProcessAlive(event.pid)) return event.pid
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Active stdio fixture PID was not observed')
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`process ${pid} is still alive after app exit`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
