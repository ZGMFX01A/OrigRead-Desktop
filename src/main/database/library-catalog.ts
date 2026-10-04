import type { DatabaseSync } from 'node:sqlite'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'

import { CURRENT_ACCOUNT_SETTING_KEY, DEFAULT_LOCAL_ACCOUNT_ID } from './migrations'

import type { LibraryRepository } from './library-repository'
import { GroupRow, FeedRow, toSqlBoolean, toGroupRecord, toFeedRecord } from './library-rows'

/** 按账户与来源职责保留 SQLite 查询；调用方账户由入口显式捕获。 */
export class SqliteLibraryCatalog {
  constructor(private readonly database: DatabaseSync, private readonly library: LibraryRepository) {}

  getCurrentAccountId(): number {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(CURRENT_ACCOUNT_SETTING_KEY) as { value: string } | undefined
    const value = Number(row?.value ?? DEFAULT_LOCAL_ACCOUNT_ID)
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_LOCAL_ACCOUNT_ID
  }

  getFeedById(feedId: string): FeedRecord | null {
    return this.getFeedByIdForAccount(this.getCurrentAccountId(), feedId)
  }

  getFeedByIdForAccount(accountId: number, feedId: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ? AND id = ?
    `).get(accountId, feedId) as FeedRow | undefined
    return row ? toFeedRecord(row) : null
  }

  findFeedByUrl(url: string): FeedRecord | null {
    return this.findFeedByUrlForAccount(this.getCurrentAccountId(), url)
  }

  findFeedByUrlForAccount(accountId: number, url: string): FeedRecord | null {
    const row = this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ? AND url = ?
    `).get(accountId, url) as FeedRow | undefined
    if (row) return toFeedRecord(row)
    const candidateKey = sourceUrlComparisonKey(url)
    return this.listFeedsForAccount(accountId)
      .find((feed) => sourceUrlComparisonKey(feed.url) === candidateKey) ?? null
  }

  listGroups(): GroupRecord[] {
    return this.listGroupsForAccount(this.getCurrentAccountId())
  }

  listGroupsForAccount(accountId: number): GroupRecord[] {
    return (this.database
      .prepare('SELECT id, account_id, name, sort_order, is_default FROM groups WHERE account_id = ? ORDER BY sort_order, name')
      .all(accountId) as unknown as GroupRow[]).map(toGroupRecord)
  }

  getDefaultGroupForAccount(accountId: number): GroupRecord | null {
    return this.listGroupsForAccount(accountId).find((group) => group.isDefault) ?? null
  }

  getCurrentDefaultGroup(): GroupRecord {
    const accountId = this.getCurrentAccountId()
    const group = this.getDefaultGroupForAccount(accountId)
    if (!group) throw new Error('当前账户缺少默认分组')
    return group
  }

  upsertGroup(group: GroupRecord): void {
    this.database.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_default = excluded.is_default
    `).run(group.id, group.accountId ?? this.getCurrentAccountId(), group.name, group.sortOrder, toSqlBoolean(group.isDefault))
  }

  deleteFeed(feedId: string): void {
    this.database.prepare('DELETE FROM feeds WHERE account_id = ? AND id = ?')
      .run(this.getCurrentAccountId(), feedId)
  }

  listFeeds(): FeedRecord[] {
    return this.listFeedsForAccount(this.getCurrentAccountId())
  }

  listFeedsForAccount(accountId: number): FeedRecord[] {
    return (this.database.prepare(`
      SELECT id, account_id, group_id, name, url, source_page_url, source_type, icon,
             is_notification, is_full_content, is_browser, dynamic_rendering,
             created_at, updated_at
      FROM feeds
      WHERE account_id = ?
      ORDER BY name COLLATE NOCASE
    `).all(accountId) as unknown as FeedRow[]).map(toFeedRecord)
  }

  upsertFeed(feed: FeedRecord): void {
    this.database.prepare(`
      INSERT INTO feeds (
        id, account_id, group_id, name, url, source_page_url, source_type, icon,
        is_notification, is_full_content, is_browser, dynamic_rendering,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        group_id = excluded.group_id,
        name = excluded.name,
        url = excluded.url,
        source_page_url = excluded.source_page_url,
        source_type = excluded.source_type,
        icon = excluded.icon,
        is_notification = excluded.is_notification,
        is_full_content = excluded.is_full_content,
        is_browser = excluded.is_browser,
        dynamic_rendering = excluded.dynamic_rendering,
        updated_at = excluded.updated_at
    `).run(
      feed.id,
      feed.accountId ?? this.getCurrentAccountId(),
      feed.groupId,
      feed.name,
      feed.url,
      feed.sourcePageUrl,
      feed.sourceType,
      feed.icon,
      toSqlBoolean(feed.isNotification),
      toSqlBoolean(feed.isFullContent),
      toSqlBoolean(feed.isBrowser),
      toSqlBoolean(feed.dynamicRendering),
      feed.createdAt,
      feed.updatedAt
    )
  }

  deleteAccountData(accountId: number): void {
    this.database.prepare('DELETE FROM articles WHERE account_id = ?').run(accountId)
    this.database.prepare('DELETE FROM feeds WHERE account_id = ?').run(accountId)
    this.database.prepare('DELETE FROM groups WHERE account_id = ?').run(accountId)
  }

  deleteFeedForAccountIfNoStarred(accountId:number,feedId:string):boolean {
    const row=this.database.prepare('SELECT COUNT(*) AS count FROM articles WHERE account_id=? AND feed_id=? AND is_starred=1')
      .get(accountId,feedId) as {count:number|bigint}
    if(Number(row.count)>0)return false
    this.database.prepare('DELETE FROM feeds WHERE account_id=? AND id=?').run(accountId,feedId)
    return true
  }

  deleteGroupForAccountIfNoStarred(accountId:number,groupId:string):boolean {
    const row=this.database.prepare(`SELECT COUNT(*) AS count FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE a.account_id=? AND f.group_id=? AND a.is_starred=1`)
      .get(accountId,groupId) as {count:number|bigint}
    if(Number(row.count)>0)return false
    this.database.prepare('DELETE FROM feeds WHERE account_id=? AND group_id=?').run(accountId,groupId)
    this.database.prepare('DELETE FROM groups WHERE account_id=? AND id=?').run(accountId,groupId)
    return true
  }
}
