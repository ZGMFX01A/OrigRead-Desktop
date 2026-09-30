import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../../database/database'
import { RssHubSettingsRepository } from './rsshub-settings-repository'
import { formatRssHubLocation } from '../../../shared/rsshub'

describe('RssHubSettingsRepository', () => {
  it('never resurrects a disabled or deleted last successful instance', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new RssHubSettingsRepository(database.connection)
    try {
      repository.restore({ enabled: true, instances: [] })
      repository.addInstance('https://custom.example.com')
      const instance = repository.current().instances.find((item) => item.url === 'https://custom.example.com')!
      repository.recordSuccess(instance.url)
      repository.setInstanceEnabled(instance.id, false)
      expect(repository.candidateInstances()).not.toContain(instance.url)
      repository.deleteInstance(instance.id)
      expect(repository.candidateInstances()).not.toContain(instance.url)
    } finally {
      database.close()
    }
  })

  it('keeps an intentionally empty instance list empty after reopening', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new RssHubSettingsRepository(database.connection)
    try {
      for (const instance of repository.current().instances) repository.deleteInstance(instance.id)
      expect(new RssHubSettingsRepository(database.connection).current().instances).toEqual([])
      expect(repository.candidateInstances()).toEqual([])
    } finally {
      database.close()
    }
  })

  it('persists settings, prioritizes the last successful instance and cools down failures', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new RssHubSettingsRepository(database.connection)
    try {
      expect(repository.current().instances).toHaveLength(16)
      expect(repository.current().instances[0]?.location).toBe('US')
      expect(formatRssHubLocation(repository.current().instances[0]?.location ?? '', 'en')).toBe('US United States')
      expect(formatRssHubLocation(repository.current().instances[0]?.location ?? '', 'zh')).toBe('🇺🇸 美国')
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

  it('normalizes legacy localized built-in locations so backups do not leak Chinese labels into English UI', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new RssHubSettingsRepository(database.connection)
    try {
      const current = repository.current()
      const restored = repository.restore({
        ...current,
        instances: current.instances.map((instance) => instance.id === 'official'
          ? { ...instance, location: '🇺🇸 美国' }
          : instance)
      })
      expect(restored.instances.find((instance) => instance.id === 'official')?.location).toBe('US')
    } finally {
      database.close()
    }
  })
})
