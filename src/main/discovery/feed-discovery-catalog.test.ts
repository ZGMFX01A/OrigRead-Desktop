import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FeedDiscoveryCatalog } from './feed-discovery-catalog'
import { localizedSourceCategory, sourceCategorySearchTerms } from '../../shared/source-catalog'

describe('FeedDiscoveryCatalog', () => {
  it('loads the same bundled catalog as Android', () => {
    const catalog = new FeedDiscoveryCatalog(join(process.cwd(), 'resources', 'source_catalog.json')).data
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.feedCount).toBe(752)
    expect(catalog.feeds).toHaveLength(752)
    expect(catalog.categories).toHaveLength(44)
    expect(catalog.categories.every((category, index) => index === 0 || (catalog.categoryCounts[catalog.categories[index - 1]!] ?? 0) >= (catalog.categoryCounts[category] ?? 0))).toBe(true)
  })

  it('uses Android category localization and search terms', () => {
    expect(localizedSourceCategory('Programming', 'zh-CN')).toBe('编程')
    expect(localizedSourceCategory('Programming', 'en-US')).toBe('Programming')
    expect(sourceCategorySearchTerms('Programming')).toContain('编程')
    expect(sourceCategorySearchTerms('Programming')).toContain('Programming')
  })
})
