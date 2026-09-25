import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SyncEntityType, SyncIdentityMappingRecord } from '../../shared/sync-identity'
import type { SyncOperationRecord } from '../../shared/sync-runtime'
import { relationLocalId } from './sync-canonical-identity'
import { syncPayloadBlobRefs } from './sync-blob-payload'
import { DesktopSyncBlobStateService } from './sync-blob-state'
import { SyncApplyDeferredError } from './sync-apply-coordinator'
import { SyncIdentityRepository } from './sync-identity-repository'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { SyncStateRepository } from './sync-state-repository'
import { SyncVersionResolver, SyncVersionToken, type SyncFieldCandidate } from './sync-version-token'
import { canonicalJson, sha256Hex, operationId } from './sync-operation-canonicalizer'
import { SyncRuntimeRepository } from './sync-runtime-repository'
import { resolvePayloadFields, payloadFieldCandidates } from './sync-payload-merge'
import { resolveLlmSyncPayloadReferences } from './llm-sync-mutation-capture'

const AI_ENTITY_TYPES = new Set<SyncEntityType>([
  'conversation',
  'conversation_article',
  'message',
  'tool_call',
  'context_ref',
  'evidence_block',
  'citation_ref',
  'citation_annotation',
  'citation_annotation_ref'
])

export class DesktopAiHistoryApplier {
  private readonly identities: SyncIdentityRepository
  private readonly blobs: DesktopSyncBlobStateService

  constructor(
    private readonly database: DatabaseSync,
    private readonly state: SyncStateRepository,
    private readonly localBlobs?: DesktopSyncLocalBlobStore
  ) {
    this.identities = new SyncIdentityRepository(database)
    this.blobs = new DesktopSyncBlobStateService(database)
  }

  owns(entityType: string): boolean {
    return AI_ENTITY_TYPES.has(entityType as SyncEntityType)
  }

  canApplyWithoutBlob(entityType: string, referenceKind: string): boolean {
    return isMetadataFirstAttachment(entityType, referenceKind)
  }

  persistFetchedBlob(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    entityGeneration: number,
    referenceKind: string,
    hash: string,
    bytes: Uint8Array
  ): void {
    this.localBlobs?.putVerified(hash, bytes)
    if (!isMetadataFirstAttachment(entityType, referenceKind)) return
    if (!this.blobs.isCurrentReference(syncSpaceId, entityType, entitySyncId, entityGeneration, referenceKind, hash)) return
    const mapping = this.identities.findBySyncId(syncSpaceId, entityType as SyncEntityType, entitySyncId)
    if (!mapping || mapping.generation !== entityGeneration) return
    const textValue = Buffer.from(bytes).toString('utf8')
    switch (entityType) {
      case 'context_ref':
        if (referenceKind === 'context_snapshot') {
          this.database.prepare('UPDATE llm_context_refs SET content_snapshot=? WHERE id=?')
            .run(textValue, mapping.localId)
        } else if (referenceKind === 'context_prompt_snapshot') {
          this.database.prepare('UPDATE llm_context_refs SET prompt_content_snapshot=? WHERE id=?')
            .run(textValue, mapping.localId)
        }
        break
      case 'evidence_block':
        if (referenceKind === 'evidence_text') {
          this.database.prepare('UPDATE llm_evidence_blocks SET text_snapshot=? WHERE id=?')
            .run(textValue, mapping.localId)
        }
        break
      case 'citation_ref':
        if (referenceKind === 'citation_quote') {
          this.database.prepare('UPDATE llm_citation_refs SET quote_snapshot=? WHERE id=?')
            .run(textValue, mapping.localId)
        }
        break
    }
  }

  materializeSnapshotEntity(
    syncSpaceId: string,
    entity: {
      entityType: string
      entitySyncId: string
      generation?: number
      fields: Record<string, unknown>
    },
    now = Date.now()
  ): void {
    if (!this.owns(entity.entityType)) throw new SyncApplyDeferredError('Unsupported AI_HISTORY Snapshot entity')
    const payloadJson = canonicalJson(JSON.stringify(entity.fields))
    const payloadHash = sha256Hex(payloadJson)
    const operationType =
      entity.entityType === 'conversation_article' || entity.entityType === 'citation_annotation_ref'
        ? 'RELATION_SET'
        : 'UPSERT'
    this.apply({
      operationId: 'snapshot-materialize:' + sha256Hex(
        [syncSpaceId, entity.entityType, entity.entitySyncId, String(entity.generation ?? 0)].join('\n')
      ),
      syncSpaceId,
      authorDeviceId: 'snapshot',
      actorIncarnationId: 'snapshot',
      replicationLaneId: 'AI_HISTORY',
      sequence: 1,
      logicalClock: 1,
      causalContextJson: '{}',
      dependencyDotsJson: '[]',
      entityType: entity.entityType,
      entitySyncId: entity.entitySyncId,
      entityGeneration: entity.generation ?? 0,
      operationType,
      payloadSchemaVersion: 1,
      payloadJson,
      schemaVersion: 1,
      authGrantId: null,
      authEpoch: null,
      createdWallClock: now,
      payloadHash,
      signingDigest: payloadHash,
      authorSignature: null,
      buildStatus: 'SIGNED',
      createdAt: now,
      updatedAt: now
    })
  }

  isSnapshotEntityGenerationStale(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    generation: number
  ): boolean {
    if (!this.owns(entityType)) return false
    const mapping = this.identities.findBySyncId(
      syncSpaceId,
      entityType as SyncEntityType,
      entitySyncId
    )
    return Boolean(mapping && generation < mapping.generation)
  }

  materializeSnapshotTombstone(
    syncSpaceId: string,
    entityType: string,
    entitySyncId: string,
    generation: number,
    versionToken: string,
    now = Date.now()
  ): void {
    if (!this.owns(entityType)) throw new SyncApplyDeferredError('Unsupported AI_HISTORY Snapshot tombstone')
    const payloadJson = '{}'
    const payloadHash = sha256Hex(payloadJson)
    this.applyDelete({
      operationId: 'snapshot-delete:' + sha256Hex([syncSpaceId, entityType, entitySyncId, String(generation)].join('\n')),
      syncSpaceId,
      authorDeviceId: 'snapshot',
      actorIncarnationId: 'snapshot',
      replicationLaneId: 'AI_HISTORY',
      sequence: 1,
      logicalClock: 1,
      causalContextJson: '{}',
      dependencyDotsJson: '[]',
      entityType,
      entitySyncId,
      entityGeneration: generation,
      operationType: 'GLOBAL_DELETE',
      payloadSchemaVersion: 1,
      payloadJson,
      schemaVersion: 1,
      authGrantId: null,
      authEpoch: null,
      createdWallClock: now,
      payloadHash,
      signingDigest: payloadHash,
      authorSignature: null,
      buildStatus: 'SIGNED',
      createdAt: now,
      updatedAt: now
    }, versionToken)
  }

  apply(operation: SyncOperationRecord): void {
    if (!this.owns(operation.entityType)) throw new SyncApplyDeferredError('Unsupported AI_HISTORY entity')
    if (this.isDeletedGeneration(operation)) return
    if (operation.operationType === 'GLOBAL_DELETE') {
      this.applyDelete(operation)
      return
    }
    const merged = operation.actorIncarnationId === 'snapshot' ? operation : this.mergeOperationPayload(operation)
    const payload = this.materializePayload(merged)
    switch (operation.entityType) {
      case 'conversation': this.applyConversation(operation, payload); return
      case 'conversation_article': this.applyConversationArticle(operation, payload); return
      case 'message': this.applyMessage(operation, payload); return
      case 'tool_call': this.applyToolCall(operation, payload); return
      case 'context_ref': this.applyContextRef(operation, payload); return
      case 'evidence_block': this.applyEvidenceBlock(operation, payload); return
      case 'citation_ref': this.applyCitationRef(operation, payload); return
      case 'citation_annotation': this.applyCitationAnnotation(operation, payload); return
      case 'citation_annotation_ref': this.applyCitationAnnotationRef(operation, payload); return
      default: throw new SyncApplyDeferredError('Unsupported AI_HISTORY projection')
    }
  }

  private applyConversation(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    const mapping = this.ensureOwnerMapping(operation)
    if (operation.operationType === 'FIELD_SET') {
      const field = text(payload.field)
      if (!field || !['title', 'providerId', 'model', 'skillId'].includes(field)) {
        throw new SyncApplyDeferredError('Unsupported Conversation FIELD_SET')
      }
      const column = field === 'providerId' ? 'provider_id' : field === 'skillId' ? 'skill_id' : field
      const value = field === 'title' ? (text(payload.value) ?? 'New chat') : nullableText(payload.value)
      this.database.prepare(`UPDATE llm_conversations SET ${column}=?,updated_at=? WHERE id=?`)
        .run(value, Date.now(), mapping.localId)
      return
    }
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('Conversation only supports UPSERT/FIELD_SET/delete')
    const articleId = this.optionalLocalId(operation.syncSpaceId, 'article', text(payload.articleSyncId))
    const conflict = ' ON CONFLICT(id) DO UPDATE SET title=excluded.title,provider_id=excluded.provider_id,model=excluded.model,' +
        'skill_id=excluded.skill_id,article_id=excluded.article_id,article_title=excluded.article_title,' +
        'article_link=excluded.article_link,updated_at=excluded.updated_at'
    this.database.prepare(
      'INSERT INTO llm_conversations(id,title,provider_id,model,skill_id,article_id,article_title,article_link,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?)' + conflict
    ).run(
      mapping.localId,
      text(payload.title) ?? 'New chat',
      nullableText(payload.providerId),
      nullableText(payload.model),
      nullableText(payload.skillId),
      articleId,
      nullableText(payload.articleTitle),
      nullableText(payload.articleLink),
      numberValue(payload.createdAt, Date.now()),
      numberValue(payload.updatedAt, Date.now())
    )
  }

  private applyMessage(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    const mapping = this.ensureOwnerMapping(operation)
    if (operation.operationType === 'FIELD_SET') {
      if (payload.field !== 'historyActive') throw new SyncApplyDeferredError('Unsupported Message FIELD_SET')
      this.database.prepare('UPDATE llm_messages SET history_active=?,updated_at=? WHERE id=?')
        .run(payload.value === true ? 1 : 0, Date.now(), mapping.localId)
      return
    }
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('Message only supports UPSERT/FIELD_SET/delete')
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    this.database.prepare(
      'INSERT INTO llm_messages(' +
      'id,conversation_id,role,content,request_task,provider_id,model,reasoning,status,error_message,history_active,' +
      'web_search_status,web_search_query,web_search_provider_name,web_search_result_count,web_search_error_message,' +
      'prompt_tokens,completion_tokens,duration_ms,token_usage_estimated,finish_reason,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
      'content=excluded.content,request_task=excluded.request_task,provider_id=excluded.provider_id,model=excluded.model,' +
      'reasoning=excluded.reasoning,status=excluded.status,error_message=excluded.error_message,history_active=excluded.history_active,' +
      'web_search_status=excluded.web_search_status,web_search_query=excluded.web_search_query,' +
      'web_search_provider_name=excluded.web_search_provider_name,web_search_result_count=excluded.web_search_result_count,' +
      'web_search_error_message=excluded.web_search_error_message,prompt_tokens=excluded.prompt_tokens,' +
      'completion_tokens=excluded.completion_tokens,duration_ms=excluded.duration_ms,' +
      'token_usage_estimated=excluded.token_usage_estimated,finish_reason=excluded.finish_reason,updated_at=excluded.updated_at'
    ).run(
      mapping.localId, conversationId, text(payload.role) ?? 'ASSISTANT', text(payload.content) ?? '',
      nullableText(payload.requestTask), nullableText(payload.providerId), nullableText(payload.model),
      nullableText(payload.reasoning), text(payload.status) ?? 'COMPLETE', nullableText(payload.errorMessage),
      payload.historyActive === false ? 0 : 1, nullableText(payload.webSearchStatus), nullableText(payload.webSearchQuery),
      nullableText(payload.webSearchProviderName), nullableNumber(payload.webSearchResultCount), nullableText(payload.webSearchErrorMessage),
      nullableNumber(payload.promptTokens), nullableNumber(payload.completionTokens), nullableNumber(payload.durationMs),
      payload.tokenUsageEstimated === true ? 1 : 0, nullableText(payload.finishReason),
      numberValue(payload.createdAt, Date.now()), numberValue(payload.updatedAt, Date.now())
    )
  }

  private applyToolCall(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('ToolCall only supports UPSERT/delete')
    const mapping = this.ensureOwnerMapping(operation)
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    const assistantId = this.requireLocalId(operation.syncSpaceId, 'message', text(payload.assistantMessageSyncId))
    this.database.prepare(
      'INSERT INTO llm_tool_calls(id,conversation_id,assistant_message_id,provider_call_id,tool_id,api_name,arguments_json,status,' +
      'result_content,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET status=excluded.status,result_content=excluded.result_content,' +
      'error_message=excluded.error_message,updated_at=excluded.updated_at'
    ).run(
      mapping.localId, conversationId, assistantId, text(payload.providerCallId) ?? mapping.localId,
      text(payload.toolId) ?? '', text(payload.apiName) ?? '', text(payload.argumentsJson) ?? '{}',
      text(payload.status) ?? 'ERROR', nullableText(payload.resultContent), nullableText(payload.errorMessage),
      numberValue(payload.createdAt, Date.now()), numberValue(payload.updatedAt, Date.now())
    )
  }

  private applyContextRef(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('ContextRef only supports UPSERT/delete')
    const mapping = this.ensureOwnerMapping(operation)
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    const assistantId = this.requireLocalId(operation.syncSpaceId, 'message', text(payload.assistantMessageSyncId))
    const articleId = this.optionalLocalId(operation.syncSpaceId, 'article', text(payload.articleSyncId))
    this.database.prepare(
      'INSERT INTO llm_context_refs(id,conversation_id,assistant_message_id,context_id,type,title,source_id,article_id,source_url,' +
      'content_snapshot,prompt_content_snapshot,content_sha256,priority,included_in_prompt,truncated_in_prompt,created_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
      'title=excluded.title,source_id=excluded.source_id,article_id=excluded.article_id,source_url=excluded.source_url,' +
      'content_snapshot=excluded.content_snapshot,prompt_content_snapshot=excluded.prompt_content_snapshot,' +
      'content_sha256=excluded.content_sha256,priority=excluded.priority,included_in_prompt=excluded.included_in_prompt,' +
      'truncated_in_prompt=excluded.truncated_in_prompt'
    ).run(
      mapping.localId, conversationId, assistantId, text(payload.contextId) ?? mapping.localId,
      text(payload.type) ?? 'MANUAL', nullableText(payload.title), nullableText(payload.sourceId), articleId,
      nullableText(payload.sourceUrl), text(payload.contentSnapshot) ?? '', nullableText(payload.promptContentSnapshot),
      text(payload.contentSha256) ?? '', numberValue(payload.priority, 0), payload.includedInPrompt === true ? 1 : 0,
      payload.truncatedInPrompt === true ? 1 : 0, numberValue(payload.createdAt, Date.now())
    )
  }

  private applyEvidenceBlock(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('EvidenceBlock only supports UPSERT/delete')
    const mapping = this.ensureOwnerMapping(operation)
    const contextId = this.requireLocalId(operation.syncSpaceId, 'context_ref', text(payload.contextRefSyncId))
    this.database.prepare(
      'INSERT INTO llm_evidence_blocks(id,context_ref_id,stable_locator_key,kind,ordinal,text_snapshot,normalized_sha256,' +
      'locator_json,schema_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
      'text_snapshot=excluded.text_snapshot,normalized_sha256=excluded.normalized_sha256,locator_json=excluded.locator_json'
    ).run(
      mapping.localId, contextId, text(payload.stableLocatorKey) ?? mapping.localId, text(payload.kind) ?? 'PARAGRAPH',
      numberValue(payload.ordinal, 0), text(payload.textSnapshot) ?? '', text(payload.normalizedSha256) ?? '',
      JSON.stringify(this.materializeLocator(operation.syncSpaceId, objectValue(payload.locator))),
      numberValue(payload.schemaVersion, 1), numberValue(payload.createdAt, Date.now())
    )
  }

  private applyCitationRef(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('CitationRef only supports UPSERT/delete')
    const mapping = this.ensureOwnerMapping(operation)
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    const assistantId = this.requireLocalId(operation.syncSpaceId, 'message', text(payload.assistantMessageSyncId))
    const contextId = this.requireLocalId(operation.syncSpaceId, 'context_ref', text(payload.contextRefSyncId))
    const evidenceId = this.optionalLocalId(operation.syncSpaceId, 'evidence_block', text(payload.evidenceBlockSyncId))
    this.database.prepare(
      'INSERT INTO llm_citation_refs(id,conversation_id,assistant_message_id,context_ref_id,evidence_block_id,target_kind,' +
      'protocol_id,display_order,quote_snapshot,source_url,locator_json,schema_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET protocol_id=excluded.protocol_id,display_order=excluded.display_order,' +
      'quote_snapshot=excluded.quote_snapshot,source_url=excluded.source_url,locator_json=excluded.locator_json'
    ).run(
      mapping.localId, conversationId, assistantId, contextId, evidenceId, text(payload.targetKind) ?? 'CONTEXT_REF',
      text(payload.protocolId) ?? mapping.localId, nullableNumber(payload.displayOrder), text(payload.quoteSnapshot) ?? '',
      nullableText(payload.sourceUrl),
      payload.locator == null ? null : JSON.stringify(this.materializeLocator(operation.syncSpaceId, objectValue(payload.locator))),
      numberValue(payload.schemaVersion, 1), numberValue(payload.createdAt, Date.now())
    )
  }

  private applyCitationAnnotation(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'UPSERT') throw new SyncApplyDeferredError('CitationAnnotation only supports UPSERT/delete')
    const mapping = this.ensureOwnerMapping(operation)
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    const assistantId = this.requireLocalId(operation.syncSpaceId, 'message', text(payload.assistantMessageSyncId))
    this.database.prepare(
      'INSERT INTO llm_citation_annotations(id,conversation_id,assistant_message_id,canonical_insertion_offset,occurrence_ordinal,' +
      'schema_version,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
      'canonical_insertion_offset=excluded.canonical_insertion_offset,occurrence_ordinal=excluded.occurrence_ordinal'
    ).run(
      mapping.localId, conversationId, assistantId, numberValue(payload.canonicalInsertionOffset, 0),
      numberValue(payload.occurrenceOrdinal, 0), numberValue(payload.schemaVersion, 1),
      numberValue(payload.createdAt, Date.now())
    )
  }

  private applyConversationArticle(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'RELATION_SET') throw new SyncApplyDeferredError('ConversationArticle requires RELATION_SET')
    const conversationId = this.requireLocalId(operation.syncSpaceId, 'conversation', text(payload.conversationSyncId))
    const articleId = this.requireLocalId(operation.syncSpaceId, 'article', text(payload.articleSyncId))
    const localRelationId = relationLocalId('conversation_article', conversationId, articleId)
    this.ensureOwnerMapping(operation, localRelationId)
    this.database.prepare(
      'INSERT INTO llm_conversation_articles(conversation_id,article_id,title,link,original_content,summary,position,created_at) ' +
      'VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,article_id) DO UPDATE SET ' +
      'title=excluded.title,link=excluded.link,original_content=excluded.original_content,summary=excluded.summary,position=excluded.position'
    ).run(
      conversationId, articleId, text(payload.title) ?? '', nullableText(payload.link), text(payload.originalContent) ?? '',
      nullableText(payload.summary), numberValue(payload.position, 0), numberValue(payload.createdAt, Date.now())
    )
  }

  private applyCitationAnnotationRef(operation: SyncOperationRecord, payload: Record<string, unknown>): void {
    if (operation.operationType !== 'RELATION_SET') throw new SyncApplyDeferredError('CitationAnnotationRef requires RELATION_SET')
    const annotationId = this.requireLocalId(operation.syncSpaceId, 'citation_annotation', text(payload.annotationSyncId))
    const citationId = this.requireLocalId(operation.syncSpaceId, 'citation_ref', text(payload.citationRefSyncId))
    const localRelationId = relationLocalId('citation_annotation_ref', annotationId, citationId)
    this.ensureOwnerMapping(operation, localRelationId)
    this.database.prepare(
      'INSERT INTO llm_citation_annotation_refs(annotation_id,citation_ref_id,ref_ordinal) VALUES(?,?,?) ' +
      'ON CONFLICT(annotation_id,citation_ref_id) DO UPDATE SET ref_ordinal=excluded.ref_ordinal'
    ).run(annotationId, citationId, numberValue(payload.refOrdinal, 0))
  }

  private applyDelete(operation: SyncOperationRecord, versionToken?: string): void {
    const mapping = this.identities.findBySyncId(operation.syncSpaceId, operation.entityType as SyncEntityType, operation.entitySyncId)
    if (mapping && mapping.generation > operation.entityGeneration) return
    this.state.recordTombstone(
      operation.syncSpaceId,
      operation.entityType,
      operation.entitySyncId,
      operation.entityGeneration,
      versionToken ?? SyncVersionToken.operation(operation.actorIncarnationId, operation.replicationLaneId, operation.sequence),
      Date.now(),
      operation.operationId
    )
    this.blobs.removeOwnerReferences(
      operation.syncSpaceId,
      operation.replicationLaneId,
      operation.entityType,
      operation.entitySyncId,
      operation.entityGeneration
    )
    if (!mapping) return
    switch (operation.entityType) {
      case 'conversation':
        this.removeCascadeBlobReferences(operation.syncSpaceId, mapping.localId)
        this.database.prepare('DELETE FROM llm_conversations WHERE id=?').run(mapping.localId)
        break
      case 'message':
        this.removeMessageBlobReferences(operation.syncSpaceId, mapping.localId)
        this.database.prepare('DELETE FROM llm_messages WHERE id=?').run(mapping.localId)
        break
      case 'tool_call': this.database.prepare('DELETE FROM llm_tool_calls WHERE id=?').run(mapping.localId); break
      case 'context_ref': this.database.prepare('DELETE FROM llm_context_refs WHERE id=?').run(mapping.localId); break
      case 'evidence_block': this.database.prepare('DELETE FROM llm_evidence_blocks WHERE id=?').run(mapping.localId); break
      case 'citation_ref': this.database.prepare('DELETE FROM llm_citation_refs WHERE id=?').run(mapping.localId); break
      case 'citation_annotation': this.database.prepare('DELETE FROM llm_citation_annotations WHERE id=?').run(mapping.localId); break
      case 'conversation_article': this.deleteConversationArticleByRelationMapping(mapping.localId); break
      case 'citation_annotation_ref': this.deleteAnnotationRefByRelationMapping(mapping.localId); break
    }
  }

  private mergeOperationPayload(operation: SyncOperationRecord): SyncOperationRecord {
    const runtime = new SyncRuntimeRepository(this.database)
    const retained = runtime.listAllOperationsForRecovery(operation.syncSpaceId).filter((row) =>
      row.entityType === operation.entityType && row.entitySyncId === operation.entitySyncId &&
      row.entityGeneration === operation.entityGeneration && row.buildStatus !== 'REJECTED' &&
      [undefined, 'APPLIED'].includes(this.state.findInbox(row.operationId)?.state))
    const local = runtime.listGenesisCandidates(operation.syncSpaceId).filter((row) =>
      row.entityType === operation.entityType && row.entitySyncId === operation.entitySyncId &&
      row.entityGeneration === operation.entityGeneration).map((row) => ({ ...operation,
        operationId: operationId(operation.syncSpaceId, row.actorIncarnationId, row.replicationLaneId, row.sequence),
        actorIncarnationId: row.actorIncarnationId, replicationLaneId: row.replicationLaneId,
        sequence: row.sequence, logicalClock: row.sequence, operationType: row.mutationType,
        causalContextJson: row.causalContextJson,
        payloadJson: resolveLlmSyncPayloadReferences(this.identities, operation.syncSpaceId, row.payloadJson)
      }))
    const mergeInputs = [...retained, ...local, operation]
    const stored = new Map<string, SyncFieldCandidate[]>()
    const storedRows = this.state.listFieldCandidates(operation.syncSpaceId).filter((row) =>
      row.entityType === operation.entityType && row.entitySyncId === operation.entitySyncId && row.entityGeneration === operation.entityGeneration)
    for (const row of storedRows) {
      const context = JSON.parse(row.causalContextJson ?? '{}')
      const candidate: SyncFieldCandidate = { versionToken: row.versionToken, valueJson: row.valueJson,
        logicalClock: row.logicalClock ?? 0, observedGenesisBaselinesByLane: context.observedGenesisBaselinesByLane,
        causalContext: Object.fromEntries((context.lanes ?? []).map((lane: { replicationLaneId: string; actors: Array<{ actorIncarnationId: string; prefix: number }> }) =>
          [lane.replicationLaneId, Object.fromEntries(lane.actors.map((actor) => [actor.actorIncarnationId, actor.prefix]))])) }
      stored.set(row.fieldId, [...(stored.get(row.fieldId) ?? []), candidate])
    }
    for (const [field, candidates] of payloadFieldCandidates(mergeInputs)) for (const candidate of candidates) {
      const source = mergeInputs.find((row) => SyncVersionToken.operation(row.actorIncarnationId, row.replicationLaneId, row.sequence) === candidate.versionToken)!
      this.state.retainFieldCandidate({ syncSpaceId: operation.syncSpaceId, entityType: operation.entityType,
        entitySyncId: operation.entitySyncId, entityGeneration: operation.entityGeneration, fieldId: field,
        versionToken: candidate.versionToken, valueJson: candidate.valueJson, sourceOperationId: source.operationId,
        causalContextJson: source.causalContextJson, logicalClock: source.logicalClock, updatedAt: Date.now() })
    }
    const winners = resolvePayloadFields(mergeInputs, stored)
    for (const [field, winner] of winners) {
      const winnerSource = mergeInputs.find((row) =>
        SyncVersionToken.operation(
          row.actorIncarnationId,
          row.replicationLaneId,
          row.sequence
        ) === winner.versionToken
      )
      this.state.upsertFieldVersion({ syncSpaceId: operation.syncSpaceId, entityType: operation.entityType,
        entitySyncId: operation.entitySyncId, fieldId: field, entityGeneration: operation.entityGeneration,
        versionToken: winner.versionToken, sourceOperationId: winnerSource?.operationId ?? null,
        valueJson: winner.valueJson,
        causalContextJson: winnerSource?.causalContextJson ?? storedRows.find((row) => row.versionToken === winner.versionToken)?.causalContextJson ?? null,
        logicalClock: winnerSource?.logicalClock ?? storedRows.find((row) => row.versionToken === winner.versionToken)?.logicalClock ?? null,
        updatedAt: Date.now() })
    }
    const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>
    return { ...operation, payloadJson: canonicalJson(JSON.stringify(operation.operationType === 'FIELD_SET'
      ? { ...payload, value: JSON.parse(winners.get(String(payload.field))!.valueJson) }
      : Object.fromEntries([...winners].map(([field, winner]) => [field, JSON.parse(winner.valueJson)])))) }
  }

  private materializePayload(operation: SyncOperationRecord): Record<string, unknown> {
    const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>
    const refs = syncPayloadBlobRefs(operation.payloadJson)
    for (const ref of refs) {
      const bytes = this.localBlobs?.readVerified(ref.manifest.hash) ?? null
      this.blobs.registerManifest(ref.manifest, bytes ? 'READY' : 'BLOB_MISSING')
      this.blobs.replaceOwnerReference(
        operation.syncSpaceId,
        operation.replicationLaneId,
        operation.entityType,
        operation.entitySyncId,
        operation.entityGeneration,
        ref.referenceKind,
        ref.manifest.hash
      )
      if (!bytes || bytes.byteLength !== ref.manifest.totalBytes) {
        this.blobs.markMissing(ref.manifest.hash)
        if (isMetadataFirstAttachment(operation.entityType, ref.referenceKind)) continue
        throw new SyncApplyDeferredError('BLOB_MISSING:' + ref.manifest.hash)
      }
      this.blobs.markReadyVerified(ref.manifest.hash, bytes.byteLength)
      payload[ref.field] = Buffer.from(bytes).toString('utf8')
    }
    return payload
  }

  private metadataFirstAttachment(entityType: string, referenceKind: string): boolean {
    return isMetadataFirstAttachment(entityType, referenceKind)
  }

  private ensureOwnerMapping(operation: SyncOperationRecord, preferredLocalId?: string): SyncIdentityMappingRecord {
    const entityType = operation.entityType as SyncEntityType
    const existing = this.identities.findBySyncId(operation.syncSpaceId, entityType, operation.entitySyncId)
    if (existing) {
      if (operation.entityGeneration < existing.generation) {
        throw new SyncApplyDeferredError('Stale ' + operation.entityType + ' generation')
      }
      if (operation.entityGeneration > existing.generation) {
        const updated = { ...existing, generation: operation.entityGeneration, updatedAt: Date.now() }
        this.identities.updateMappings([updated])
        return updated
      }
      return existing
    }
    const now = Date.now()
    const mapping: SyncIdentityMappingRecord = {
      syncSpaceId: operation.syncSpaceId,
      entityType,
      localId: preferredLocalId ?? randomUUID(),
      syncId: operation.entitySyncId,
      canonicalKey: null,
      generation: operation.entityGeneration,
      createdAt: now,
      updatedAt: now
    }
    this.identities.insertMapping(mapping)
    return mapping
  }

  private requireLocalId(syncSpaceId: string, entityType: SyncEntityType, syncId: string | null): string {
    if (!syncId) throw new SyncApplyDeferredError('Missing ' + entityType + ' Sync ID dependency')
    const mapping = this.identities.findBySyncId(syncSpaceId, entityType, syncId)
    if (!mapping) throw new SyncApplyDeferredError('Missing ' + entityType + ' mapping ' + syncId)
    return mapping.localId
  }

  private optionalLocalId(syncSpaceId: string, entityType: SyncEntityType, syncId: string | null): string | null {
    if (!syncId) return null
    return this.identities.findBySyncId(syncSpaceId, entityType, syncId)?.localId ?? null
  }

  private isDeletedGeneration(operation: SyncOperationRecord): boolean {
    const row = this.database.prepare(
      'SELECT generation FROM sync_entity_tombstone WHERE sync_space_id=? AND entity_type=? AND entity_sync_id=? LIMIT 1'
    ).get(operation.syncSpaceId, operation.entityType, operation.entitySyncId) as { generation: number } | undefined
    return Boolean(row && operation.operationType !== 'GLOBAL_DELETE' && operation.entityGeneration <= Number(row.generation))
  }

  private materializeLocator(syncSpaceId: string, locator: Record<string, unknown>): Record<string, unknown> {
    const result = { ...locator }
    const articleSyncId = text(result.articleSyncId)
    const toolCallSyncId = text(result.toolCallSyncId)
    delete result.articleSyncId
    delete result.toolCallSyncId
    if (articleSyncId) result.articleId = this.optionalLocalId(syncSpaceId, 'article', articleSyncId)
    if (toolCallSyncId) result.toolCallId = this.optionalLocalId(syncSpaceId, 'tool_call', toolCallSyncId)
    return result
  }

  private removeCascadeBlobReferences(syncSpaceId: string, conversationId: string): void {
    const messages = this.database.prepare('SELECT id FROM llm_messages WHERE conversation_id=?').all(conversationId) as unknown as Array<{ id: string }>
    for (const message of messages) this.removeMessageBlobReferences(syncSpaceId, message.id)
    const relations = this.database.prepare(
      'SELECT conversation_id,article_id FROM llm_conversation_articles WHERE conversation_id=?'
    ).all(conversationId) as unknown as Array<{ conversation_id: string; article_id: string }>
    for (const relation of relations) {
      this.removeMappedOwnerBlobReferences(
        syncSpaceId,
        'conversation_article',
        relationLocalId('conversation_article', relation.conversation_id, relation.article_id)
      )
    }
  }

  private removeMessageBlobReferences(syncSpaceId: string, messageId: string): void {
    const toolCalls = this.database.prepare('SELECT id FROM llm_tool_calls WHERE assistant_message_id=?').all(messageId) as unknown as Array<{ id: string }>
    for (const row of toolCalls) this.removeMappedOwnerBlobReferences(syncSpaceId, 'tool_call', row.id)
    const contexts = this.database.prepare('SELECT id FROM llm_context_refs WHERE assistant_message_id=?').all(messageId) as unknown as Array<{ id: string }>
    for (const row of contexts) {
      this.removeMappedOwnerBlobReferences(syncSpaceId, 'context_ref', row.id)
      const evidence = this.database.prepare('SELECT id FROM llm_evidence_blocks WHERE context_ref_id=?').all(row.id) as unknown as Array<{ id: string }>
      for (const item of evidence) this.removeMappedOwnerBlobReferences(syncSpaceId, 'evidence_block', item.id)
    }
  }

  private removeMappedOwnerBlobReferences(syncSpaceId: string, entityType: SyncEntityType, localId: string): void {
    const mapping = this.identities.findByLocalId(syncSpaceId, entityType, localId)
    if (!mapping) return
    this.blobs.removeOwnerReferences(syncSpaceId, 'AI_HISTORY', entityType, mapping.syncId, mapping.generation)
  }

  private deleteConversationArticleByRelationMapping(relationLocalIdValue: string): void {
    const rows = this.database.prepare('SELECT conversation_id,article_id FROM llm_conversation_articles').all() as unknown as Array<{
      conversation_id: string
      article_id: string
    }>
    for (const row of rows) {
      if (relationLocalId('conversation_article', row.conversation_id, row.article_id) === relationLocalIdValue) {
        this.database.prepare('DELETE FROM llm_conversation_articles WHERE conversation_id=? AND article_id=?')
          .run(row.conversation_id, row.article_id)
        return
      }
    }
  }

  private deleteAnnotationRefByRelationMapping(relationLocalIdValue: string): void {
    const rows = this.database.prepare('SELECT annotation_id,citation_ref_id FROM llm_citation_annotation_refs').all() as unknown as Array<{
      annotation_id: string
      citation_ref_id: string
    }>
    for (const row of rows) {
      if (relationLocalId('citation_annotation_ref', row.annotation_id, row.citation_ref_id) === relationLocalIdValue) {
        this.database.prepare('DELETE FROM llm_citation_annotation_refs WHERE annotation_id=? AND citation_ref_id=?')
          .run(row.annotation_id, row.citation_ref_id)
        return
      }
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function isMetadataFirstAttachment(entityType: string, referenceKind: string): boolean {
  switch (entityType) {
    case 'context_ref':
      return referenceKind === 'context_snapshot' || referenceKind === 'context_prompt_snapshot'
    case 'evidence_block':
      return referenceKind === 'evidence_text'
    case 'citation_ref':
      return referenceKind === 'citation_quote'
    default:
      return false
  }
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}
