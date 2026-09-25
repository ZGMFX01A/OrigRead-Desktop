import type {
  LlmCitationAnnotationRecord,
  LlmCitationAnnotationRefRecord,
  LlmCitationRefRecord,
  LlmContextRefRecord,
  LlmConversationArticleRecord,
  LlmConversationRecord,
  LlmEvidenceBlockRecord,
  LlmEvidenceLocatorV1,
  LlmMessageRecord,
  LlmToolCallRecord
} from '../../shared/llm-chat'
import type { SyncPayloadBlobRef } from '../../shared/sync-protocol'
import { DesktopSyncLocalBlobStore } from './sync-local-blob-store'
import { utf8TextBlobRef } from './sync-blob-payload'

export function conversationSyncPayload(record: LlmConversationRecord): string {
  return JSON.stringify({
    id: record.id,
    title: record.title,
    providerId: record.providerId,
    model: record.model,
    skillId: record.skillId,
    articleLocalId: record.articleId,
    articleTitle: record.articleTitle,
    articleLink: record.articleLink,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  })
}

export function messageSyncPayload(record: LlmMessageRecord): string {
  return JSON.stringify({
    id: record.id,
    conversationLocalId: record.conversationId,
    role: record.role,
    content: record.content,
    requestTask: record.requestTask,
    providerId: record.providerId,
    model: record.model,
    reasoning: record.reasoning,
    status: record.status,
    errorMessage: record.errorMessage,
    historyActive: record.historyActive,
    webSearchStatus: record.webSearchStatus,
    webSearchQuery: record.webSearchQuery,
    webSearchProviderName: record.webSearchProviderName,
    webSearchResultCount: record.webSearchResultCount,
    webSearchErrorMessage: record.webSearchErrorMessage,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    durationMs: record.durationMs,
    tokenUsageEstimated: record.tokenUsageEstimated,
    finishReason: record.finishReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  })
}

export function toolCallSyncPayload(record: LlmToolCallRecord, blobStore?: DesktopSyncLocalBlobStore): string {
  const blobRefs: SyncPayloadBlobRef[] = []
  let inlineResult: string | null | undefined = record.resultContent
  if (record.resultContent != null && blobStore) {
    const ref = durableTextRef('resultContent', 'tool_result', record.resultContent)
    blobStore.putUtf8Text(ref, record.resultContent)
    blobRefs.push(ref)
    inlineResult = undefined
  }
  return JSON.stringify({
    id: record.id,
    conversationLocalId: record.conversationId,
    assistantMessageLocalId: record.assistantMessageId,
    providerCallId: record.providerCallId,
    toolId: record.toolId,
    apiName: record.apiName,
    argumentsJson: record.argumentsJson,
    status: record.status,
    ...(inlineResult !== undefined ? { resultContent: inlineResult } : {}),
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(blobRefs.length ? { blobRefs } : {})
  })
}

export function conversationArticleSyncPayload(
  record: LlmConversationArticleRecord,
  blobStore: DesktopSyncLocalBlobStore
): string {
  const original = durableTextRef('originalContent', 'conversation_article_original', record.originalContent)
  blobStore.putUtf8Text(original, record.originalContent)
  return JSON.stringify({
    conversationLocalId: record.conversationId,
    articleLocalId: record.articleId,
    title: record.title,
    link: record.link,
    summary: record.summary,
    position: record.position,
    createdAt: record.createdAt,
    blobRefs: [original]
  })
}

export function contextRefSyncPayload(record: LlmContextRefRecord, blobStore: DesktopSyncLocalBlobStore): string {
  const content = durableTextRef('contentSnapshot', 'context_snapshot', record.contentSnapshot)
  blobStore.putUtf8Text(content, record.contentSnapshot)
  const blobRefs = [content]
  if (record.promptContentSnapshot != null) {
    const prompt = durableTextRef('promptContentSnapshot', 'context_prompt_snapshot', record.promptContentSnapshot)
    blobStore.putUtf8Text(prompt, record.promptContentSnapshot)
    blobRefs.push(prompt)
  }
  return JSON.stringify({
    id: record.id,
    conversationLocalId: record.conversationId,
    assistantMessageLocalId: record.assistantMessageId,
    contextId: record.contextId,
    type: record.type,
    title: record.title,
    sourceId: record.sourceId,
    articleLocalId: record.articleId,
    sourceUrl: record.sourceUrl,
    contentSha256: record.contentSha256,
    priority: record.priority,
    includedInPrompt: record.includedInPrompt,
    truncatedInPrompt: record.truncatedInPrompt,
    createdAt: record.createdAt,
    blobRefs
  })
}

export function evidenceBlockSyncPayload(record: LlmEvidenceBlockRecord, blobStore: DesktopSyncLocalBlobStore): string {
  const text = durableTextRef('textSnapshot', 'evidence_text', record.textSnapshot)
  blobStore.putUtf8Text(text, record.textSnapshot)
  return JSON.stringify({
    id: record.id,
    contextRefLocalId: record.contextRefId,
    stableLocatorKey: record.stableLocatorKey,
    kind: record.kind,
    ordinal: record.ordinal,
    normalizedSha256: record.normalizedSha256,
    locator: locatorPayload(record.locator),
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    blobRefs: [text]
  })
}

export function citationRefSyncPayload(
  record: LlmCitationRefRecord,
  blobStore: DesktopSyncLocalBlobStore
): string {
  const quote = durableTextRef('quoteSnapshot', 'citation_quote', record.quoteSnapshot)
  blobStore.putUtf8Text(quote, record.quoteSnapshot)
  return JSON.stringify({
    id: record.id,
    conversationLocalId: record.conversationId,
    assistantMessageLocalId: record.assistantMessageId,
    contextRefLocalId: record.contextRefId,
    evidenceBlockLocalId: record.evidenceBlockId,
    targetKind: record.targetKind,
    protocolId: record.protocolId,
    displayOrder: record.displayOrder,
    sourceUrl: record.sourceUrl,
    locator: record.locatorSnapshot ? locatorPayload(record.locatorSnapshot) : null,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    blobRefs: [quote]
  })
}

export function citationAnnotationSyncPayload(record: LlmCitationAnnotationRecord): string {
  return JSON.stringify({
    id: record.id,
    conversationLocalId: record.conversationId,
    assistantMessageLocalId: record.assistantMessageId,
    canonicalInsertionOffset: record.canonicalInsertionOffset,
    occurrenceOrdinal: record.occurrenceOrdinal,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt
  })
}

export function citationAnnotationRefSyncPayload(record: LlmCitationAnnotationRefRecord): string {
  return JSON.stringify({
    annotationLocalId: record.annotationId,
    citationRefLocalId: record.citationRefId,
    refOrdinal: record.refOrdinal
  })
}

function durableTextRef(field: string, referenceKind: string, text: string): SyncPayloadBlobRef {
  return utf8TextBlobRef(field, referenceKind, text, 'SYNC_DURABLE')
}

function locatorPayload(locator: LlmEvidenceLocatorV1): Record<string, unknown> {
  return {
    version: locator.version,
    sourceKind: locator.sourceKind,
    stableLocatorKey: locator.stableLocatorKey ?? null,
    blockIndex: locator.blockIndex ?? null,
    headingPath: locator.headingPath ?? null,
    articleLocalId: locator.articleId ?? null,
    sourceUrl: locator.sourceUrl ?? null,
    toolCallLocalId: locator.toolCallId ?? null,
    toolId: locator.toolId ?? null,
    toolName: locator.toolName ?? null,
    toolSourceId: locator.toolSourceId ?? null,
    normalizedHash: locator.normalizedHash
  }
}
