

import { type Migration } from './migration-definition'
import { ensureWebSearchMessageColumns, ensureRssHubDescriptorColumns } from './migration-compatibility'

// 保持已发布迁移的顺序和 SQL，按数据职责拆分维护。
export const annotationsMigrations: Migration[] = [
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
      ensureRssHubDescriptorColumns(database)
    }
  }
]
