-- Released main v13 fixture from commit 7f5461fad707d286855ce2615e7b793547a35fc3.
PRAGMA foreign_keys=OFF;
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
CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE archived_articles (
          feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
          link TEXT NOT NULL,
          archived_at INTEGER NOT NULL,
          PRIMARY KEY (feed_id, link)
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
CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
        ) STRICT;
CREATE TABLE llm_citation_annotation_refs (
          annotation_id TEXT NOT NULL REFERENCES llm_citation_annotations(id) ON DELETE CASCADE,
          citation_ref_id TEXT NOT NULL REFERENCES llm_citation_refs(id) ON DELETE CASCADE,
          ref_ordinal INTEGER NOT NULL CHECK (ref_ordinal >= 0),
          PRIMARY KEY (annotation_id, citation_ref_id),
          UNIQUE (annotation_id, ref_ordinal)
        ) STRICT;
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
          updated_at INTEGER NOT NULL, provider_id TEXT, model TEXT, web_search_status TEXT CHECK (
        web_search_status IS NULL OR web_search_status IN (
          'NOT_NEEDED','TRIGGERED','SUCCESS','EMPTY_RESULT','FAILED_FALLBACK','FAILED_REQUIRED','CANCELLED'
        )
      ), web_search_query TEXT, web_search_provider_name TEXT, web_search_result_count INTEGER, web_search_error_message TEXT,
          UNIQUE (id, conversation_id)
        ) STRICT;
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
CREATE TABLE rss_http_cache (
          feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          feed_url TEXT NOT NULL,
          etag TEXT,
          last_modified TEXT,
          updated_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE rsshub_source_urls (
          feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL
        , route_path TEXT, preferred_instance TEXT, last_resolved_instance TEXT, last_resolved_url TEXT) STRICT;
CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
CREATE INDEX archived_articles_feed_idx ON archived_articles(feed_id);
CREATE INDEX articles_account_id_idx ON articles(account_id, published_at DESC);
CREATE INDEX articles_feed_id_idx ON articles(account_id, feed_id);
CREATE INDEX articles_published_at_idx ON articles(account_id, published_at DESC);
CREATE INDEX articles_starred_idx ON articles(account_id, is_starred, published_at DESC);
CREATE INDEX articles_unread_idx ON articles(account_id, is_unread, published_at DESC);
CREATE INDEX feeds_account_id_idx ON feeds(account_id, name);
CREATE INDEX feeds_group_id_idx ON feeds(account_id, group_id);
CREATE INDEX feeds_source_type_idx ON feeds(account_id, source_type);
CREATE INDEX groups_account_id_idx ON groups(account_id, sort_order, name);
CREATE INDEX llm_citation_annotation_refs_citation_idx
          ON llm_citation_annotation_refs(citation_ref_id, annotation_id);
CREATE INDEX llm_citation_annotations_message_offset_idx
          ON llm_citation_annotations(assistant_message_id, canonical_insertion_offset, occurrence_ordinal);
CREATE INDEX llm_citation_refs_context_idx ON llm_citation_refs(context_ref_id, id);
CREATE INDEX llm_citation_refs_evidence_idx ON llm_citation_refs(evidence_block_id, id);
CREATE INDEX llm_citation_refs_message_idx ON llm_citation_refs(assistant_message_id, display_order, protocol_id);
CREATE INDEX llm_context_refs_conversation_idx ON llm_context_refs(conversation_id, created_at, id);
CREATE INDEX llm_context_refs_message_idx ON llm_context_refs(assistant_message_id, priority DESC, created_at, id);
CREATE INDEX llm_context_refs_source_idx ON llm_context_refs(source_id, article_id);
CREATE INDEX llm_conversation_articles_order_idx
          ON llm_conversation_articles(conversation_id, position, created_at, article_id);
CREATE INDEX llm_conversations_article_idx ON llm_conversations(article_id, updated_at DESC);
CREATE INDEX llm_conversations_updated_idx ON llm_conversations(updated_at DESC, id);
CREATE INDEX llm_evidence_blocks_context_idx ON llm_evidence_blocks(context_ref_id, ordinal, id);
CREATE INDEX llm_evidence_blocks_hash_idx ON llm_evidence_blocks(normalized_sha256);
CREATE INDEX llm_messages_active_history_idx ON llm_messages(conversation_id, history_active, created_at, id);
CREATE INDEX llm_messages_conversation_idx ON llm_messages(conversation_id, created_at, id);
CREATE INDEX llm_messages_status_idx ON llm_messages(status, updated_at);
CREATE INDEX llm_tool_calls_conversation_idx ON llm_tool_calls(conversation_id, created_at, id);
CREATE INDEX llm_tool_calls_message_idx ON llm_tool_calls(assistant_message_id, created_at, id);
CREATE INDEX llm_tool_calls_status_idx ON llm_tool_calls(status, updated_at);
CREATE INDEX rss_http_cache_url_idx ON rss_http_cache(feed_url);
CREATE INDEX rsshub_source_urls_route_idx ON rsshub_source_urls(route_path);
INSERT INTO "accounts" ("id","name","type","updated_at","last_article_id","sync_interval_minutes","sync_on_start","sync_only_on_wifi","sync_only_when_charging","keep_archived_millis","sync_block_list","server_url","username","created_at") VALUES (1,'OrigRead','local',NULL,NULL,30,0,0,0,2592000000,'[]',NULL,NULL,1790808708987);
INSERT INTO "app_settings" ("key","value","updated_at") VALUES ('account.current_id','1',1790808708987);
INSERT INTO "feeds" ("id","account_id","group_id","name","url","source_page_url","source_type","icon","is_notification","is_full_content","is_browser","dynamic_rendering","created_at","updated_at") VALUES ('origread-desktop-releases-1',1,'1$origread_app_default_group','OrigRead Desktop Releases','https://github.com/ZGMFX01A/OrigRead-Desktop/releases.atom','https://github.com/ZGMFX01A/OrigRead-Desktop/releases','rss','https://github.com/ZGMFX01A.png',0,0,0,0,1790808708988,1790808708988);
INSERT INTO "groups" ("id","account_id","name","sort_order","is_default") VALUES ('1$origread_app_default_group',1,'Default',0,1);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (1,1790808708987);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (2,1790808708987);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (3,1790808708988);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (4,1790808708988);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (5,1790808708988);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (6,1790808708988);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (7,1790808708988);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (8,1790808708989);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (9,1790808708989);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (10,1790808708990);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (11,1790808708990);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (12,1790808708990);
INSERT INTO "schema_migrations" ("version","applied_at") VALUES (13,1790808708991);
