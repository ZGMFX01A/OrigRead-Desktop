import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  LLM_CITATION_SCHEMA_VERSION,
  LLM_EVIDENCE_SCHEMA_VERSION,
  type LlmCitationRefRecord,
  type LlmContextRefRecord,
  type LlmConversationArticleRecord,
  type LlmConversationRecord,
  type LlmEvidenceBlockRecord,
  type LlmEvidenceLocatorV1,
  type LlmMessageRecord,
  type LlmToolCallRecord
} from '../../shared/llm-chat'

type DbRowValue = string | number | bigint | null | undefined
type Row = Record<string, DbRowValue>

export interface CreateLlmConversationInput {
  id?: string
  title?: string
  providerId?: string | null
  model?: string | null
  skillId?: string | null
  articleId?: string | null
  articleTitle?: string | null
  articleLink?: string | null
  now?: number
}

export interface AppendLlmMessageInput {
  id?: string
  role: LlmMessageRecord['role']
  content?: string
  requestTask?: LlmMessageRecord['requestTask']
  providerId?: string | null
  model?: string | null
  status?: LlmMessageRecord['status']
  now?: number
}

/** Main-only persistence layer. Renderer never receives the raw DatabaseSync handle. */
export class LlmChatRepository {
  constructor(private readonly database: DatabaseSync) {}

  createConversation(input: CreateLlmConversationInput = {}): LlmConversationRecord {
    const now = input.now ?? Date.now()
    const record: LlmConversationRecord = {
      id: input.id?.trim() || randomUUID(),
      title: normalizeTitle(input.title),
      providerId: nullableText(input.providerId),
      model: nullableText(input.model),
      skillId: nullableText(input.skillId),
      articleId: nullableText(input.articleId),
      articleTitle: nullableText(input.articleTitle),
      articleLink: nullableText(input.articleLink),
      createdAt: now,
      updatedAt: now
    }
    this.database.prepare(`
      INSERT INTO llm_conversations (
        id,title,provider_id,model,skill_id,article_id,article_title,article_link,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id, record.title, record.providerId, record.model, record.skillId, record.articleId,
      record.articleTitle, record.articleLink, record.createdAt, record.updatedAt
    )
    return record
  }

  getConversation(id: string): LlmConversationRecord | null {
    const row = this.database.prepare('SELECT * FROM llm_conversations WHERE id=? LIMIT 1').get(id.trim()) as Row | undefined
    return row ? conversationFromRow(row) : null
  }

  listConversations(articleId?: string | null): LlmConversationRecord[] {
    const normalizedArticleId = nullableText(articleId)
    const rows = normalizedArticleId
      ? this.database.prepare('SELECT * FROM llm_conversations WHERE article_id=? ORDER BY updated_at DESC,id').all(normalizedArticleId)
      : this.database.prepare('SELECT * FROM llm_conversations ORDER BY updated_at DESC,id').all()
    return (rows as Row[]).map(conversationFromRow)
  }

  updateConversationTitle(id: string, title: string, now = Date.now()): LlmConversationRecord {
    const conversationId = id.trim()
    const normalized = normalizeTitle(title)
    const result = this.database.prepare('UPDATE llm_conversations SET title=?,updated_at=? WHERE id=?').run(normalized, now, conversationId)
    if (Number(result.changes) !== 1) throw new Error('会话不存在')
    const updated = this.getConversation(conversationId)
    if (!updated) throw new Error('会话不存在')
    return updated
  }

  updateConversationModel(
    id: string,
    providerId: string | null,
    model: string | null,
    now = Date.now()
  ): LlmConversationRecord {
    const conversationId = id.trim()
    const result = this.database.prepare(`
      UPDATE llm_conversations SET provider_id=?,model=?,updated_at=? WHERE id=?
    `).run(nullableText(providerId), nullableText(model), now, conversationId)
    if (Number(result.changes) !== 1) throw new Error('会话不存在')
    const updated = this.getConversation(conversationId)
    if (!updated) throw new Error('会话不存在')
    return updated
  }

  deleteConversation(id: string): boolean {
    return Number(this.database.prepare('DELETE FROM llm_conversations WHERE id=?').run(id.trim()).changes) === 1
  }

  appendMessage(conversationId: string, input: AppendLlmMessageInput): LlmMessageRecord {
    const id = conversationId.trim()
    const now = this.nextMessageTimestamp(id, input.now ?? Date.now())
    const record: LlmMessageRecord = {
      id: input.id?.trim() || randomUUID(),
      conversationId: id,
      role: input.role,
      content: input.content ?? '',
      requestTask: input.requestTask ?? null,
      providerId: nullableText(input.providerId),
      model: nullableText(input.model),
      reasoning: null,
      status: input.status ?? 'COMPLETE',
      errorMessage: null,
      historyActive: true,
      webSearchStatus: null,
      webSearchQuery: null,
      webSearchProviderName: null,
      webSearchResultCount: null,
      webSearchErrorMessage: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      tokenUsageEstimated: false,
      finishReason: null,
      createdAt: now,
      updatedAt: now
    }
    this.insertMessage(record)
    this.touchConversation(record.conversationId, now)
    return record
  }

  getMessage(id: string): LlmMessageRecord | null {
    const row = this.database.prepare('SELECT * FROM llm_messages WHERE id=? LIMIT 1').get(id.trim()) as Row | undefined
    return row ? messageFromRow(row) : null
  }

  getMessages(conversationId: string, activeOnly = false): LlmMessageRecord[] {
    const rows = activeOnly
      ? this.database.prepare(`
          SELECT * FROM llm_messages WHERE conversation_id=? AND history_active=1 ORDER BY created_at,id
        `).all(conversationId.trim())
      : this.database.prepare('SELECT * FROM llm_messages WHERE conversation_id=? ORDER BY created_at,id').all(conversationId.trim())
    return (rows as Row[]).map(messageFromRow)
  }

  updateMessage(record: LlmMessageRecord, touchConversation = true): void {
    this.database.prepare(`
      UPDATE llm_messages SET
        content=?,request_task=?,provider_id=?,model=?,reasoning=?,status=?,error_message=?,history_active=?,
        web_search_status=?,web_search_query=?,web_search_provider_name=?,web_search_result_count=?,web_search_error_message=?,
        prompt_tokens=?,completion_tokens=?,duration_ms=?,token_usage_estimated=?,finish_reason=?,updated_at=?
      WHERE id=? AND conversation_id=?
    `).run(
      record.content, record.requestTask, record.providerId, record.model, record.reasoning, record.status, record.errorMessage, boolInt(record.historyActive),
      record.webSearchStatus, record.webSearchQuery, record.webSearchProviderName, record.webSearchResultCount, record.webSearchErrorMessage,
      record.promptTokens, record.completionTokens, record.durationMs, boolInt(record.tokenUsageEstimated), record.finishReason,
      record.updatedAt, record.id, record.conversationId
    )
    if (touchConversation) this.touchConversation(record.conversationId, record.updatedAt)
  }

  /**
   * Atomically freezes a Dedicated Search terminal state together with the exact result snapshots.
   * SUCCESS is first stored as unconsumed WEB_SEARCH_RESULT ContextRefs; runtime preparation later
   * replaces them with final included/truncated/omitted usage. This prevents Stop/crash from leaving
   * SUCCESS without recoverable results in the small window between search I/O and prompt planning.
   */
  finalizeWebSearch(record: LlmMessageRecord, contextRefs: readonly LlmContextRefRecord[]): void {
    const assistantId = record.id.trim()
    this.transaction(() => {
      this.updateMessage(record, false)
      this.database.prepare('DELETE FROM llm_context_refs WHERE assistant_message_id=?').run(assistantId)
      const statement = this.database.prepare(`
        INSERT INTO llm_context_refs (
          id,conversation_id,assistant_message_id,context_id,type,title,source_id,article_id,source_url,
          content_snapshot,prompt_content_snapshot,content_sha256,priority,included_in_prompt,truncated_in_prompt,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const ref of contextRefs) {
        if (ref.assistantMessageId !== assistantId || ref.conversationId !== record.conversationId) {
          throw new Error('Web Search ContextRef 不属于当前 Assistant')
        }
        statement.run(
          ref.id, ref.conversationId, assistantId, ref.contextId, ref.type, ref.title, ref.sourceId,
          ref.articleId, ref.sourceUrl, ref.contentSnapshot, ref.promptContentSnapshot, ref.contentSha256,
          ref.priority, boolInt(ref.includedInPrompt), boolInt(ref.truncatedInPrompt), ref.createdAt
        )
      }
      this.touchConversation(record.conversationId, record.updatedAt)
    })
  }

  setMessagesHistoryActive(messageIds: readonly string[], active: boolean, now = Date.now()): number {
    const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const result = this.database.prepare(`
      UPDATE llm_messages SET history_active=?,updated_at=? WHERE id IN (${placeholders})
    `).run(boolInt(active), now, ...ids)
    return Number(result.changes)
  }

  appendRegeneratedAssistant(
    conversationId: string,
    previousAssistantMessageId: string,
    requestTask: LlmMessageRecord['requestTask'] = 'CHAT',
    now = Date.now()
  ): { previous: LlmMessageRecord; assistant: LlmMessageRecord } {
    const id = conversationId.trim()
    const previousId = previousAssistantMessageId.trim()
    return this.transaction(() => {
      const messageNow = this.nextMessageTimestamp(id, now)
      const row = this.database.prepare(`
        SELECT * FROM llm_messages
        WHERE conversation_id=? AND history_active=1
        ORDER BY created_at DESC,id DESC
        LIMIT 1
      `).get(id) as Row | undefined
      const previous = row ? messageFromRow(row) : null
      if (!previous || previous.id !== previousId || previous.role !== 'ASSISTANT') {
        throw new Error('只能重新生成当前活动分支的最后一条 Assistant 消息')
      }
      if (previous.status === 'STREAMING') throw new Error('当前回答仍在生成中')

      this.database.prepare(`
        UPDATE llm_messages SET history_active=0,updated_at=?
        WHERE id=? AND conversation_id=? AND history_active=1
      `).run(messageNow, previousId, id)

      const assistant: LlmMessageRecord = {
        id: randomUUID(),
        conversationId: id,
        role: 'ASSISTANT',
        content: '',
        requestTask,
        providerId: null,
        model: null,
        reasoning: null,
        status: 'STREAMING',
        errorMessage: null,
        historyActive: true,
        webSearchStatus: null,
        webSearchQuery: null,
        webSearchProviderName: null,
        webSearchResultCount: null,
        webSearchErrorMessage: null,
        promptTokens: null,
        completionTokens: null,
        durationMs: null,
        tokenUsageEstimated: false,
        finishReason: null,
        createdAt: messageNow,
        updatedAt: messageNow
      }
      this.insertMessage(assistant)
      this.touchConversation(id, messageNow)
      return { previous: { ...previous, historyActive: false, updatedAt: messageNow }, assistant }
    })
  }

  replaceConversationArticles(conversationId: string, records: readonly LlmConversationArticleRecord[]): void {
    const id = conversationId.trim()
    this.transaction(() => {
      this.database.prepare('DELETE FROM llm_conversation_articles WHERE conversation_id=?').run(id)
      const statement = this.database.prepare(`
        INSERT INTO llm_conversation_articles (
          conversation_id,article_id,title,link,original_content,summary,position,created_at
        ) VALUES (?,?,?,?,?,?,?,?)
      `)
      for (const record of records) {
        if (record.conversationId !== id) throw new Error('附加文章 conversationId 与目标会话不一致')
        statement.run(id, record.articleId, record.title, record.link, record.originalContent, record.summary, record.position, record.createdAt)
      }
    })
  }

  getConversationArticles(conversationId: string): LlmConversationArticleRecord[] {
    return (this.database.prepare(`
      SELECT * FROM llm_conversation_articles WHERE conversation_id=? ORDER BY position,created_at,article_id
    `).all(conversationId.trim()) as Row[]).map(conversationArticleFromRow)
  }

  replaceContextRefsForAssistant(assistantMessageId: string, records: readonly LlmContextRefRecord[]): void {
    const assistantId = assistantMessageId.trim()
    this.transaction(() => {
      this.database.prepare('DELETE FROM llm_context_refs WHERE assistant_message_id=?').run(assistantId)
      const statement = this.database.prepare(`
        INSERT INTO llm_context_refs (
          id,conversation_id,assistant_message_id,context_id,type,title,source_id,article_id,source_url,
          content_snapshot,prompt_content_snapshot,content_sha256,priority,included_in_prompt,truncated_in_prompt,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const record of records) {
        if (record.assistantMessageId !== assistantId) throw new Error('ContextRef assistantMessageId 不一致')
        statement.run(
          record.id, record.conversationId, assistantId, record.contextId, record.type, record.title, record.sourceId,
          record.articleId, record.sourceUrl, record.contentSnapshot, record.promptContentSnapshot, record.contentSha256,
          record.priority, boolInt(record.includedInPrompt), boolInt(record.truncatedInPrompt), record.createdAt
        )
      }
    })
  }

  getContextRefsForAssistant(assistantMessageId: string): LlmContextRefRecord[] {
    return (this.database.prepare(`
      SELECT * FROM llm_context_refs WHERE assistant_message_id=? ORDER BY priority DESC,created_at,id
    `).all(assistantMessageId.trim()) as Row[]).map(contextRefFromRow)
  }

  replaceEvidenceBlocks(contextRefId: string, records: readonly LlmEvidenceBlockRecord[]): void {
    const refId = contextRefId.trim()
    this.transaction(() => {
      this.database.prepare('DELETE FROM llm_evidence_blocks WHERE context_ref_id=?').run(refId)
      const statement = this.database.prepare(`
        INSERT INTO llm_evidence_blocks (
          id,context_ref_id,stable_locator_key,kind,ordinal,text_snapshot,normalized_sha256,locator_json,schema_version,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
      `)
      for (const record of records) {
        if (record.contextRefId !== refId) throw new Error('EvidenceBlock contextRefId 不一致')
        if (record.schemaVersion !== LLM_EVIDENCE_SCHEMA_VERSION) throw new Error('不支持的 EvidenceBlock schema version')
        statement.run(
          record.id, refId, record.stableLocatorKey, record.kind, record.ordinal, record.textSnapshot,
          record.normalizedSha256, JSON.stringify(record.locator), record.schemaVersion, record.createdAt
        )
      }
    })
  }

  getEvidenceBlocks(contextRefId: string): LlmEvidenceBlockRecord[] {
    return (this.database.prepare(`
      SELECT * FROM llm_evidence_blocks WHERE context_ref_id=? ORDER BY ordinal,id
    `).all(contextRefId.trim()) as Row[]).map(evidenceBlockFromRow)
  }

  replaceCitationRefsForAssistant(assistantMessageId: string, records: readonly LlmCitationRefRecord[]): void {
    const assistantId = assistantMessageId.trim()
    this.transaction(() => {
      this.database.prepare('DELETE FROM llm_citation_refs WHERE assistant_message_id=?').run(assistantId)
      const statement = this.database.prepare(`
        INSERT INTO llm_citation_refs (
          id,conversation_id,assistant_message_id,context_ref_id,evidence_block_id,target_kind,protocol_id,display_order,
          quote_snapshot,source_url,locator_json,schema_version,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const record of records) {
        if (record.assistantMessageId !== assistantId) throw new Error('CitationRef assistantMessageId 不一致')
        if (record.schemaVersion !== LLM_CITATION_SCHEMA_VERSION) throw new Error('不支持的 CitationRef schema version')
        statement.run(
          record.id, record.conversationId, assistantId, record.contextRefId, record.evidenceBlockId, record.targetKind,
          record.protocolId, record.displayOrder, record.quoteSnapshot, record.sourceUrl,
          record.locatorSnapshot ? JSON.stringify(record.locatorSnapshot) : null, record.schemaVersion, record.createdAt
        )
      }
    })
  }

  getCitationRefsForAssistant(assistantMessageId: string): LlmCitationRefRecord[] {
    return (this.database.prepare(`
      SELECT * FROM llm_citation_refs WHERE assistant_message_id=? ORDER BY COALESCE(display_order,2147483647),protocol_id,id
    `).all(assistantMessageId.trim()) as Row[]).map(citationRefFromRow)
  }

  appendToolCalls(records: readonly LlmToolCallRecord[]): void {
    if (records.length === 0) return
    this.transaction(() => {
      const statement = this.database.prepare(`
        INSERT INTO llm_tool_calls (
          id,conversation_id,assistant_message_id,provider_call_id,tool_id,api_name,arguments_json,status,
          result_content,error_message,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      for (const record of records) {
        statement.run(
          record.id, record.conversationId, record.assistantMessageId, record.providerCallId, record.toolId,
          record.apiName, record.argumentsJson, record.status, record.resultContent, record.errorMessage,
          record.createdAt, record.updatedAt
        )
      }
    })
  }

  getToolCalls(conversationId: string): LlmToolCallRecord[] {
    return (this.database.prepare(`
      SELECT * FROM llm_tool_calls WHERE conversation_id=? ORDER BY created_at,id
    `).all(conversationId.trim()) as Row[]).map(toolCallFromRow)
  }

  updateToolCall(record: LlmToolCallRecord): void {
    this.database.prepare(`
      UPDATE llm_tool_calls SET status=?,result_content=?,error_message=?,updated_at=? WHERE id=?
    `).run(record.status, record.resultContent, record.errorMessage, record.updatedAt, record.id)
    this.touchConversation(record.conversationId, record.updatedAt)
  }

  /** Crash recovery never replays external work whose result is unknown. */
  recoverInterruptedState(now = Date.now()): { messages: number; toolCalls: number } {
    return this.transaction(() => {
      const messages = this.database.prepare(`
        UPDATE llm_messages SET
          status='STOPPED',
          web_search_status=CASE WHEN web_search_status='TRIGGERED' THEN 'CANCELLED' ELSE web_search_status END,
          finish_reason='CANCELLED',
          updated_at=?
        WHERE status='STREAMING'
      `).run(now)
      const toolCalls = this.database.prepare(`
        UPDATE llm_tool_calls SET
          status='ERROR',
          error_message=COALESCE(error_message,CASE
            WHEN status='PENDING_APPROVAL' THEN '应用退出时 Tool 仍在等待审批，本次审批已失效，Tool 未执行。'
            ELSE '应用退出时 Tool 仍在执行，结果未知，未自动重放。'
          END),
          updated_at=?
        WHERE status IN ('RUNNING','PENDING_APPROVAL')
      `).run(now)
      return { messages: Number(messages.changes), toolCalls: Number(toolCalls.changes) }
    })
  }

  private insertMessage(record: LlmMessageRecord): void {
    this.database.prepare(`
      INSERT INTO llm_messages (
        id,conversation_id,role,content,request_task,provider_id,model,reasoning,status,error_message,history_active,
        web_search_status,web_search_query,web_search_provider_name,web_search_result_count,web_search_error_message,
        prompt_tokens,completion_tokens,duration_ms,token_usage_estimated,finish_reason,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record.id, record.conversationId, record.role, record.content, record.requestTask, record.providerId, record.model,
      record.reasoning, record.status, record.errorMessage, boolInt(record.historyActive), record.webSearchStatus, record.webSearchQuery,
      record.webSearchProviderName, record.webSearchResultCount, record.webSearchErrorMessage, record.promptTokens, record.completionTokens,
      record.durationMs, boolInt(record.tokenUsageEstimated), record.finishReason, record.createdAt, record.updatedAt
    )
  }

  private touchConversation(id: string, now: number): void {
    this.database.prepare('UPDATE llm_conversations SET updated_at=? WHERE id=?').run(now, id)
  }

  /**
   * Conversation order must not fall back to random UUID ordering when two adjacent
   * messages are created inside the same millisecond. Keep created_at strictly
   * increasing within one conversation while preserving a later caller timestamp.
   */
  private nextMessageTimestamp(conversationId: string, requested: number): number {
    const row = this.database.prepare(`
      SELECT MAX(created_at) AS created_at FROM llm_messages WHERE conversation_id=?
    `).get(conversationId) as { created_at?: number | bigint | null } | undefined
    const latest = row?.created_at == null ? null : Number(row.created_at)
    return latest == null ? requested : Math.max(requested, latest + 1)
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function normalizeTitle(value?: string): string {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? ''
  return normalized.slice(0, 120) || 'New chat'
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function boolInt(value: boolean): number { return value ? 1 : 0 }
function numberValue(value: DbRowValue): number { return Number(value ?? 0) }
function stringValue(value: DbRowValue): string { return typeof value === 'string' ? value : String(value ?? '') }
function nullableString(value: DbRowValue): string | null { return value == null ? null : stringValue(value) }

function conversationFromRow(row: Row): LlmConversationRecord {
  return {
    id: stringValue(row.id), title: stringValue(row.title), providerId: nullableString(row.provider_id), model: nullableString(row.model),
    skillId: nullableString(row.skill_id), articleId: nullableString(row.article_id), articleTitle: nullableString(row.article_title),
    articleLink: nullableString(row.article_link), createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at)
  }
}

function conversationArticleFromRow(row: Row): LlmConversationArticleRecord {
  return {
    conversationId: stringValue(row.conversation_id), articleId: stringValue(row.article_id), title: stringValue(row.title),
    link: nullableString(row.link), originalContent: stringValue(row.original_content), summary: nullableString(row.summary),
    position: numberValue(row.position), createdAt: numberValue(row.created_at)
  }
}

function messageFromRow(row: Row): LlmMessageRecord {
  return {
    id: stringValue(row.id), conversationId: stringValue(row.conversation_id), role: stringValue(row.role) as LlmMessageRecord['role'],
    content: stringValue(row.content), requestTask: nullableString(row.request_task) as LlmMessageRecord['requestTask'],
    providerId: nullableString(row.provider_id), model: nullableString(row.model),
    reasoning: nullableString(row.reasoning), status: stringValue(row.status) as LlmMessageRecord['status'], errorMessage: nullableString(row.error_message),
    historyActive: numberValue(row.history_active) === 1, webSearchStatus: nullableString(row.web_search_status) as LlmMessageRecord['webSearchStatus'],
    webSearchQuery: nullableString(row.web_search_query), webSearchProviderName: nullableString(row.web_search_provider_name),
    webSearchResultCount: row.web_search_result_count == null ? null : numberValue(row.web_search_result_count),
    webSearchErrorMessage: nullableString(row.web_search_error_message), promptTokens: row.prompt_tokens == null ? null : numberValue(row.prompt_tokens),
    completionTokens: row.completion_tokens == null ? null : numberValue(row.completion_tokens), durationMs: row.duration_ms == null ? null : numberValue(row.duration_ms),
    tokenUsageEstimated: numberValue(row.token_usage_estimated) === 1, finishReason: nullableString(row.finish_reason) as LlmMessageRecord['finishReason'],
    createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at)
  }
}

function toolCallFromRow(row: Row): LlmToolCallRecord {
  return {
    id: stringValue(row.id), conversationId: stringValue(row.conversation_id), assistantMessageId: stringValue(row.assistant_message_id),
    providerCallId: stringValue(row.provider_call_id), toolId: stringValue(row.tool_id), apiName: stringValue(row.api_name),
    argumentsJson: stringValue(row.arguments_json), status: stringValue(row.status) as LlmToolCallRecord['status'],
    resultContent: nullableString(row.result_content), errorMessage: nullableString(row.error_message),
    createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at)
  }
}

function contextRefFromRow(row: Row): LlmContextRefRecord {
  return {
    id: stringValue(row.id), conversationId: stringValue(row.conversation_id), assistantMessageId: stringValue(row.assistant_message_id),
    contextId: stringValue(row.context_id), type: stringValue(row.type) as LlmContextRefRecord['type'], title: nullableString(row.title),
    sourceId: nullableString(row.source_id), articleId: nullableString(row.article_id), sourceUrl: nullableString(row.source_url),
    contentSnapshot: stringValue(row.content_snapshot), promptContentSnapshot: nullableString(row.prompt_content_snapshot),
    contentSha256: stringValue(row.content_sha256), priority: numberValue(row.priority), includedInPrompt: numberValue(row.included_in_prompt) === 1,
    truncatedInPrompt: numberValue(row.truncated_in_prompt) === 1, createdAt: numberValue(row.created_at)
  }
}

function evidenceBlockFromRow(row: Row): LlmEvidenceBlockRecord {
  const schemaVersion = numberValue(row.schema_version)
  if (schemaVersion !== LLM_EVIDENCE_SCHEMA_VERSION) throw new Error(`不支持的 EvidenceBlock schema version：${schemaVersion}`)
  return {
    id: stringValue(row.id), contextRefId: stringValue(row.context_ref_id), stableLocatorKey: stringValue(row.stable_locator_key),
    kind: stringValue(row.kind) as LlmEvidenceBlockRecord['kind'], ordinal: numberValue(row.ordinal), textSnapshot: stringValue(row.text_snapshot),
    normalizedSha256: stringValue(row.normalized_sha256), locator: parseLocator(row.locator_json), schemaVersion, createdAt: numberValue(row.created_at)
  }
}

function citationRefFromRow(row: Row): LlmCitationRefRecord {
  const schemaVersion = numberValue(row.schema_version)
  if (schemaVersion !== LLM_CITATION_SCHEMA_VERSION) throw new Error(`不支持的 CitationRef schema version：${schemaVersion}`)
  return {
    id: stringValue(row.id), conversationId: stringValue(row.conversation_id), assistantMessageId: stringValue(row.assistant_message_id),
    contextRefId: stringValue(row.context_ref_id), evidenceBlockId: nullableString(row.evidence_block_id),
    targetKind: stringValue(row.target_kind) as LlmCitationRefRecord['targetKind'], protocolId: stringValue(row.protocol_id),
    displayOrder: row.display_order == null ? null : numberValue(row.display_order), quoteSnapshot: stringValue(row.quote_snapshot),
    sourceUrl: nullableString(row.source_url), locatorSnapshot: row.locator_json == null ? null : parseLocator(row.locator_json),
    schemaVersion, createdAt: numberValue(row.created_at)
  }
}

function parseLocator(value: DbRowValue): LlmEvidenceLocatorV1 {
  if (typeof value !== 'string') throw new Error('Evidence locator 缺失')
  const parsed = JSON.parse(value) as Partial<LlmEvidenceLocatorV1>
  if (parsed.version !== 1 || typeof parsed.sourceKind !== 'string' || typeof parsed.normalizedHash !== 'string') {
    throw new Error('Evidence locator 格式无效')
  }
  return parsed as LlmEvidenceLocatorV1
}
