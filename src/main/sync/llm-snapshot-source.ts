import type { DatabaseSync } from 'node:sqlite'

export interface LlmSnapshotSeed { entityType: string; localId: string; payloadJson: string }

/** 固定的拓扑读取顺序；未完成 Assistant 及其依赖对象不进入 Genesis 快照。 */
const SNAPSHOT_QUERIES = [
  ['conversation', 'SELECT * FROM llm_conversations ORDER BY created_at,id'],
  ['conversation_article', 'SELECT * FROM llm_conversation_articles ORDER BY conversation_id,position,article_id'],
  ['message', "SELECT * FROM llm_messages WHERE status<>'STREAMING' ORDER BY conversation_id,created_at,id"],
  ['tool_call', `SELECT t.* FROM llm_tool_calls t JOIN llm_messages m ON m.id=t.assistant_message_id
    WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' AND t.status IN ('COMPLETE','DENIED','ERROR') ORDER BY t.created_at,t.id`],
  ['context_ref', `SELECT c.* FROM llm_context_refs c JOIN llm_messages m ON m.id=c.assistant_message_id
    WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' ORDER BY c.created_at,c.id`],
  ['evidence_block', `SELECT e.* FROM llm_evidence_blocks e JOIN llm_context_refs c ON c.id=e.context_ref_id
    JOIN llm_messages m ON m.id=c.assistant_message_id WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' ORDER BY e.context_ref_id,e.ordinal,e.id`],
  ['citation_ref', `SELECT r.* FROM llm_citation_refs r JOIN llm_messages m ON m.id=r.assistant_message_id
    JOIN llm_context_refs c ON c.id=r.context_ref_id JOIN llm_messages cm ON cm.id=c.assistant_message_id
    WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' AND cm.role='ASSISTANT' AND cm.status<>'STREAMING'
      AND (r.evidence_block_id IS NULL OR EXISTS(SELECT 1 FROM llm_evidence_blocks e WHERE e.id=r.evidence_block_id AND e.context_ref_id=c.id))
    ORDER BY r.created_at,r.id`],
  ['citation_annotation', `SELECT a.* FROM llm_citation_annotations a JOIN llm_messages m ON m.id=a.assistant_message_id
    WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' ORDER BY a.created_at,a.id`],
  ['citation_annotation_ref', `SELECT ar.* FROM llm_citation_annotation_refs ar
    JOIN llm_citation_annotations a ON a.id=ar.annotation_id JOIN llm_messages m ON m.id=a.assistant_message_id
    JOIN llm_citation_refs r ON r.id=ar.citation_ref_id JOIN llm_context_refs c ON c.id=r.context_ref_id
    JOIN llm_messages cm ON cm.id=c.assistant_message_id JOIN llm_messages rm ON rm.id=r.assistant_message_id
    WHERE m.role='ASSISTANT' AND m.status<>'STREAMING' AND cm.role='ASSISTANT' AND cm.status<>'STREAMING'
      AND rm.role='ASSISTANT' AND rm.status<>'STREAMING'
      AND (r.evidence_block_id IS NULL OR EXISTS(SELECT 1 FROM llm_evidence_blocks e WHERE e.id=r.evidence_block_id AND e.context_ref_id=c.id))
    ORDER BY ar.annotation_id,ar.ref_ordinal,ar.citation_ref_id`]
] as const

/** 按数据库游标逐条转换 AI 对象，避免全量消息、引用集合和排序后的对象列表。 */
export function* iterateLlmSnapshotSeeds(options: {
  database: DatabaseSync
  converters: Readonly<Record<string, (row: Record<string, unknown>) => Omit<LlmSnapshotSeed, 'entityType'>>>
}): Generator<LlmSnapshotSeed> {
  for (const [entityType, sql] of SNAPSHOT_QUERIES) {
    const converter = options.converters[entityType]
    if (!converter) throw new Error('Missing LLM Snapshot converter: ' + entityType)
    for (const row of options.database.prepare(sql).iterate()) yield { entityType, ...converter(row) }
  }
}
