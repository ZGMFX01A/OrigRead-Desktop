import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from 'playwright'

export interface IsolatedElectronApp {
  app: ElectronApplication
  close(): Promise<void>
}

/** 每个 E2E 使用独立 userData，避免测试订阅/设置污染开发机数据库。 */
export async function launchIsolatedOrigRead(envOverrides: Record<string, string> = {}): Promise<IsolatedElectronApp> {
  const root = join(process.cwd(), 'test-results')
  await mkdir(root, { recursive: true })
  const userDataDir = await mkdtemp(join(root, 'user-data-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  env.ORIGREAD_E2E_USER_DATA_DIR = userDataDir
  env.ORIGREAD_DISABLE_AUTO_UPDATE_CHECK = '1'
  Object.assign(env, envOverrides)
  const app = await electron.launch({
    args: [
      '.',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      '--disable-crash-reporter',
      '--noerrdialogs'
    ],
    cwd: process.cwd(),
    env
  })
  return {
    app,
    async close() {
      await app.close()
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
    }
  }
}

