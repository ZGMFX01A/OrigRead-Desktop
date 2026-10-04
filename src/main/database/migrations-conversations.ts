

import { type Migration } from './migration-definition'

// 历史 SQL 保持不变；提取常量只缩短迁移或检索方法。
const HISTORICAL_MIGRATION_SQL_0 = `
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
      `

// 保持已发布迁移的顺序和 SQL，按数据职责拆分维护。
export const conversationsMigrations: Migration[] = [
{
    version: 8,
    up(database) {
      database.exec(HISTORICAL_MIGRATION_SQL_0)
    }
  }
]
