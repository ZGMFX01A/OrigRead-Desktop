import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const sourceUserData = process.env.ORIGREAD_LIVE_USER_DATA_DIR?.trim() || defaultUserDataDir()
const useDirectUserData = process.env.ORIGREAD_LIVE_COPY_USER_DATA !== '1'
const testRoot = join(process.cwd(), 'test-results')
await mkdir(testRoot, { recursive: true })
const isolatedUserData = useDirectUserData ? null : await mkdtemp(join(testRoot, 'web-search-live-user-data-'))

let app
try {
  if (isolatedUserData) {
    await copyRequired('origread.db')
    await copyRequired('secrets.json')
    await copyOptional('origread.db-wal')
    await copyOptional('origread.db-shm')
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
  )
  if (isolatedUserData) env.ORIGREAD_E2E_USER_DATA_DIR = isolatedUserData
  else delete env.ORIGREAD_E2E_USER_DATA_DIR
  env.ORIGREAD_DISABLE_AUTO_UPDATE_CHECK = '1'
  env.ORIGREAD_DISABLE_PERIODIC_SYNC = '1'

  const packagedExecutable = process.platform === 'win32'
    ? join(process.cwd(), 'release', 'win-unpacked', 'OrigRead.exe')
    : null
  const executablePath = packagedExecutable && await isReadable(packagedExecutable) ? packagedExecutable : undefined

  app = await electron.launch({
    args: [...(executablePath ? [] : ['.']), '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--disable-crash-reporter', '--noerrdialogs'],
    cwd: process.cwd(),
    env,
    ...(executablePath ? { executablePath } : {})
  })
  const page = await app.firstWindow()
  const checks = await page.evaluate(async () => {
    const settings = await window.origread.getWebSearchSettings()
    const results = []
    for (const provider of settings.providers) {
      if (!provider.enabled) continue
      const checked = await window.origread.testWebSearchProvider(provider.id)
      results.push({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        hasApiKey: provider.hasApiKey,
        ok: checked.ok,
        latencyMs: checked.result?.latencyMs ?? null,
        resultCount: checked.result?.resultCount ?? null,
        error: checked.error
      })
    }
    return results
  })

  if (checks.length === 0) throw new Error('No enabled Web Search providers are configured in the client')
  for (const check of checks) {
    const detail = check.ok
      ? `${check.latencyMs ?? '?'} ms, ${check.resultCount ?? 0} results`
      : check.error || 'unknown error'
    console.log(`${check.kind} · ${check.name}: ${check.ok ? 'PASS' : 'FAIL'} (${detail})`)
  }

  const authenticatedSuccess = checks.find((check) =>
    (check.kind === 'EXA' || check.kind === 'TAVILY') && check.hasApiKey && check.ok
  )
  if (!authenticatedSuccess) {
    throw new Error('D5.10 requires one configured Exa or Tavily provider to pass a real health check')
  }
  console.log(`D5.10: PASS (${authenticatedSuccess.kind} verified through the client configuration path)`)
} finally {
  if (app) await app.close().catch(() => undefined)
  if (isolatedUserData) await rm(isolatedUserData, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
}

async function copyRequired(name) {
  const source = join(sourceUserData, name)
  try {
    await access(source, constants.R_OK)
  } catch {
    throw new Error(`Required OrigRead user-data file is missing: ${name}`)
  }
  await copyFile(source, join(isolatedUserData, name))
}

async function copyOptional(name) {
  const source = join(sourceUserData, name)
  try {
    await access(source, constants.R_OK)
    await copyFile(source, join(isolatedUserData, name))
  } catch {
    // WAL/SHM are optional when the database was cleanly closed.
  }
}

async function isReadable(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function defaultUserDataDir() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    if (!appData) throw new Error('APPDATA is unavailable; set ORIGREAD_LIVE_USER_DATA_DIR explicitly')
    return join(appData, 'origread-desktop')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'origread-desktop')
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'origread-desktop')
}
