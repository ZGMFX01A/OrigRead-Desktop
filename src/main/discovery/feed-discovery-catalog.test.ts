import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FeedDiscoveryCatalog } from './feed-discovery-catalog'
import { localizedSourceCategory, sourceCategorySearchTerms } from '../../shared/source-catalog'

describe('FeedDiscoveryCatalog', () => {
  it('loads the same bundled catalog as Android', () => {
    const catalog = new FeedDiscoveryCatalog(join(process.cwd(), 'resources', 'source_catalog.json')).data
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.generatedAt).toBe('2026-08-29T17:49:09+00:00')
    expect(catalog.feedCount).toBe(2427)
    expect(catalog.feeds).toHaveLength(2427)
    expect(catalog.sources).toHaveLength(4)
    expect(catalog.categories).toHaveLength(18)
    expect(catalog.categories.every((category, index) => index === 0 || (catalog.categoryCounts[catalog.categories[index - 1]!] ?? 0) >= (catalog.categoryCounts[category] ?? 0))).toBe(true)
  })

  it('uses Android category localization and search terms', () => {
    expect(localizedSourceCategory('Programming', 'zh-CN')).toBe('编程')
    expect(localizedSourceCategory('Programming', 'en-US')).toBe('Programming')
    expect(sourceCategorySearchTerms('Programming')).toContain('编程')
    expect(sourceCategorySearchTerms('Programming')).toContain('Programming')
    expect(localizedSourceCategory('Developer Tools', 'zh-CN')).toBe('开发工具')
    expect(localizedSourceCategory('Tech & Engineering', 'zh-CN')).toBe('科技与工程')
    expect(sourceCategorySearchTerms('Newsletters')).toContain('周刊')
  })
})
