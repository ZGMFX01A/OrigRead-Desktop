import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import { RssHubSettingsRepository } from './rsshub-settings-repository'

describe('RssHubSettingsRepository', () => {
  it('persists settings, prioritizes the last successful instance and cools down failures', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new RssHubSettingsRepository(database.connection)
    try {
      expect(repository.current().instances).toHaveLength(16)
      repository.addInstance('https://custom.example.com/')
      repository.recordSuccess('custom.example.com')
      expect(repository.candidateInstances()[0]).toBe('https://custom.example.com')

      repository.recordFailure('https://custom.example.com', 1_000)
      const coolingCandidates = repository.candidateInstances(1_001)
      expect(coolingCandidates).toContain('https://custom.example.com')
      expect(coolingCandidates.at(-1)).toBe('https://custom.example.com')
      expect(repository.candidateInstances(1_000 + 5 * 60 * 1_000 + 1)).toContain('https://custom.example.com')

      const reopened = new RssHubSettingsRepository(database.connection)
      expect(reopened.current().instances.some((item) => item.url === 'https://custom.example.com')).toBe(true)

      reopened.setEnabled(false)
      const restored = reopened.restoreDefault()
      expect(restored.enabled).toBe(true)
      expect(restored.instances).toHaveLength(16)
      expect(restored.instances.some((item) => item.url === 'https://custom.example.com')).toBe(false)
    } finally {
      database.close()
    }
  })
})
