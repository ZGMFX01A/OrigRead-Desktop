import { test, expect } from '@playwright/test'
import { launchIsolatedOrigRead } from './electron-test-app'

test('AI settings reveal saved API keys only on explicit request and clear plaintext afterwards', async () => {
  const testApp = await launchIsolatedOrigRead()
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const providerId = await page.evaluate(async () => {
      const settings = await window.origread.getAiSettings()
      const provider = settings.providers[0]
      if (!provider) throw new Error('No AI provider')
      await window.origread.updateAiProvider({ id: provider.id, apiKey: 'secret-e2e-value' })
      return provider.id
    })

    const metadata = await page.evaluate(async (id) => {
      const provider = (await window.origread.getAiSettings()).providers.find((item) => item.id === id)
      return provider ? { hasApiKey: provider.hasApiKey, apiKeyLength: provider.apiKeyLength } : null
    }, providerId)
    expect(metadata).toEqual({ hasApiKey: true, apiKeyLength: 'secret-e2e-value'.length })

    await page.locator('.settings-button').click()
    await expect(page.locator('.settings-layout')).toBeVisible()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '模型服务' }).click()

    const providerCard = page.locator('.ai-provider-detail')
    const keyInput = providerCard.locator('.secret-key-input')
    const eye = providerCard.locator('.secret-key-eye')
    await expect(keyInput).toHaveValue('')
    await expect(keyInput).toHaveAttribute('type', 'password')
    await expect(keyInput).toHaveAttribute('placeholder', /16/)

    await eye.click()
    await expect(keyInput).toHaveAttribute('type', 'text')
    await expect(keyInput).toHaveValue('secret-e2e-value')

    await eye.click()
    await expect(keyInput).toHaveAttribute('type', 'password')
    await expect(keyInput).toHaveValue('')

    await keyInput.fill('replacement-secret')
    await providerCard.locator('.secret-key-save').click()
    await expect(keyInput).toHaveValue('')
    await expect(keyInput).toHaveAttribute('type', 'password')
    await expect.poll(async () => {
      const provider = (await page.evaluate(() => window.origread.getAiSettings())).providers.find((item) => item.id === providerId)
      return provider?.apiKeyLength ?? 0
    }).toBe('replacement-secret'.length)

    await page.locator('.settings-close-button').click()
    await page.locator('.settings-button').click()
    await page.locator('.settings-nav-button').filter({ hasText: 'AI' }).click()
    await page.getByRole('tab', { name: '模型服务' }).click()
    await expect(page.locator('.ai-provider-detail').locator('.secret-key-input')).toHaveValue('')
  } finally {
    await testApp.close()
  }
})
