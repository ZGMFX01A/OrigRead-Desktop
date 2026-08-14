import type { DatabaseSync } from 'node:sqlite'

export const CURRENT_SCHEMA_VERSION = 2
export const DEFAULT_GROUP_ID = 'local-default'

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

