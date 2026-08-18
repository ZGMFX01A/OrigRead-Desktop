import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 4
export const DEFAULT_GROUP_ID = 'local-default'
export const DEFAULT_LOCAL_ACCOUNT_ID = 1
export const CURRENT_ACCOUNT_SETTING_KEY = 'account.current_id'

export function defaultGroupId(accountId: number): string {
  return `${accountId}$read_you_app_default_group`
}

interface Migration {
  version: number
  up(database: DatabaseSync): void
}

const migrations: Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
        ) STRICT;

        CREATE TABLE feeds (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          source_page_url TEXT,
          source_type TEXT NOT NULL CHECK (source_type IN ('rss', 'website', 'json')),
          icon TEXT,
          is_notification INTEGER NOT NULL DEFAULT 0 CHECK (is_notification IN (0, 1)),
          is_full_content INTEGER NOT NULL DEFAULT 0 CHECK (is_full_content IN (0, 1)),
          is_browser INTEGER NOT NULL DEFAULT 0 CHECK (is_browser IN (0, 1)),
          dynamic_rendering INTEGER NOT NULL DEFAULT 0 CHECK (dynamic_rendering IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX feeds_group_id_idx ON feeds(group_id);
        CREATE INDEX feeds_source_type_idx ON feeds(source_type);

        CREATE TABLE articles (
          id TEXT PRIMARY KEY,
          feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          url TEXT,
          author TEXT,
          published_at INTEGER,
          description TEXT NOT NULL DEFAULT '',
          content_html TEXT,
          full_content_html TEXT,
          is_unread INTEGER NOT NULL DEFAULT 1 CHECK (is_unread IN (0, 1)),
          is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX articles_feed_id_idx ON articles(feed_id);
        CREATE INDEX articles_published_at_idx ON articles(published_at DESC);
        CREATE INDEX articles_unread_idx ON articles(is_unread, published_at DESC);
        CREATE INDEX articles_starred_idx ON articles(is_starred, published_at DESC);

        CREATE TABLE rsshub_source_urls (
          feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL
        ) STRICT;

        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        INSERT INTO groups (id, name, sort_order, is_default)
        VALUES ('${DEFAULT_GROUP_ID}', 'Default', 0, 1);
      `)
    }
  },
  {
    version: 2,
    up(database) {
      database.exec('ALTER TABLE articles ADD COLUMN image_url TEXT')
    }
  },
  {
    version: 3,
    up(database) {
      // Android 的 Account 是所有 Group / Feed / Article 的隔离边界。Desktop 早期只有
      // 一个隐式本地账户，因此把现有全部数据无损归入 id=1 的 Local 账户，再重建表，
      // 同时把 feeds.url 的全局 UNIQUE 改为账户内 UNIQUE，允许不同账户订阅同一地址。
      database.exec(`
        ALTER TABLE articles RENAME TO articles_v2;
        ALTER TABLE rsshub_source_urls RENAME TO rsshub_source_urls_v2;
        ALTER TABLE feeds RENAME TO feeds_v2;
        ALTER TABLE groups RENAME TO groups_v2;

        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('local', 'fever', 'google_reader', 'fresh_rss')),
          updated_at INTEGER,
          last_article_id TEXT,
          sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
          sync_on_start INTEGER NOT NULL DEFAULT 0 CHECK (sync_on_start IN (0, 1)),
          sync_only_on_wifi INTEGER NOT NULL DEFAULT 0 CHECK (sync_only_on_wifi IN (0, 1)),
          sync_only_when_charging INTEGER NOT NULL DEFAULT 0 CHECK (sync_only_when_charging IN (0, 1)),
          keep_archived_millis INTEGER NOT NULL DEFAULT 2592000000,
          sync_block_list TEXT NOT NULL DEFAULT '[]',
          server_url TEXT,
          username TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;

        INSERT INTO accounts (
          id, name, type, sync_interval_minutes, sync_on_start, created_at
        ) VALUES (${DEFAULT_LOCAL_ACCOUNT_ID}, 'OrigRead', 'local', 30, 0, ${Date.now()});

        CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
        ) STRICT;

        CREATE TABLE feeds (
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          source_page_url TEXT,
          source_type TEXT NOT NULL CHECK (source_type IN ('rss', 'website', 'json')),
          icon TEXT,
          is_notification INTEGER NOT NULL DEFAULT 0 CHECK (is_notification IN (0, 1)),
          is_full_content INTEGER NOT NULL DEFAULT 0 CHECK (is_full_content IN (0, 1)),
          is_browser INTEGER NOT NULL DEFAULT 0 CHECK (is_browser IN (0, 1)),
          dynamic_rendering INTEGER NOT NULL DEFAULT 0 CHECK (dynamic_rendering IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(account_id, url)
        ) STRICT;

        CREATE TABLE articles (
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          url TEXT,
          author TEXT,
          published_at INTEGER,
          description TEXT NOT NULL DEFAULT '',
          content_html TEXT,
          full_content_html TEXT,
          image_url TEXT,
          is_unread INTEGER NOT NULL DEFAULT 1 CHECK (is_unread IN (0, 1)),
          is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE rsshub_source_urls (
          feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL
        ) STRICT;

        INSERT INTO groups (id, account_id, name, sort_order, is_default)
        SELECT id, ${DEFAULT_LOCAL_ACCOUNT_ID}, name, sort_order, is_default FROM groups_v2;

        INSERT INTO feeds (
          id, account_id, group_id, name, url, source_page_url, source_type, icon,
          is_notification, is_full_content, is_browser, dynamic_rendering, created_at, updated_at
        ) SELECT
          id, ${DEFAULT_LOCAL_ACCOUNT_ID}, group_id, name, url, source_page_url, source_type, icon,
          is_notification, is_full_content, is_browser, dynamic_rendering, created_at, updated_at
        FROM feeds_v2;

        INSERT INTO articles (
          id, account_id, feed_id, title, url, author, published_at, description,
          content_html, full_content_html, image_url, is_unread, is_starred, created_at, updated_at
        ) SELECT
          id, ${DEFAULT_LOCAL_ACCOUNT_ID}, feed_id, title, url, author, published_at, description,
          content_html, full_content_html, image_url, is_unread, is_starred, created_at, updated_at
        FROM articles_v2;

        INSERT INTO rsshub_source_urls (feed_id, source_url)
        SELECT feed_id, source_url FROM rsshub_source_urls_v2;

        DROP TABLE rsshub_source_urls_v2;
        DROP TABLE articles_v2;
        DROP TABLE feeds_v2;
        DROP TABLE groups_v2;

        CREATE INDEX groups_account_id_idx ON groups(account_id, sort_order, name);
        CREATE INDEX feeds_account_id_idx ON feeds(account_id, name);
        CREATE INDEX feeds_group_id_idx ON feeds(account_id, group_id);
        CREATE INDEX feeds_source_type_idx ON feeds(account_id, source_type);
        CREATE INDEX articles_account_id_idx ON articles(account_id, published_at DESC);
        CREATE INDEX articles_feed_id_idx ON articles(account_id, feed_id);
        CREATE INDEX articles_published_at_idx ON articles(account_id, published_at DESC);
        CREATE INDEX articles_unread_idx ON articles(account_id, is_unread, published_at DESC);
        CREATE INDEX articles_starred_idx ON articles(account_id, is_starred, published_at DESC);

        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('${CURRENT_ACCOUNT_SETTING_KEY}', '${DEFAULT_LOCAL_ACCOUNT_ID}', ${Date.now()})
        ON CONFLICT(key) DO NOTHING;
      `)
    }
  },
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
  }
]

export function applyMigrations(database: DatabaseSync): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `)

  const currentVersionRow = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number | bigint }
  let currentVersion = Number(currentVersionRow.version)

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    database.exec('BEGIN IMMEDIATE')
    try {
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
      database.exec('COMMIT')
      currentVersion = migration.version
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  if (currentVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported OrigRead database schema: ${currentVersion}`)
  }

  return currentVersion
}

