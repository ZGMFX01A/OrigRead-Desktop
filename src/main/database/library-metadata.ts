import type { DatabaseSync } from 'node:sqlite'
import type { FeedRecord } from '../../shared/library'

import type { RssHubSubscriptionDescriptor } from '../../shared/rsshub'

import type { LibraryRepository } from './library-repository'
import { RssHttpCacheRecord, FeedRow, toFeedRecord } from './library-rows'

/** 按RSS 元数据职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryMetadata {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  getRssHttpCache(feedId: string): RssHttpCacheRecord | null {
    const row = this.database.prepare(`
      SELECT feed_id, feed_url, etag, last_modified, updated_at
      FROM rss_http_cache
      WHERE feed_id = ?
    `).get(feedId) as {
      feed_id: string
      feed_url: string
      etag: string | null
      last_modified: string | null
      updated_at: number
    } | undefined
    return row ? {
      feedId: row.feed_id,
      feedUrl: row.feed_url,
      etag: row.etag,
      lastModified: row.last_modified,
      updatedAt: row.updated_at
    } : null
  }

  upsertRssHttpCache(cache: RssHttpCacheRecord): void {
    this.database.prepare(`
      INSERT INTO rss_http_cache (feed_id, feed_url, etag, last_modified, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET
        feed_url = excluded.feed_url,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        updated_at = excluded.updated_at
    `).run(cache.feedId, cache.feedUrl, cache.etag, cache.lastModified, cache.updatedAt)
  }

  setRssHubSourceUrl(feedId: string, sourceUrl: string): void {
    this.database.prepare(`
      INSERT INTO rsshub_source_urls (feed_id, source_url)
      VALUES (?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET source_url = excluded.source_url
    `).run(feedId, sourceUrl)
  }

  setRssHubDescriptor(feedId: string, descriptor: RssHubSubscriptionDescriptor): void {
    const originalInput = descriptor.originalInput.trim()
    if (!feedId || !originalInput) return
    this.database.prepare(`
      INSERT INTO rsshub_source_urls (
        feed_id, source_url, route_path, preferred_instance, last_resolved_instance, last_resolved_url
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id) DO UPDATE SET
        source_url = excluded.source_url,
        route_path = excluded.route_path,
        preferred_instance = excluded.preferred_instance,
        last_resolved_instance = excluded.last_resolved_instance,
        last_resolved_url = excluded.last_resolved_url
    `).run(
      feedId,
      originalInput,
      descriptor.routePath,
      descriptor.preferredInstance,
      descriptor.lastResolvedInstance,
      descriptor.lastResolvedUrl
    )
  }

  getRssHubSourceUrl(feedId: string): string | null {
    const row = this.database
      .prepare('SELECT source_url FROM rsshub_source_urls WHERE feed_id = ?')
      .get(feedId) as { source_url: string } | undefined
    return row?.source_url ?? null
  }

  getRssHubDescriptor(feedId: string): RssHubSubscriptionDescriptor | null {
    const row = this.database.prepare(`
      SELECT source_url, route_path, preferred_instance, last_resolved_instance, last_resolved_url
      FROM rsshub_source_urls
      WHERE feed_id = ?
    `).get(feedId) as {
      source_url: string
      route_path: string | null
      preferred_instance: string | null
      last_resolved_instance: string | null
      last_resolved_url: string | null
    } | undefined
    if (!row) return null
    return {
      originalInput: row.source_url,
      routePath: row.route_path,
      preferredInstance: row.preferred_instance,
      lastResolvedInstance: row.last_resolved_instance,
      lastResolvedUrl: row.last_resolved_url
    }
  }

  findRssHubFeedByRoute(routePath: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT f.id, f.account_id, f.group_id, f.name, f.url, f.source_page_url, f.source_type,
             f.icon, f.is_notification, f.is_full_content, f.is_browser, f.dynamic_rendering,
             f.created_at, f.updated_at
      FROM rsshub_source_urls r
      JOIN feeds f ON f.id = r.feed_id
      WHERE f.account_id = ? AND r.route_path = ?
      LIMIT 1
    `).get(this.library.getCurrentAccountId(), routePath) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  listRssHubDescriptors(): Record<string, RssHubSubscriptionDescriptor> {
    const rows = this.database.prepare(`
      SELECT r.feed_id, r.source_url, r.route_path, r.preferred_instance,
             r.last_resolved_instance, r.last_resolved_url
      FROM rsshub_source_urls r
      JOIN feeds f ON f.id = r.feed_id
      WHERE f.account_id = ?
    `).all(this.library.getCurrentAccountId()) as unknown as Array<{
      feed_id: string
      source_url: string
      route_path: string | null
      preferred_instance: string | null
      last_resolved_instance: string | null
      last_resolved_url: string | null
    }>
    return Object.fromEntries(rows.map((row) => [row.feed_id, {
      originalInput: row.source_url,
      routePath: row.route_path,
      preferredInstance: row.preferred_instance,
      lastResolvedInstance: row.last_resolved_instance,
      lastResolvedUrl: row.last_resolved_url
    }]))
  }

  listRssHubSourceUrls(): Record<string, string> {
    const rows = this.database.prepare(`
      SELECT r.feed_id, r.source_url
      FROM rsshub_source_urls r
      JOIN feeds f ON f.id = r.feed_id
      WHERE f.account_id = ?
    `).all(this.library.getCurrentAccountId()) as unknown as Array<{ feed_id: string; source_url: string }>
    return Object.fromEntries(rows.map((row) => [row.feed_id, row.source_url]))
  }
}
