import type { DatabaseSync } from 'node:sqlite'
import {
  ORIGREAD_DESKTOP_RELEASE_FEED_ICON,
  ORIGREAD_DESKTOP_RELEASE_FEED_NAME,
  ORIGREAD_DESKTOP_RELEASE_FEED_URL,
  ORIGREAD_DESKTOP_RELEASES_URL
} from '../../shared/origread-release'

export const CURRENT_SCHEMA_VERSION = 38
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

function ensureColumnIfTableExists(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string
): void {
  const columns = database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>
  if (columns.length === 0 || columns.some((item) => item.name === column)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
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

function ensureRssHubDescriptorColumns(database: DatabaseSync): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rsshub_source_urls'")
    .get()
  if (!table) return
  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info('rsshub_source_urls')").all() as Array<{ name: string }>).map((column) => column.name)
  )
  const columns: Array<[name: string, definition: string]> = [
    ['route_path', 'TEXT'],
    ['preferred_instance', 'TEXT'],
    ['last_resolved_instance', 'TEXT'],
    ['last_resolved_url', 'TEXT']
  ]
  for (const [name, definition] of columns) {
    if (existingColumns.has(name)) continue
    database.exec(`ALTER TABLE rsshub_source_urls ADD COLUMN ${name} ${definition}`)
    existingColumns.add(name)
  }
  database.exec('CREATE INDEX IF NOT EXISTS rsshub_source_urls_route_idx ON rsshub_source_urls(route_path)')
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
  },
  {
    version: 12,
    up(database) {
      database.exec(`
        CREATE TABLE llm_citation_annotations (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES llm_conversations(id) ON DELETE CASCADE,
          assistant_message_id TEXT NOT NULL,
          canonical_insertion_offset INTEGER NOT NULL CHECK (canonical_insertion_offset >= 0),
          occurrence_ordinal INTEGER NOT NULL CHECK (occurrence_ordinal >= 0),
          schema_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (assistant_message_id, occurrence_ordinal),
          FOREIGN KEY (assistant_message_id, conversation_id)
            REFERENCES llm_messages(id, conversation_id) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX llm_citation_annotations_message_offset_idx
          ON llm_citation_annotations(assistant_message_id, canonical_insertion_offset, occurrence_ordinal);

        CREATE TABLE llm_citation_annotation_refs (
          annotation_id TEXT NOT NULL REFERENCES llm_citation_annotations(id) ON DELETE CASCADE,
          citation_ref_id TEXT NOT NULL REFERENCES llm_citation_refs(id) ON DELETE CASCADE,
          ref_ordinal INTEGER NOT NULL CHECK (ref_ordinal >= 0),
          PRIMARY KEY (annotation_id, citation_ref_id),
          UNIQUE (annotation_id, ref_ordinal)
        ) STRICT;
        CREATE INDEX llm_citation_annotation_refs_citation_idx
          ON llm_citation_annotation_refs(citation_ref_id, annotation_id);
      `)
    }
  },
  {
    version: 13,
    up(database) {
      // R10 SYNC-0 only establishes the identity namespace. Existing library/chat rows are
      // intentionally not backfilled here; Genesis Backfill is a separate, resumable step.
      database.exec(`
        CREATE TABLE sync_spaces (
          sync_space_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sync_identity_mapping (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          local_id TEXT NOT NULL,
          sync_id TEXT NOT NULL,
          canonical_key TEXT,
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id, entity_type, local_id)
        ) STRICT;

        CREATE UNIQUE INDEX sync_identity_mapping_space_type_sync_idx
          ON sync_identity_mapping(sync_space_id, entity_type, sync_id);
        CREATE INDEX sync_identity_mapping_space_type_canonical_idx
          ON sync_identity_mapping(sync_space_id, entity_type, canonical_key);
      `)
    }
  },
  {
    version: 14,
    up(database) {
      database.exec(`
        CREATE TABLE sync_local_space_binding (
          local_account_id INTEGER PRIMARY KEY,
          sync_space_id TEXT NOT NULL UNIQUE,
          lifecycle_state TEXT NOT NULL,
          genesis_session_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sync_device_identity (
          singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
          device_id TEXT NOT NULL,
          witness_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sync_actor_incarnation (
          actor_incarnation_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
          created_at INTEGER NOT NULL,
          retired_at INTEGER
        ) STRICT;
        CREATE INDEX sync_actor_incarnation_space_status_idx
          ON sync_actor_incarnation(sync_space_id, status);
        CREATE INDEX sync_actor_incarnation_device_idx
          ON sync_actor_incarnation(device_id);

        CREATE TABLE sync_lane_writer_state (
          sync_space_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id, actor_incarnation_id, replication_lane_id)
        ) STRICT;
        CREATE INDEX sync_lane_writer_state_space_lane_idx
          ON sync_lane_writer_state(sync_space_id, replication_lane_id);

        CREATE TABLE sync_applied_frontier (
          sync_space_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          applied_prefix INTEGER NOT NULL CHECK (applied_prefix >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id, replication_lane_id, actor_incarnation_id)
        ) STRICT;
        CREATE INDEX sync_applied_frontier_space_lane_idx
          ON sync_applied_frontier(sync_space_id, replication_lane_id);

        CREATE TABLE sync_outbox (
          outbox_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          entity_generation INTEGER NOT NULL CHECK (entity_generation >= 0),
          mutation_type TEXT NOT NULL,
          payload_schema_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          causal_context_json TEXT NOT NULL,
          observed_entity_version_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('PENDING_BUILD','BUILT','FAILED')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX sync_outbox_actor_lane_sequence_idx
          ON sync_outbox(actor_incarnation_id, replication_lane_id, sequence);
        CREATE INDEX sync_outbox_space_status_created_idx
          ON sync_outbox(sync_space_id, status, created_at);
        CREATE INDEX sync_outbox_space_entity_idx
          ON sync_outbox(sync_space_id, entity_type, entity_sync_id);
      `)
    }
  },
  {
    version: 15,
    up(database) {
      database.exec(`
        CREATE TABLE sync_operation_log (
          operation_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          author_device_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          logical_clock INTEGER NOT NULL CHECK (logical_clock > 0),
          causal_context_json TEXT NOT NULL,
          dependency_dots_json TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          entity_generation INTEGER NOT NULL CHECK (entity_generation >= 0),
          operation_type TEXT NOT NULL,
          payload_schema_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          auth_grant_id TEXT,
          auth_epoch INTEGER,
          created_wall_clock INTEGER NOT NULL,
          payload_hash TEXT NOT NULL,
          signing_digest TEXT NOT NULL,
          author_signature TEXT,
          build_status TEXT NOT NULL CHECK (build_status IN ('AWAITING_SIGNATURE','SIGNED','REJECTED')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX sync_operation_log_actor_lane_sequence_idx
          ON sync_operation_log(actor_incarnation_id, replication_lane_id, sequence);
        CREATE INDEX sync_operation_log_space_status_created_idx
          ON sync_operation_log(sync_space_id, build_status, created_wall_clock);
        CREATE INDEX sync_operation_log_space_entity_idx
          ON sync_operation_log(sync_space_id, entity_type, entity_sync_id);
      `)
    }
  },
  {
    version: 16,
    up(database) {
      database.exec(`
        ALTER TABLE sync_outbox ADD COLUMN genesis_included_at INTEGER;

        CREATE TABLE sync_genesis_session (
          genesis_session_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          genesis_baseline_id TEXT NOT NULL,
          cross_db_cut_id TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('CAPTURING','CUT_CAPTURED','SNAPSHOT_BUILT','TAIL_REPLAY','ACTIVE','FAILED')),
          captured_at INTEGER,
          lane_frontiers_json TEXT NOT NULL,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (sync_space_id, genesis_baseline_id)
        ) STRICT;
        CREATE INDEX sync_genesis_session_space_stage_idx
          ON sync_genesis_session(sync_space_id, stage, updated_at);

        CREATE TABLE sync_snapshot_bundle (
          snapshot_bundle_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          genesis_session_id TEXT NOT NULL,
          genesis_baseline_id TEXT NOT NULL,
          snapshot_class TEXT NOT NULL CHECK (snapshot_class IN ('WORKING','GC_BASELINE','BOOTSTRAP_RECOVERY')),
          root_hash TEXT NOT NULL,
          policy_hash TEXT NOT NULL,
          captured_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (sync_space_id, genesis_baseline_id, snapshot_class)
        ) STRICT;
        CREATE INDEX sync_snapshot_bundle_space_created_idx
          ON sync_snapshot_bundle(sync_space_id, created_at);

        CREATE TABLE sync_snapshot_shard (
          snapshot_bundle_id TEXT NOT NULL,
          sync_space_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          frontier_json TEXT NOT NULL,
          entity_state_json TEXT NOT NULL,
          field_version_state_json TEXT NOT NULL,
          causal_metadata_json TEXT NOT NULL,
          genesis_coverage_json TEXT NOT NULL,
          deletion_generation_summary_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (snapshot_bundle_id, replication_lane_id)
        ) STRICT;
        CREATE INDEX sync_snapshot_shard_space_lane_idx
          ON sync_snapshot_shard(sync_space_id, replication_lane_id, created_at);

        CREATE TABLE sync_genesis_operation_coverage (
          operation_id TEXT PRIMARY KEY,
          genesis_session_id TEXT NOT NULL,
          included_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sync_genesis_operation_coverage_session_idx
          ON sync_genesis_operation_coverage(genesis_session_id);
      `)
    }
  },
  {
    version: 17,
    up(database) {
      // R10/R11/R12 durable receive/apply state. Operation log rows are the canonical signed
      // history; these tables deliberately keep transport progress separate from business apply.
      database.exec(`
        CREATE TABLE sync_inbox_operation (
          operation_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          state TEXT NOT NULL CHECK (state IN ('PENDING','APPLIED','REJECTED')),
          operation_json TEXT NOT NULL,
          rejection_reason TEXT,
          rejection_digest TEXT,
          received_at INTEGER NOT NULL,
          applied_at INTEGER,
          last_error TEXT
        ) STRICT;
        CREATE UNIQUE INDEX sync_inbox_operation_actor_lane_sequence_idx
          ON sync_inbox_operation(actor_incarnation_id, replication_lane_id, sequence);
        CREATE INDEX sync_inbox_operation_space_state_idx
          ON sync_inbox_operation(sync_space_id, state, received_at);

        CREATE TABLE sync_coverage (
          sync_space_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          received_prefix INTEGER NOT NULL DEFAULT 0 CHECK (received_prefix >= 0),
          applied_prefix INTEGER NOT NULL DEFAULT 0 CHECK (applied_prefix >= 0),
          retained_prefix INTEGER NOT NULL DEFAULT 0 CHECK (retained_prefix >= 0),
          snapshot_prefix INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_prefix >= 0),
          stable_gc_prefix INTEGER NOT NULL DEFAULT 0 CHECK (stable_gc_prefix >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id, replication_lane_id, actor_incarnation_id)
        ) STRICT;

        CREATE TABLE sync_apply_journal (
          operation_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('STARTED','COMMITTED','FAILED')),
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error_message TEXT
        ) STRICT;

        CREATE TABLE sync_peer_identity (
          sync_space_id TEXT NOT NULL,
          device_id TEXT NOT NULL,
          public_key_spki_base64 TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
          auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id, device_id)
        ) STRICT;

        CREATE TABLE sync_endpoint_config (
          endpoint_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('LAN','SERVER','MANUAL')),
          url TEXT NOT NULL,
          display_name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_error TEXT
        ) STRICT;
        CREATE INDEX sync_endpoint_config_space_enabled_idx
          ON sync_endpoint_config(sync_space_id, enabled, updated_at);

        CREATE TABLE sync_peer_cursor (
          endpoint_id TEXT PRIMARY KEY REFERENCES sync_endpoint_config(endpoint_id) ON DELETE CASCADE,
          sync_space_id TEXT NOT NULL,
          cursor_json TEXT,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sync_blob_manifest (
          hash TEXT PRIMARY KEY,
          total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
          media_type TEXT,
          durability TEXT NOT NULL CHECK (durability IN ('CACHE','REHYDRATABLE','SYNC_DURABLE')),
          reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
          persisted_at INTEGER,
          last_accessed_at INTEGER
        ) STRICT;
      `)
    }
  },
  {
    version: 18,
    up(database) {
      database.exec(`
        CREATE TABLE sync_field_version (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          field_id TEXT NOT NULL,
          entity_generation INTEGER NOT NULL CHECK (entity_generation >= 0),
          version_token TEXT NOT NULL,
          source_operation_id TEXT,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id,entity_type,entity_sync_id,field_id)
        ) STRICT;
        CREATE INDEX sync_field_version_space_entity_idx
          ON sync_field_version(sync_space_id,entity_type,entity_sync_id);

        CREATE TABLE sync_entity_alias (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          alias_sync_id TEXT NOT NULL,
          canonical_sync_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id,entity_type,alias_sync_id)
        ) STRICT;

        CREATE TABLE sync_entity_tombstone (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          version_token TEXT NOT NULL,
          deleted_at INTEGER NOT NULL,
          PRIMARY KEY (sync_space_id,entity_type,entity_sync_id)
        ) STRICT;
      `)
    }
  },
  {
    version: 19,
    up(database) {
      database.exec(`
        CREATE TABLE sync_auth_ledger (
          auth_object_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 0),
          auth_object_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sync_auth_ledger_space_epoch_idx
          ON sync_auth_ledger(sync_space_id, auth_epoch);
      `)
    }
  },
  {
    version: 20,
    up(database) {
      database.exec(`
        CREATE TABLE sync_field_rollback_baseline (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          entity_generation INTEGER NOT NULL,
          field_id TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY(sync_space_id,entity_type,entity_sync_id,entity_generation,field_id)
        ) STRICT;
      `)
    }
  },
  {
    version: 21,
    up(database) {
      database.exec(`
        ALTER TABLE sync_inbox_operation
          ADD COLUMN authorization_state TEXT NOT NULL DEFAULT 'PROVISIONAL_AUTHORIZED';
        ALTER TABLE sync_inbox_operation
          ADD COLUMN stabilized_by_auth_object_id TEXT;
        CREATE INDEX sync_inbox_operation_space_auth_state_idx
          ON sync_inbox_operation(sync_space_id, state, authorization_state);
      `)
    }
  },
  {
    version: 22,
    up(database) {
      database.exec(`
        CREATE TABLE sync_recovery_capsule (
          capsule_id TEXT PRIMARY KEY,
          sync_space_id TEXT NOT NULL,
          target_snapshot_bundle_id TEXT NOT NULL,
          coverage_json TEXT NOT NULL,
          operation_ids_json TEXT NOT NULL,
          pending_outbox_ids_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX sync_recovery_capsule_space_created_idx
          ON sync_recovery_capsule(sync_space_id, created_at DESC);
      `)
    }
  },
  {
    version: 23,
    up(database) {
      database.exec(`
        ALTER TABLE sync_recovery_capsule
          ADD COLUMN recovery_state_json TEXT NOT NULL DEFAULT '{}';
      `)
    }
  },
  {
    version: 24,
    up(database) {
      database.exec(`
        CREATE TABLE sync_alias_edge (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          left_sync_id TEXT NOT NULL,
          left_generation INTEGER NOT NULL CHECK (left_generation >= 0),
          right_sync_id TEXT NOT NULL,
          right_generation INTEGER NOT NULL CHECK (right_generation >= 0),
          source_operation_id TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,entity_type,left_sync_id,left_generation,right_sync_id,right_generation)
        ) STRICT;

        CREATE TABLE sync_entity_alias_v2 (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          alias_sync_id TEXT NOT NULL,
          canonical_sync_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation >= 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,entity_type,alias_sync_id,generation)
        ) STRICT;
        INSERT INTO sync_entity_alias_v2(sync_space_id,entity_type,alias_sync_id,canonical_sync_id,generation,created_at)
          SELECT sync_space_id,entity_type,alias_sync_id,canonical_sync_id,generation,created_at FROM sync_entity_alias;
        DROP TABLE sync_entity_alias;
        ALTER TABLE sync_entity_alias_v2 RENAME TO sync_entity_alias;

        CREATE TABLE sync_local_eviction (
          sync_space_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_sync_id TEXT NOT NULL,
          entity_generation INTEGER NOT NULL CHECK (entity_generation >= 0),
          resource_kind TEXT NOT NULL,
          evicted_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,entity_type,entity_sync_id,entity_generation,resource_kind)
        ) STRICT;
      `)
    }
  },
  {
    version: 25,
    up(database) {
      database.exec(`
        ALTER TABLE sync_blob_manifest ADD COLUMN compression TEXT;
        ALTER TABLE sync_blob_manifest ADD COLUMN encryption_info_json TEXT;
        ALTER TABLE sync_blob_manifest ADD COLUMN availability_policy TEXT NOT NULL DEFAULT 'LAZY';
        ALTER TABLE sync_blob_manifest ADD COLUMN availability_state TEXT NOT NULL DEFAULT 'METADATA_READY';
        ALTER TABLE sync_blob_manifest ADD COLUMN failure_reason TEXT;
        ALTER TABLE sync_snapshot_shard ADD COLUMN blob_manifest_index_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE sync_snapshot_shard ADD COLUMN blob_reference_index_json TEXT NOT NULL DEFAULT '[]';

        CREATE TABLE sync_blob_reference (
          sync_space_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          owner_entity_type TEXT NOT NULL,
          owner_entity_sync_id TEXT NOT NULL,
          owner_entity_generation INTEGER NOT NULL CHECK(owner_entity_generation >= 0),
          reference_kind TEXT NOT NULL,
          hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,replication_lane_id,owner_entity_type,owner_entity_sync_id,owner_entity_generation,reference_kind,hash)
        ) STRICT;
        CREATE INDEX sync_blob_reference_space_lane_idx ON sync_blob_reference(sync_space_id,replication_lane_id);
        CREATE INDEX sync_blob_reference_hash_idx ON sync_blob_reference(hash);

        CREATE TABLE sync_blob_persisted_ack (
          sync_space_id TEXT NOT NULL,
          hash TEXT NOT NULL,
          replica_id TEXT NOT NULL,
          total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
          persisted_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,hash,replica_id)
        ) STRICT;
        CREATE INDEX sync_blob_persisted_ack_hash_idx ON sync_blob_persisted_ack(hash);
      `)
    }
  },
  {
    version: 26,
    up(database) {
      database.exec(`
        ALTER TABLE sync_snapshot_bundle
          ADD COLUMN auth_stability_checkpoint_id TEXT;
      `)
    }
  },
  {
    version: 27,
    up(database) {
      database.exec(`
        CREATE TABLE sync_actor_author (
          sync_space_id TEXT NOT NULL,
          actor_incarnation_id TEXT NOT NULL,
          author_device_id TEXT NOT NULL,
          PRIMARY KEY(sync_space_id,actor_incarnation_id)
        ) STRICT;
        INSERT INTO sync_actor_author
          SELECT DISTINCT sync_space_id,actor_incarnation_id,author_device_id FROM sync_operation_log;
        CREATE TRIGGER sync_operation_bind_author BEFORE INSERT ON sync_operation_log BEGIN
          INSERT OR IGNORE INTO sync_actor_author VALUES(NEW.sync_space_id,NEW.actor_incarnation_id,NEW.author_device_id);
          SELECT CASE WHEN EXISTS(SELECT 1 FROM sync_actor_author WHERE sync_space_id=NEW.sync_space_id
            AND actor_incarnation_id=NEW.actor_incarnation_id AND author_device_id<>NEW.author_device_id)
            THEN RAISE(ABORT,'AUTH_FAILED: actor belongs to another author') END;
        END;
      `)
    }
  },
  {
    version: 28,
    up(database) {
      ensureColumnIfTableExists(
        database,
        'articles',
        'is_read_later',
        'INTEGER NOT NULL DEFAULT 0 CHECK(is_read_later IN (0,1))'
      )
    }
  },
  {
    version: 29,
    up(database) {
      ensureColumnIfTableExists(database, 'sync_field_version', 'causal_context_json', 'TEXT')
      ensureColumnIfTableExists(database, 'sync_field_version', 'logical_clock', 'INTEGER')
    }
  },
  {
    version: 30,
    up(database) {
      database.exec(`CREATE TABLE IF NOT EXISTS sync_field_candidate (
        sync_space_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_sync_id TEXT NOT NULL,
        field_id TEXT NOT NULL, entity_generation INTEGER NOT NULL, version_token TEXT NOT NULL,
        source_operation_id TEXT, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
        causal_context_json TEXT, logical_clock INTEGER,
        PRIMARY KEY(sync_space_id,entity_type,entity_sync_id,entity_generation,field_id,version_token)
      ) STRICT;
      INSERT OR IGNORE INTO sync_field_candidate SELECT * FROM sync_field_version;`)
    }
  },
  {
    version: 31,
    up(database) {
      ensureColumnIfTableExists(database, 'sync_entity_tombstone', 'source_operation_id', 'TEXT')
    }
  },
  {
    version: 32,
    up(database) {
      database.exec(`CREATE TABLE IF NOT EXISTS sync_trusted_device (
        id TEXT PRIMARY KEY,
        sync_space_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        static_public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        display_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        trust_state TEXT NOT NULL CHECK (trust_state IN ('TRUSTED','REVOKED','PROVISIONAL')),
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        auth_epoch INTEGER NOT NULL DEFAULT 0,
        UNIQUE(sync_space_id, device_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_trusted_device_space_state_idx
        ON sync_trusted_device(sync_space_id, trust_state);`)
    }
  },
  {
    version: 33,
    up(database) {
      database.exec(`CREATE TABLE IF NOT EXISTS sync_run_history (
        run_id TEXT PRIMARY KEY,
        sync_space_id TEXT NOT NULL,
        endpoint_id TEXT,
        remote_device_id TEXT,
        transport TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        pushed_operations INTEGER NOT NULL DEFAULT 0,
        pulled_operations INTEGER NOT NULL DEFAULT 0,
        applied_operations INTEGER NOT NULL DEFAULT 0,
        rejected_operations INTEGER NOT NULL DEFAULT 0,
        blob_bytes_sent INTEGER NOT NULL DEFAULT 0,
        blob_bytes_received INTEGER NOT NULL DEFAULT 0,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_run_history_space_started_idx
        ON sync_run_history(sync_space_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS sync_run_history_endpoint_started_idx
        ON sync_run_history(endpoint_id, started_at DESC);`)
    }
  },
  {
    version: 34,
    up(database) {
      ensureColumnIfTableExists(database, 'sync_endpoint_config', 'local_bind_address', 'TEXT')
    }
  },
  {
    version: 35,
    up(database) {
      database.exec(`CREATE TABLE IF NOT EXISTS sync_peer_coverage_report (
        sync_space_id TEXT NOT NULL,
        peer_device_id TEXT NOT NULL,
        received_json TEXT NOT NULL DEFAULT '{}',
        applied_json TEXT NOT NULL DEFAULT '{}',
        retained_json TEXT NOT NULL DEFAULT '{}',
        coverage_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(sync_space_id,peer_device_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_peer_coverage_report_updated_idx
        ON sync_peer_coverage_report(sync_space_id,updated_at DESC);`)
    }
  },
  {
    version: 36,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sync_snapshot_stream_stage (
          sync_space_id TEXT NOT NULL,
          snapshot_bundle_id TEXT NOT NULL,
          source_snapshot_bundle_id TEXT NOT NULL,
          transport_peer_device_id TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,snapshot_bundle_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS sync_snapshot_stream_stage_space_updated_idx
          ON sync_snapshot_stream_stage(sync_space_id,updated_at DESC);

        CREATE TABLE IF NOT EXISTS sync_snapshot_stream_shard (
          sync_space_id TEXT NOT NULL,
          snapshot_bundle_id TEXT NOT NULL,
          replication_lane_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          shard_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,snapshot_bundle_id,replication_lane_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS sync_snapshot_stream_shard_bundle_idx
          ON sync_snapshot_stream_shard(sync_space_id,snapshot_bundle_id);
      `)
    }
  },
  {
    version: 37,
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sync_space_join_bootstrap (
          sync_space_id TEXT NOT NULL,
          local_account_id INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          PRIMARY KEY(sync_space_id,local_account_id)
        ) STRICT;
      `)
    }
  },
  {
    version: 38,
    up(database) {
      // Main v13 and sync v13..37 have different RSSHub layouts.
      // Keep both histories intact and converge them with an additive migration.
      ensureRssHubDescriptorColumns(database)
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
      // Released main v13 used this version for RSSHub descriptors, while sync v13
      // created the identity namespace. Repair that collision atomically with v14.
      if (currentVersion === 13 && migration.version === 14 && !database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_spaces'")
        .get()) {
        migrations.find((item) => item.version === 13)!.up(database)
      }
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
