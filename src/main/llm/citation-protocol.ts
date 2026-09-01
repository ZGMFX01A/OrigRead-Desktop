import { randomUUID } from 'node:crypto'
import type { ComposedLlmContext } from '../../shared/llm-context'
import {
  LLM_CITATION_SCHEMA_VERSION,
  type LlmCitationRefRecord,
  type LlmCitationTargetKind,
  type LlmEvidenceLocatorV1
} from '../../shared/llm-chat'

export interface LlmCitationEvidenceCandidate {
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
}

/**
 * Convert internal stable locator keys to short request-local E1/E2 IDs only after budgeting.
 * Omitted blocks never receive a protocol ID and therefore cannot resolve to a historical citation.
 */
export function prepareCitationProtocol(
  composed: ComposedLlmContext,
  candidates: readonly LlmCitationEvidenceCandidate[]
): LlmCitationReadyContext {
  const byKey = new Map<string, LlmCitationEvidenceCandidate>()
  for (const candidate of candidates) {
    const key = candidate.stableLocatorKey.trim()
    if (!key) throw new Error('Citation evidence stableLocatorKey 不能为空')
    if (byKey.has(key)) throw new Error(`Citation evidence key 重复：${key}`)
    byKey.set(key, { ...candidate, stableLocatorKey: key })
  }

  const includedKeys = composed.renderedItems.flatMap((item) => item.evidenceBlockKeys ?? [])
  const protocolEntries: LlmCitationProtocolEntry[] = []
  const seenIncluded = new Set<string>()
  for (const key of includedKeys) {
    if (seenIncluded.has(key)) continue
    seenIncluded.add(key)
    const candidate = byKey.get(key)
    if (!candidate) throw new Error(`已进入 Prompt 的 Evidence block 缺少 Citation metadata：${key}`)
    protocolEntries.push({ ...candidate, protocolId: `E${protocolEntries.length + 1}` })
  }

  let text = composed.text
  for (const entry of protocolEntries) {
    text = text.replaceAll(
      `[ORIGREAD_EVIDENCE id=${quoteAttribute(entry.stableLocatorKey)}]`,
      `[ORIGREAD_EVIDENCE id=${quoteAttribute(entry.protocolId)}]`
    )
  }
  const instruction = protocolEntries.length === 0
    ? ''
    : [
        'Evidence citation protocol:',
        '- Cite only evidence IDs present in ORIGREAD_EVIDENCE blocks.',
        '- Use the exact token [[E1]], [[E2]], etc. immediately after the supported claim.',
        '- Never invent an evidence ID and never cite context that was not included.'
      ].join('\n')
  return { text, protocolEntries, instruction }
}

/** Invalid/hallucinated IDs are reported but deliberately remain ordinary text at the UI layer. */
export function resolveAssistantCitationTokens(
  assistantText: string,
  allowedEntries: readonly LlmCitationProtocolEntry[]
): ResolvedAssistantCitations {
  const allowed = new Set(allowedEntries.map((entry) => entry.protocolId))
  const validProtocolIds: string[] = []
  const invalidProtocolIds: string[] = []
  const seenValid = new Set<string>()
  const seenInvalid = new Set<string>()
  for (const match of assistantText.matchAll(/\[\[(E\d+)\]\]/g)) {
    const protocolId = match[1]!
    if (allowed.has(protocolId)) {
      if (!seenValid.has(protocolId)) {
        seenValid.add(protocolId)
        validProtocolIds.push(protocolId)
      }
    } else if (!seenInvalid.has(protocolId)) {
      seenInvalid.add(protocolId)
      invalidProtocolIds.push(protocolId)
    }
  }
  return { validProtocolIds, invalidProtocolIds }
}

export function buildCitationRefsFromAssistantOutput(
  assistantText: string,
  allowedEntries: readonly LlmCitationProtocolEntry[],
  identity: { conversationId: string; assistantMessageId: string },
  options: { now?: number; idFactory?: () => string } = {}
): { refs: LlmCitationRefRecord[]; invalidProtocolIds: string[] } {
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
      displayOrder: index + 1,
      quoteSnapshot: entry.quoteSnapshot,
      sourceUrl: entry.sourceUrl,
      locatorSnapshot: entry.locatorSnapshot,
      schemaVersion: LLM_CITATION_SCHEMA_VERSION,
      createdAt: now
    }
  })
  return { refs, invalidProtocolIds: resolved.invalidProtocolIds }
}

function quoteAttribute(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
