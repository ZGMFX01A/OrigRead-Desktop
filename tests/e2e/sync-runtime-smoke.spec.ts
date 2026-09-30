import { expect, test } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('sync IPC activates Genesis and persists an endpoint in the real desktop runtime', async () => {
  const instance = await launchIsolatedOrigRead()
  try {
    const page = await instance.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()
    await page.evaluate(() => window.origread.activateSyncGenesis())
    const status = await page.evaluate(() => window.origread.getSyncStatus())
    expect(status.syncSpaceId).toBeTruthy()
    expect(status.deviceId).toBeTruthy()
    expect(status.lifecycleState).toBe('ACTIVE')
    const endpoint = await page.evaluate((space) => window.origread.configureSyncEndpoint({
      syncSpaceId: space!, kind: 'MANUAL', url: 'http://127.0.0.1:49199', displayName: 'Runtime test', enabled: false,
    }), status.syncSpaceId)
    expect((await page.evaluate(() => window.origread.getSyncStatus())).endpoints)
      .toContainEqual(endpoint)
    await page.evaluate((id) => window.origread.removeSyncEndpoint(id), endpoint.endpointId)
    expect((await page.evaluate(() => window.origread.getSyncStatus())).endpoints).toEqual([])
  } finally {
    await instance.close()
  }
})
