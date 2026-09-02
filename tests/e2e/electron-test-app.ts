import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from 'playwright'

export interface IsolatedElectronApp {
  app: ElectronApplication
  userDataDir: string
  close(): Promise<void>
}

/** 每个 E2E 使用独立 userData，避免测试订阅/设置污染开发机数据库。 */
export async function launchIsolatedOrigRead(
  envOverrides: Record<string, string> = {},
  extraArgs: string[] = []
): Promise<IsolatedElectronApp> {
  const root = join(process.cwd(), 'test-results')
  await mkdir(root, { recursive: true })
  const userDataDir = await mkdtemp(join(root, 'user-data-'))
  return launchOrigReadWithUserData(userDataDir, envOverrides, extraArgs, true)
}

export async function launchOrigReadWithUserData(
  userDataDir: string,
  envOverrides: Record<string, string> = {},
  extraArgs: string[] = [],
  cleanupOnClose = false
): Promise<IsolatedElectronApp> {
  await mkdir(userDataDir, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  env.ORIGREAD_E2E_USER_DATA_DIR = userDataDir
  env.ORIGREAD_DISABLE_AUTO_UPDATE_CHECK = '1'
  Object.assign(env, envOverrides)
  const executablePath = process.env.ORIGREAD_E2E_EXECUTABLE_PATH?.trim() || undefined
  const app = await electron.launch({
    args: [
      ...(executablePath ? [] : ['.']),
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      '--disable-crash-reporter',
      '--noerrdialogs',
      ...extraArgs
    ],
    cwd: process.cwd(),
    env,
    ...(executablePath ? { executablePath } : {})
  })
  return {
    app,
    userDataDir,
    async close() {
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ])
      if (cleanupOnClose) {
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
      }
    }
  }
}

