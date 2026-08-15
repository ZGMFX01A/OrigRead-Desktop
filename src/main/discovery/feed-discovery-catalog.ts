import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeedCatalogData, FeedCatalogSnapshot } from '../../shared/source-catalog'

const SOURCE_CATALOG_SCHEMA_VERSION = 1

export class FeedDiscoveryCatalog {
  readonly data: FeedCatalogSnapshot

  constructor(path = join(__dirname, '../../resources/source_catalog.json')) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FeedCatalogData
    if (parsed.schemaVersion !== SOURCE_CATALOG_SCHEMA_VERSION) {
      throw new Error(`不支持的来源目录版本：${parsed.schemaVersion}`)
    }
    if (parsed.feedCount !== parsed.feeds.length) throw new Error('来源目录数量校验失败')
    const categoryCounts: Record<string, number> = {}
    for (const feed of parsed.feeds) {
      for (const category of new Set(feed.categories)) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1
    }
    const categories = [...parsed.categories].sort((left, right) =>
      (categoryCounts[right] ?? 0) - (categoryCounts[left] ?? 0) || left.localeCompare(right)
    )
    this.data = {
      ...parsed,
      generatedAt: parsed.generatedAt ?? null,
      categories,
      sources: parsed.sources.map((source) => ({ ...source, license: source.license ?? null })),
      feeds: parsed.feeds.map((feed) => ({ ...feed, siteUrl: feed.siteUrl ?? null, categories: [...feed.categories], origins: [...feed.origins] })),
      categoryCounts
    }
  }
}
