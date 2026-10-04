
import {
  ORIGREAD_DESKTOP_RELEASE_FEED_ICON,
  ORIGREAD_DESKTOP_RELEASE_FEED_NAME,
  ORIGREAD_DESKTOP_RELEASE_FEED_URL,
  ORIGREAD_DESKTOP_RELEASES_URL
} from '../../shared/origread-release'

import { defaultGroupId, type Migration } from './migration-definition'

// 保持已发布迁移的顺序和 SQL，按数据职责拆分维护。
export const sourcesMigrations: Migration[] = [
{
    version: 4,
    up(database) {
      database.exec(`
        CREATE TABLE archived_articles (
          feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          link TEXT NOT NULL,
          archived_at INTEGER NOT NULL,
          PRIMARY KEY (feed_id, link)
        ) STRICT;
        CREATE INDEX archived_articles_feed_idx ON archived_articles(feed_id);
      `)
    }
  },
{
    version: 5,
    up(database) {
      database.exec(`
        CREATE TABLE rss_http_cache (
          feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          feed_url TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX rss_http_cache_url_idx ON rss_http_cache(feed_url);
      `)
    }
  },
{
    version: 6,
    up(database) {
      // 与 Android 初始 Local Account 的 OrigRead Releases 行为对齐：
      // 只在迁移发生时给最早的 Local Account 补一次内置项目 Release Feed。
      // 用户之后如果主动删除，不会在每次启动时被强行加回来。
      database.prepare(`
        INSERT INTO feeds (
          id, account_id, group_id, name, url, source_page_url, source_type, icon,
          is_notification, is_full_content, is_browser, dynamic_rendering, created_at, updated_at
        )
        SELECT
          'origread-desktop-releases-' || a.id,
          a.id,
          g.id,
          ?, ?, ?, 'rss', ?,
          0, 0, 0, 0, ?, ?
        FROM accounts a
        JOIN groups g ON g.account_id = a.id AND g.is_default = 1
        WHERE a.type = 'local'
          AND NOT EXISTS (
            SELECT 1 FROM feeds f
            WHERE f.account_id = a.id AND f.url = ?
          )
        ORDER BY a.id ASC
        LIMIT 1
      `).run(
        ORIGREAD_DESKTOP_RELEASE_FEED_NAME,
        ORIGREAD_DESKTOP_RELEASE_FEED_URL,
        ORIGREAD_DESKTOP_RELEASES_URL,
        ORIGREAD_DESKTOP_RELEASE_FEED_ICON,
        Date.now(),
        Date.now(),
        ORIGREAD_DESKTOP_RELEASE_FEED_URL
      )
    }
  },
{
    version: 7,
    up(database) {
      const defaultGroups = database
        .prepare('SELECT id, account_id, name, sort_order FROM groups WHERE is_default = 1')
        .all() as Array<{ id: string; account_id: number | bigint; name: string; sort_order: number | bigint }>

      const insertGroup = database.prepare(`
        INSERT OR IGNORE INTO groups (id, account_id, name, sort_order, is_default)
        VALUES (?, ?, ?, ?, 1)
      `)
      const moveFeeds = database.prepare('UPDATE feeds SET group_id = ? WHERE account_id = ? AND group_id = ?')
      const deleteGroup = database.prepare('DELETE FROM groups WHERE account_id = ? AND id = ?')

      for (const group of defaultGroups) {
        const accountId = Number(group.account_id)
        const targetId = defaultGroupId(accountId)
        if (group.id === targetId) continue

        insertGroup.run(targetId, accountId, group.name, Number(group.sort_order))
        moveFeeds.run(targetId, accountId, group.id)
        deleteGroup.run(accountId, group.id)
      }
    }
  }
]
