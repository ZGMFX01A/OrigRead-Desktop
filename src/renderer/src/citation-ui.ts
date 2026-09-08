import type { LlmCitationRefRecord } from '../../shared/llm-chat'
import type { LlmAssistantEvidenceSnapshot } from '../../shared/llm-ipc'
import { parseCitationTransport } from '../../shared/citation-transport'

export interface ReaderAiCitationOccurrence {
  annotationId: string
  canonicalInsertionOffset: number
  occurrenceOrdinal: number
  displayOrder: number
  refs: LlmCitationRefRecord[]
}

export interface ReaderAiCitationDisplay {
  canonicalText: string
  occurrences: ReaderAiCitationOccurrence[]
}

/**
 * One renderer projection for both new structured rows and pre-v12 legacy transport rows.
 * New messages already persist canonical text and exact occurrences. Historical rows are parsed
 * lazily with the same transport grammar instead of maintaining a second regex implementation.
 */
export function projectReaderAiCitationDisplay(
  assistantMessageId: string,
  content: string,
  snapshot: LlmAssistantEvidenceSnapshot | null,
  streaming = false
): ReaderAiCitationDisplay {
  const annotations = snapshot?.citationAnnotations ?? []
  if (snapshot && annotations.length > 0) {
    const refsById = new Map(snapshot.citations.map((ref) => [ref.id, ref] as const))
    const junctions = snapshot.citationAnnotationRefs ?? []
    const junctionsByAnnotation = new Map<string, typeof junctions>()
    for (const junction of junctions) {
      const list = junctionsByAnnotation.get(junction.annotationId) ?? []
      list.push(junction)
      junctionsByAnnotation.set(junction.annotationId, list)
    }
    const occurrences = annotations
      .filter((annotation) => annotation.assistantMessageId === assistantMessageId)
      .sort((a, b) => a.occurrenceOrdinal - b.occurrenceOrdinal || a.id.localeCompare(b.id))
      .map((annotation) => ({
        annotationId: annotation.id,
        canonicalInsertionOffset: annotation.canonicalInsertionOffset,
        occurrenceOrdinal: annotation.occurrenceOrdinal,
        refs: (junctionsByAnnotation.get(annotation.id) ?? [])
          .slice()
          .sort((a, b) => a.refOrdinal - b.refOrdinal || a.citationRefId.localeCompare(b.citationRefId))
          .map((junction) => refsById.get(junction.citationRefId))
          .filter((ref): ref is LlmCitationRefRecord => Boolean(ref))
      }))
      .filter((occurrence) => occurrence.refs.length > 0)
      .map((occurrence, index) => ({ ...occurrence, displayOrder: index + 1 }))
    return { canonicalText: content, occurrences }
  }

  const refs = snapshot?.citations ?? []
  const refsByProtocol = new Map(refs.map((ref) => [ref.protocolId, ref] as const))
  const allowedIds = snapshot
    ? new Set(refsByProtocol.keys())
    : new Set([...content.matchAll(/E\d+/g)].map((match) => match[0]))
  const parsed = parseCitationTransport(content, allowedIds, !streaming)
  const occurrences = parsed.annotations
    .map((annotation) => ({
      annotationId: `legacy:${assistantMessageId}:${annotation.occurrenceOrdinal}`,
      canonicalInsertionOffset: annotation.canonicalInsertionOffset,
      occurrenceOrdinal: annotation.occurrenceOrdinal,
      refs: annotation.protocolIds
        .map((protocolId) => refsByProtocol.get(protocolId))
        .filter((ref): ref is LlmCitationRefRecord => Boolean(ref))
    }))
    // During streaming refs are not persisted yet. Keep a provisional marker so transport never leaks
    // and layout does not collapse, but it remains non-interactive until the terminal snapshot arrives.
    .filter((occurrence) => snapshot == null || occurrence.refs.length > 0)
    .map((occurrence, index) => ({ ...occurrence, displayOrder: index + 1 }))
  return { canonicalText: parsed.canonicalText, occurrences }
}

export function directNavigationRefForOccurrence(
  occurrence: ReaderAiCitationOccurrence
): LlmCitationRefRecord | null {
  if (occurrence.refs.length === 0) return null
  const keys = occurrence.refs.map(citationNavigationKey)
  if (keys.some((key) => key == null)) return occurrence.refs.length === 1 ? occurrence.refs[0]! : null
  return new Set(keys).size === 1 ? occurrence.refs[0]! : null
}

function citationNavigationKey(ref: LlmCitationRefRecord): string | null {
  const locator = ref.locatorSnapshot
  if (!locator) return null
  if (locator.sourceKind === 'ARTICLE' || locator.sourceKind === 'SELECTION') {
    const articleId = locator.articleId?.trim()
    const stableKey = locator.stableLocatorKey?.trim()
    if (!articleId || !stableKey) return null
    return `reader:${articleId}:${stableKey}`
  }
  if (locator.sourceKind === 'WEB_SEARCH' || locator.sourceKind === 'TOOL_RESULT') {
    const url = (locator.sourceUrl ?? ref.sourceUrl)?.trim().replace(/#.*$/, '').replace(/\/+$/, '')
    return url ? `url:${url}` : null
  }
  return null
}
