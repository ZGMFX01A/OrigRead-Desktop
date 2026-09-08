import { randomUUID } from 'node:crypto'
import { llmEvidenceRequestIdentity, type ComposedLlmContext } from '../../shared/llm-context'
import {
  LLM_CITATION_ANNOTATION_SCHEMA_VERSION,
  LLM_CITATION_SCHEMA_VERSION,
  type LlmCitationAnnotationRecord,
  type LlmCitationAnnotationRefRecord,
  type LlmCitationRefRecord,
  type LlmCitationTargetKind,
  type LlmEvidenceLocatorV1
} from '../../shared/llm-chat'
import { parseCitationTransport, type CitationTransportAnnotation } from '../../shared/citation-transport'

export interface LlmCitationEvidenceCandidate {
  contextId: string
  stableLocatorKey: string
  contextRefId: string
  evidenceBlockId: string | null
  targetKind: LlmCitationTargetKind
  quoteSnapshot: string
  sourceUrl: string | null
  locatorSnapshot: LlmEvidenceLocatorV1 | null
}

export interface LlmCitationProtocolEntry extends LlmCitationEvidenceCandidate {
  protocolId: string
}

export interface LlmCitationReadyContext {
  text: string
  protocolEntries: LlmCitationProtocolEntry[]
  instruction: string
}

export interface ResolvedAssistantCitations {
  validProtocolIds: string[]
  invalidProtocolIds: string[]
  canonicalText: string
  annotations: CitationTransportAnnotation[]
}

export interface BuiltCitationPersistence {
  refs: LlmCitationRefRecord[]
  annotations: LlmCitationAnnotationRecord[]
  annotationRefs: LlmCitationAnnotationRefRecord[]
  canonicalText: string
  invalidProtocolIds: string[]
}

/**
 * Convert stable (contextId, locatorKey) identities to short request-local E1/E2 IDs only after
 * budgeting. The context identity is part of the key so identical article blocks in two attached
 * sources cannot silently collide.
 */
export function prepareCitationProtocol(
  composed: ComposedLlmContext,
  candidates: readonly LlmCitationEvidenceCandidate[],
  includedHistoryContextIds: readonly string[] = []
): LlmCitationReadyContext {
  const byRequestIdentity = new Map<string, LlmCitationEvidenceCandidate>()
  for (const candidate of candidates) {
    const contextId = candidate.contextId.trim()
    const key = candidate.stableLocatorKey.trim()
    if (!contextId) throw new Error('Citation evidence contextId 不能为空')
    if (!key) throw new Error('Citation evidence stableLocatorKey 不能为空')
    const requestIdentity = llmEvidenceRequestIdentity(contextId, key)
    if (byRequestIdentity.has(requestIdentity)) {
      throw new Error(`Citation evidence identity 重复：${contextId} / ${key}`)
    }
    byRequestIdentity.set(requestIdentity, { ...candidate, contextId, stableLocatorKey: key })
  }

  const composedIdentities = composed.renderedItems.flatMap((item) =>
    (item.evidenceBlockKeys ?? []).map((key) => llmEvidenceRequestIdentity(item.id, key))
  )
  const candidatesByContextId = new Map<string, LlmCitationEvidenceCandidate[]>()
  for (const candidate of candidates) {
    const list = candidatesByContextId.get(candidate.contextId) ?? []
    list.push(candidate)
    candidatesByContextId.set(candidate.contextId, list)
  }
  const historyIdentities = includedHistoryContextIds.flatMap((contextId) =>
    (candidatesByContextId.get(contextId) ?? []).map((candidate) =>
      llmEvidenceRequestIdentity(candidate.contextId, candidate.stableLocatorKey)
    )
  )
  const includedIdentities = [...composedIdentities, ...historyIdentities]
  const protocolEntries: LlmCitationProtocolEntry[] = []
  const seenIncluded = new Set<string>()
  for (const requestIdentity of includedIdentities) {
    if (seenIncluded.has(requestIdentity)) continue
    seenIncluded.add(requestIdentity)
    const candidate = byRequestIdentity.get(requestIdentity)
    if (!candidate) throw new Error(`已进入 Prompt 的 Evidence block 缺少 Citation metadata：${requestIdentity}`)
    protocolEntries.push({ ...candidate, protocolId: `E${protocolEntries.length + 1}` })
  }

  let text = composed.text
  for (const entry of protocolEntries) {
    const requestIdentity = llmEvidenceRequestIdentity(entry.contextId, entry.stableLocatorKey)
    text = text.replaceAll(
      `[ORIGREAD_EVIDENCE id=${quoteAttribute(requestIdentity)}]`,
      `[ORIGREAD_EVIDENCE id=${quoteAttribute(entry.protocolId)}]`
    )
  }
  const instruction = protocolEntries.length === 0
    ? ''
    : [
        'Evidence citation protocol:',
        '- Cite only evidence IDs present in ORIGREAD_EVIDENCE blocks.',
        '- Use the exact token [[E1]], [[E2]], etc. after an important supported claim or closely related claim group; avoid redundant citations.',
        '- For multiple evidence IDs, repeat complete tokens such as [[E1]][[E2]]; never merge them into [[E1][E2]].',
        '- When comparing sources, preserve coverage of the sources materially used in the answer.',
        '- Never invent an evidence ID and never cite context that was not included.'
      ].join('\n')
  return { text, protocolEntries, instruction }
}

export function resolveAssistantCitationTokens(
  assistantText: string,
  allowedEntries: readonly LlmCitationProtocolEntry[]
): ResolvedAssistantCitations {
  const parsed = parseCitationTransport(
    assistantText,
    new Set(allowedEntries.map((entry) => entry.protocolId)),
    true
  )
  return {
    validProtocolIds: [...new Set(parsed.annotations.flatMap((annotation) => annotation.protocolIds))],
    invalidProtocolIds: parsed.invalidProtocolIds,
    canonicalText: parsed.canonicalText,
    annotations: parsed.annotations
  }
}

export function buildCitationRefsFromAssistantOutput(
  assistantText: string,
  allowedEntries: readonly LlmCitationProtocolEntry[],
  identity: { conversationId: string; assistantMessageId: string },
  options: { now?: number; idFactory?: () => string } = {}
): {
  refs: LlmCitationRefRecord[]
  invalidProtocolIds: string[]
  canonicalText: string
  annotations: CitationTransportAnnotation[]
} {
  const resolved = resolveAssistantCitationTokens(assistantText, allowedEntries)
  const byProtocolId = new Map(allowedEntries.map((entry) => [entry.protocolId, entry] as const))
  const now = options.now ?? Date.now()
  const idFactory = options.idFactory ?? randomUUID
  const refs = resolved.validProtocolIds.map((protocolId, index): LlmCitationRefRecord => {
    const entry = byProtocolId.get(protocolId)!
    return {
      id: idFactory(),
      conversationId: identity.conversationId,
      assistantMessageId: identity.assistantMessageId,
      contextRefId: entry.contextRefId,
      evidenceBlockId: entry.evidenceBlockId,
      targetKind: entry.targetKind,
      protocolId,
      // Kept as an audit/backward-compatibility field. Final UI numbering is occurrence-scoped.
      displayOrder: index + 1,
      quoteSnapshot: entry.quoteSnapshot,
      sourceUrl: entry.sourceUrl,
      locatorSnapshot: entry.locatorSnapshot,
      schemaVersion: LLM_CITATION_SCHEMA_VERSION,
      createdAt: now
    }
  })
  return {
    refs,
    invalidProtocolIds: resolved.invalidProtocolIds,
    canonicalText: resolved.canonicalText,
    annotations: resolved.annotations
  }
}

export function buildCitationPersistenceFromAssistantOutput(
  assistantText: string,
  allowedEntries: readonly LlmCitationProtocolEntry[],
  identity: { conversationId: string; assistantMessageId: string },
  options: {
    now?: number
    refIdFactory?: () => string
    annotationIdFactory?: () => string
  } = {}
): BuiltCitationPersistence {
  const built = buildCitationRefsFromAssistantOutput(assistantText, allowedEntries, identity, {
    now: options.now,
    idFactory: options.refIdFactory
  })
  const now = options.now ?? Date.now()
  const annotationIdFactory = options.annotationIdFactory ?? randomUUID
  const refsByProtocolId = new Map(built.refs.map((ref) => [ref.protocolId, ref] as const))
  const annotations: LlmCitationAnnotationRecord[] = []
  const annotationRefs: LlmCitationAnnotationRefRecord[] = []
  for (const parsed of built.annotations) {
    const refs = parsed.protocolIds.map((id) => refsByProtocolId.get(id)).filter((ref): ref is LlmCitationRefRecord => Boolean(ref))
    if (refs.length === 0) continue
    const annotation: LlmCitationAnnotationRecord = {
      id: annotationIdFactory(),
      conversationId: identity.conversationId,
      assistantMessageId: identity.assistantMessageId,
      canonicalInsertionOffset: parsed.canonicalInsertionOffset,
      occurrenceOrdinal: parsed.occurrenceOrdinal,
      schemaVersion: LLM_CITATION_ANNOTATION_SCHEMA_VERSION,
      createdAt: now
    }
    annotations.push(annotation)
    refs.forEach((ref, refOrdinal) => {
      annotationRefs.push({ annotationId: annotation.id, citationRefId: ref.id, refOrdinal })
    })
  }
  return {
    refs: built.refs,
    annotations,
    annotationRefs,
    canonicalText: built.canonicalText,
    invalidProtocolIds: built.invalidProtocolIds
  }
}

/** Historical request-local transport must never be replayed into a later provider request. */
export function stripHistoricalCitationProtocolTokens(content: string): string {
  if (!content.includes('[[E')) return content
  const parsed = parseCitationTransport(content, new Set(), true)
  const parserDidNotOwnTransport = parsed.annotations.length === 0
    && parsed.invalidProtocolIds.length === 0
    && parsed.invalidFragmentCount === 0
  return parserDidNotOwnTransport ? content : parsed.canonicalText
}

function quoteAttribute(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
