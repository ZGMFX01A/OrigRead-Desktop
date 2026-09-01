import type { DatabaseSync } from 'node:sqlite'
import {
  ORIGREAD_DESKTOP_RELEASE_FEED_ICON,
  ORIGREAD_DESKTOP_RELEASE_FEED_NAME,
  ORIGREAD_DESKTOP_RELEASE_FEED_URL,
  ORIGREAD_DESKTOP_RELEASES_URL
} from '../../shared/origread-release'

export const CURRENT_SCHEMA_VERSION = 11
export const DEFAULT_LOCAL_ACCOUNT_ID = 1
export const CURRENT_ACCOUNT_SETTING_KEY = 'account.current_id'

export function defaultGroupId(accountId: number): string {
  return `${accountId}$origread_app_default_group`
}

export const DEFAULT_GROUP_ID = defaultGroupId(DEFAULT_LOCAL_ACCOUNT_ID)

interface Migration {
  version: number
  up(database: DatabaseSync): void
}

function ensureWebSearchMessageColumns(database: DatabaseSync): void {
  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info('llm_messages')").all() as Array<{ name: string }>).map((column) => column.name)
  )
  const columns: Array<[name: string, definition: string]> = [
    [
      'web_search_status',
      `TEXT CHECK (
        web_search_status IS NULL OR web_search_status IN (
          'NOT_NEEDED','TRIGGERED','SUCCESS','EMPTY_RESULT','FAILED_FALLBACK','FAILED_REQUIRED','CANCELLED'
        )
      )`
    ],
    ['web_search_query', 'TEXT'],
    ['web_search_provider_name', 'TEXT'],
    ['web_search_result_count', 'INTEGER'],
    ['web_search_error_message', 'TEXT']
  ]

  for (const [name, definition] of columns) {
    if (existingColumns.has(name)) continue
    database.exec(`ALTER TABLE llm_messages ADD COLUMN ${name} ${definition}`)
    existingColumns.add(name)
  }
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
  },
  {
    version: 8,
    up(database) {
      database.exec(`
        CREATE TABLE llm_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          provider_id TEXT,
          model TEXT,
          skill_id TEXT,
          article_id TEXT,
          article_title TEXT,
          article_link TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX llm_conversations_updated_idx ON llm_conversations(updated_at DESC, id);
        CREATE INDEX llm_conversations_article_idx ON llm_conversations(article_id, updated_at DESC);

        CREATE TABLE llm_conversation_articles (
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          article_id TEXT NOT NULL,
          title TEXT NOT NULL,
          link TEXT,
          original_content TEXT NOT NULL,
          summary TEXT,
          position INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, article_id)
        ) STRICT;
        CREATE INDEX llm_conversation_articles_order_idx
          ON llm_conversation_articles(conversation_id, position, created_at, article_id);

        CREATE TABLE llm_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('SYSTEM','USER','ASSISTANT','TOOL')),
          content TEXT NOT NULL DEFAULT '',
          request_task TEXT CHECK (request_task IS NULL OR request_task IN ('CHAT','ARTICLE_ANALYSIS')),
          reasoning TEXT,
          status TEXT NOT NULL DEFAULT 'COMPLETE' CHECK (status IN ('COMPLETE','STREAMING','STOPPED','ERROR')),
          error_message TEXT,
          history_active INTEGER NOT NULL DEFAULT 1 CHECK (history_active IN (0,1)),
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          duration_ms INTEGER,
          token_usage_estimated INTEGER NOT NULL DEFAULT 0 CHECK (token_usage_estimated IN (0,1)),
          finish_reason TEXT CHECK (
            finish_reason IS NULL OR finish_reason IN ('STOP','LENGTH','TOOL_CALLS','CONTENT_FILTER','ERROR','CANCELLED','OTHER')
          ),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (id, conversation_id)
        ) STRICT;
        CREATE INDEX llm_messages_conversation_idx ON llm_messages(conversation_id, created_at, id);
        CREATE INDEX llm_messages_active_history_idx ON llm_messages(conversation_id, history_active, created_at, id);
        CREATE INDEX llm_messages_status_idx ON llm_messages(status, updated_at);

        CREATE TABLE llm_tool_calls (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          assistant_message_id TEXT NOT NULL,
          provider_call_id TEXT NOT NULL,
          tool_id TEXT NOT NULL,
          api_name TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL','RUNNING','COMPLETE','DENIED','ERROR')),
          result_content TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (assistant_message_id, provider_call_id),
          FOREIGN KEY (assistant_message_id, conversation_id)
            REFERENCES llm_messages(id, conversation_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX llm_tool_calls_conversation_idx ON llm_tool_calls(conversation_id, created_at, id);
        CREATE INDEX llm_tool_calls_message_idx ON llm_tool_calls(assistant_message_id, created_at, id);
        CREATE INDEX llm_tool_calls_status_idx ON llm_tool_calls(status, updated_at);

        CREATE TABLE llm_context_refs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          assistant_message_id TEXT NOT NULL,
          context_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN (
            'ARTICLE','ARTICLE_SUMMARY','ARTICLE_TRANSLATION','SELECTED_TEXT','WEB_SEARCH_RESULT','TOOL_RESULT','ADDITIONAL_ARTICLE','MANUAL'
          )),
          title TEXT,
          source_id TEXT,
          article_id TEXT,
          source_url TEXT,
          content_snapshot TEXT NOT NULL,
          prompt_content_snapshot TEXT,
          content_sha256 TEXT NOT NULL,
          priority INTEGER NOT NULL,
          included_in_prompt INTEGER NOT NULL CHECK (included_in_prompt IN (0,1)),
          truncated_in_prompt INTEGER NOT NULL CHECK (truncated_in_prompt IN (0,1)),
          created_at INTEGER NOT NULL,
          UNIQUE (assistant_message_id, context_id),
          UNIQUE (id, assistant_message_id, conversation_id),
          FOREIGN KEY (assistant_message_id, conversation_id)
            REFERENCES llm_messages(id, conversation_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX llm_context_refs_conversation_idx ON llm_context_refs(conversation_id, created_at, id);
        CREATE INDEX llm_context_refs_message_idx ON llm_context_refs(assistant_message_id, priority DESC, created_at, id);
        CREATE INDEX llm_context_refs_source_idx ON llm_context_refs(source_id, article_id);

        CREATE TABLE llm_evidence_blocks (
          id TEXT PRIMARY KEY,
          context_ref_id TEXT NOT NULL REFERENCES llm_context_refs(id) ON DELETE CASCADE,
          stable_locator_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'HEADING','PARAGRAPH','LIST_ITEM','BLOCKQUOTE','CODE','TABLE_ROW','SELECTION','SEARCH_RESULT','TOOL_RESULT'
          )),
          ordinal INTEGER NOT NULL,
          text_snapshot TEXT NOT NULL,
          normalized_sha256 TEXT NOT NULL,
          locator_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (context_ref_id, stable_locator_key),
          UNIQUE (id, context_ref_id)
        ) STRICT;
        CREATE INDEX llm_evidence_blocks_context_idx ON llm_evidence_blocks(context_ref_id, ordinal, id);
        CREATE INDEX llm_evidence_blocks_hash_idx ON llm_evidence_blocks(normalized_sha256);

        CREATE TABLE llm_citation_refs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          assistant_message_id TEXT NOT NULL,
          context_ref_id TEXT NOT NULL,
          evidence_block_id TEXT,
          target_kind TEXT NOT NULL CHECK (target_kind IN ('EVIDENCE_BLOCK','CONTEXT_REF')),
          protocol_id TEXT NOT NULL,
          display_order INTEGER,
          quote_snapshot TEXT NOT NULL,
          source_url TEXT,
          locator_json TEXT,
          schema_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          CHECK (
            (target_kind = 'EVIDENCE_BLOCK' AND evidence_block_id IS NOT NULL)
            OR (target_kind = 'CONTEXT_REF' AND evidence_block_id IS NULL)
          ),
          UNIQUE (assistant_message_id, protocol_id),
          FOREIGN KEY (assistant_message_id, conversation_id)
            REFERENCES llm_messages(id, conversation_id) ON DELETE CASCADE,
          FOREIGN KEY (context_ref_id, assistant_message_id, conversation_id)
            REFERENCES llm_context_refs(id, assistant_message_id, conversation_id) ON DELETE CASCADE,
          FOREIGN KEY (evidence_block_id, context_ref_id)
            REFERENCES llm_evidence_blocks(id, context_ref_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX llm_citation_refs_message_idx ON llm_citation_refs(assistant_message_id, display_order, protocol_id);
        CREATE INDEX llm_citation_refs_context_idx ON llm_citation_refs(context_ref_id, id);
        CREATE INDEX llm_citation_refs_evidence_idx ON llm_citation_refs(evidence_block_id, id);
      `)
    }
  },
  {
    version: 9,
    up(database) {
      database.exec(`
        ALTER TABLE llm_messages ADD COLUMN provider_id TEXT;
        ALTER TABLE llm_messages ADD COLUMN model TEXT;

        UPDATE llm_messages
        SET provider_id=(
              SELECT c.provider_id FROM llm_conversations c WHERE c.id=llm_messages.conversation_id
            ),
            model=(
              SELECT c.model FROM llm_conversations c WHERE c.id=llm_messages.conversation_id
            )
        WHERE role='ASSISTANT';
      `)
    }
  },
  {
    version: 10,
    up(database) {
      // D5 开发版曾出现过“v10 列已经部分落盘，但 schema_migrations 仍停在 v9”
      // 的真实数据库漂移。这里按实际列状态补齐，避免重复 ADD COLUMN 在窗口创建前终止启动。
      ensureWebSearchMessageColumns(database)
    }
  },
  {
    version: 11,
    up(database) {
      // 兼容更早开发包已经记录 v10、但当时 v10 定义尚未稳定的数据库。
      ensureWebSearchMessageColumns(database)
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

