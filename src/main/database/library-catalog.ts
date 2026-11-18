import type { DatabaseSync } from 'node:sqlite'
import type { FeedRecord, GroupRecord } from '../../shared/library'
import { sourceUrlComparisonKey } from '../../shared/source-url-normalizer'
import { validateGroupParent } from '../../shared/group-tree'

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

  getAccountType(accountId: number): string | null {
    const row = this.database
      .prepare('SELECT type FROM accounts WHERE id = ?')
      .get(accountId) as { type: string } | undefined
    return row?.type ?? null
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
      .prepare('SELECT id, account_id, name, sort_order, is_default, parent_id FROM groups WHERE account_id = ? ORDER BY sort_order, name')
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
    const accountId = group.accountId ?? this.getCurrentAccountId()
    const parentId = group.parentId ?? null

    const accountRow = this.database
      .prepare('SELECT type FROM accounts WHERE id = ?')
      .get(accountId) as { type: string } | undefined
    const isLocal = accountRow ? accountRow.type === 'local' : true

    // 检查已存在的分组
    const existingGroup = this.database
      .prepare('SELECT id, account_id, is_default, parent_id FROM groups WHERE id = ?')
      .get(group.id) as GroupRow | undefined

    if (existingGroup) {
      // 检查是否有子分组（带孩子）
      const childCountRow = this.database
        .prepare('SELECT COUNT(*) as count FROM groups WHERE parent_id = ?')
        .get(group.id) as { count: number | bigint }
      const hasChildren = Number(childCountRow.count) > 0

      if (hasChildren) {
        if (existingGroup.account_id !== accountId) {
          throw new Error('不能将带有子分组的分组转移到其他账户')
        }
        if (group.isDefault) {
          throw new Error('带有子分组的分组不能设为默认分组')
        }
      }
    }

    if (parentId !== null) {
      if (!isLocal) {
        throw new Error('远程账户分组不支持层级结构')
      }
      if (group.isDefault) {
        throw new Error('默认分组不允许设置父分组')
      }
      if (parentId === group.id) {
        throw new Error('分组不能将自身设为父分组')
      }
      const parentRow = this.database
        .prepare('SELECT id, account_id, is_default, parent_id FROM groups WHERE id = ?')
        .get(parentId) as GroupRow | undefined
      if (!parentRow) {
        throw new Error('指定的父分组不存在')
      }
      if (parentRow.account_id !== accountId) {
        throw new Error('父分组必须属于同一账户')
      }
      if (parentRow.is_default === 1) {
        throw new Error('默认分组不允许作为父分组')
      }
    }

    // 校验层级合法性：使用与共享纯函数一致的严谨深度（根 depth 1、子树高度有界环检测）与关系校验
    const allGroups = this.listGroupsForAccount(accountId)
    validateGroupParent({
      groupId: group.id,
      parentId,
      allGroups,
      isLocalAccount: isLocal,
      accountId,
      isDefault: group.isDefault,
      maxDepth: 32
    })

    this.database.prepare(`
      INSERT INTO groups (id, account_id, name, sort_order, is_default, parent_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        account_id = excluded.account_id,
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_default = excluded.is_default,
        parent_id = excluded.parent_id
    `).run(
      group.id,
      accountId,
      group.name,
      group.sortOrder,
      toSqlBoolean(group.isDefault),
      parentId
    )
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
    // 解除同账户内分组之间的 parent_id 自引用外键约束，避免 ON DELETE RESTRICT 阻断整账户删除
    this.database.prepare('UPDATE groups SET parent_id = NULL WHERE account_id = ?').run(accountId)
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

    // Remote cleanup only removes leaf groups. Preserve a local subtree intact.
    if (this.database.prepare('SELECT 1 FROM groups WHERE account_id = ? AND parent_id = ? LIMIT 1')
      .get(accountId, groupId)) return false

    this.database.prepare('DELETE FROM feeds WHERE account_id=? AND group_id=?').run(accountId,groupId)
    this.database.prepare('DELETE FROM groups WHERE account_id=? AND id=?').run(accountId,groupId)
    return true
  }
}
