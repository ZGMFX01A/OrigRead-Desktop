import type { LlmCitationRefRecord } from '../../shared/llm-chat'
import type { LlmAssistantEvidenceSnapshot, LlmRestorableCitationSnapshot } from '../../shared/llm-ipc'
import { parseCitationTransport } from '../../shared/citation-transport'

export const MAX_INLINE_CITATION_GROUPS = 20

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

export interface ReaderAiCitationSnapshot {
  messageId: string
  messageContent?: string | null
  snapshot: LlmAssistantEvidenceSnapshot
  origin?: 'INTERACTION' | 'HISTORICAL'
}

export interface ReaderAiCitationLayerSelection {
  panelOpen: boolean
  historicalResolved: boolean
  source: ReaderAiCitationSnapshot | null
  interaction: ReaderAiCitationSnapshot | null
  answer: ReaderAiCitationSnapshot | null
  historical: ReaderAiCitationSnapshot | null
  dismissedFallback: ReaderAiCitationSnapshot | null
}

/**
 * Android downgrades the current interaction layer to a replaceable historical fallback when Chat
 * closes. Desktop keeps the same semantics explicitly: while the Room/SQLite-backed historical
 * lookup is still in flight we may keep the dismissed layer to avoid a blank frame, but once that
 * lookup resolves (including to null) it becomes the sole owner of the closed-reader marker layer.
 */
export function selectReaderAiVisibleCitationSnapshot(
  selection: ReaderAiCitationLayerSelection
): ReaderAiCitationSnapshot | null {
  if (selection.panelOpen) {
    const source = selection.source?.origin === 'HISTORICAL' ? null : selection.source
    const interaction = selection.interaction?.origin === 'HISTORICAL' ? null : selection.interaction
    return source
      ?? interaction
      ?? selection.answer
      ?? selection.historical
  }
  if (selection.historicalResolved) return selection.historical
  return selection.historical ?? selection.dismissedFallback
}

/** Mirrors Android ReaderEvidenceMarkerState.retainAsHistoricalFallback(). */
export function retainReaderAiCitationAsHistoricalFallback(
  current: ReaderAiCitationSnapshot | null
): ReaderAiCitationSnapshot | null {
  return current ? { ...current, origin: 'HISTORICAL' } : null
}

/** Keep the persisted Assistant text beside its Evidence snapshot for legacy occurrence recovery. */
export function readerAiCitationSnapshotFromRestorable(
  restorable: LlmRestorableCitationSnapshot
): ReaderAiCitationSnapshot {
  return {
    messageId: restorable.message.id,
    messageContent: restorable.message.content,
    snapshot: restorable.evidence,
    origin: 'HISTORICAL'
  }
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
    const logical = annotations
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
    const occurrences = selectVisibleStructuredOccurrences(logical)
      .map((occurrence, index) => ({ ...occurrence, displayOrder: index + 1 }))
    return { canonicalText: content, occurrences }
  }

  const refs = snapshot?.citations ?? []
  // Android v15-and-earlier compatibility path keeps the first protocol row, then rejects every
  // ref participating in an ambiguous positive displayOrder. Do the same before transport parsing
  // so corrupt legacy numbering never becomes an actionable Desktop Citation.
  const distinctLegacyRefs: LlmCitationRefRecord[] = []
  const seenProtocolIds = new Set<string>()
  for (const ref of refs) {
    if (seenProtocolIds.has(ref.protocolId)) continue
    seenProtocolIds.add(ref.protocolId)
    distinctLegacyRefs.push(ref)
  }
  const displayOrderCounts = new Map<number, number>()
  for (const ref of distinctLegacyRefs) {
    const order = ref.displayOrder ?? 0
    if (order > 0) displayOrderCounts.set(order, (displayOrderCounts.get(order) ?? 0) + 1)
  }
  const duplicateDisplayOrders = new Set(
    [...displayOrderCounts.entries()].filter(([, count]) => count > 1).map(([order]) => order)
  )
  const validLegacyRefs = distinctLegacyRefs.filter((ref) => !duplicateDisplayOrders.has(ref.displayOrder ?? 0))
  const refsByProtocol = new Map(validLegacyRefs.map((ref) => [ref.protocolId, ref] as const))
  const allowedIds = snapshot
    ? new Set(refsByProtocol.keys())
    : new Set([...content.matchAll(/E\d+/g)].map((match) => match[0]))
  const parsed = parseCitationTransport(content, allowedIds, !streaming)
  const parsedOccurrences: LegacyCitationOccurrence[] = parsed.annotations
    .map((annotation) => ({
      canonicalInsertionOffset: annotation.canonicalInsertionOffset,
      occurrenceOrdinal: annotation.occurrenceOrdinal,
      protocolIds: annotation.protocolIds,
      refs: annotation.protocolIds
        .map((protocolId) => refsByProtocol.get(protocolId))
        .filter((ref): ref is LlmCitationRefRecord => Boolean(ref))
    }))
  const normalizedOccurrences = normalizeLegacyCitationOccurrences(parsedOccurrences)
  const navigable = normalizedOccurrences.filter((occurrence) => occurrence.refs.length > 0)
  const visible = snapshot == null && navigable.length === 0
    // While the terminal Evidence snapshot is still unavailable, keep bounded provisional markers
    // so Citation transport never flashes as raw text and the completed layout does not collapse.
    ? normalizedOccurrences.slice(0, MAX_INLINE_CITATION_GROUPS)
    : selectVisibleLegacyOccurrences(navigable)
  const orderBySignature = new Map<string, number>()
  for (const occurrence of visible) {
    const signature = legacyCitationSignature(occurrence)
    if (!orderBySignature.has(signature)) orderBySignature.set(signature, orderBySignature.size + 1)
  }
  const occurrences = visible.map((occurrence) => ({
    annotationId: `legacy:${assistantMessageId}:${occurrence.occurrenceOrdinal}`,
    canonicalInsertionOffset: occurrence.canonicalInsertionOffset,
    occurrenceOrdinal: occurrence.occurrenceOrdinal,
    refs: occurrence.refs,
    displayOrder: orderBySignature.get(legacyCitationSignature(occurrence))!
  }))
  return { canonicalText: parsed.canonicalText, occurrences }
}

export function directNavigationRefForOccurrence(
  occurrence: ReaderAiCitationOccurrence
): LlmCitationRefRecord | null {
  if (occurrence.refs.length === 0) return null
  const keys = occurrence.refs.map(citationNavigationKey)
  if (keys.some((key) => key == null)) return null
  return new Set(keys).size === 1 ? occurrence.refs[occurrence.refs.length - 1]! : null
}

function citationNavigationKey(ref: LlmCitationRefRecord): string | null {
  const locator = ref.locatorSnapshot
  if (!locator) return null
  if (locator.sourceKind === 'ARTICLE' || locator.sourceKind === 'SELECTION') {
    const articleId = locator.articleId?.trim()
    const stableKey = locator.stableLocatorKey?.trim() ?? ''
    if (!articleId || (locator.sourceKind === 'SELECTION' && !stableKey)) return null
    return `reader:${articleId}\u001e${stableKey}\u001e${locator.normalizedHash.trim()}\u001e${(locator.headingPath ?? []).join('\u001f')}`
  }
  if (locator.sourceKind === 'WEB_SEARCH' || locator.sourceKind === 'TOOL_RESULT') {
    const url = trustedHttpCitationUrl(locator.sourceUrl ?? ref.sourceUrl)
    return url ? `url:${url}` : null
  }
  return null
}

interface LegacyCitationOccurrence {
  canonicalInsertionOffset: number
  occurrenceOrdinal: number
  protocolIds: string[]
  refs: LlmCitationRefRecord[]
}

function normalizeLegacyCitationOccurrences(
  occurrences: LegacyCitationOccurrence[]
): LegacyCitationOccurrence[] {
  const normalized: LegacyCitationOccurrence[] = []
  for (const occurrence of occurrences) {
    const previous = normalized.at(-1)
    const previousTargets = new Set(previous?.refs.map(citationUiMergeTargetKey).filter(isString) ?? [])
    const currentTargets = new Set(occurrence.refs.map(citationUiMergeTargetKey).filter(isString))
    if (
      previous
      && previous.canonicalInsertionOffset === occurrence.canonicalInsertionOffset
      && previousTargets.size === 1
      && currentTargets.size === 1
      && [...previousTargets][0] === [...currentTargets][0]
    ) {
      normalized[normalized.length - 1] = {
        ...previous,
        protocolIds: [...new Set([...previous.protocolIds, ...occurrence.protocolIds])],
        refs: distinctRefs([...previous.refs, ...occurrence.refs])
      }
    } else {
      normalized.push(occurrence)
    }
  }
  return normalized
}

function selectVisibleLegacyOccurrences(occurrences: LegacyCitationOccurrence[]): LegacyCitationOccurrence[] {
  if (occurrences.length <= MAX_INLINE_CITATION_GROUPS) return occurrences
  const selected = new Set<LegacyCitationOccurrence>()
  const coveredSources = new Set<string>()
  for (const occurrence of occurrences) {
    if (selected.size >= MAX_INLINE_CITATION_GROUPS) break
    const sources = new Set(occurrence.refs.map(citationSourceKey))
    if ([...sources].some((source) => !coveredSources.has(source))) {
      selected.add(occurrence)
      for (const source of sources) coveredSources.add(source)
    }
  }
  for (const occurrence of occurrences) {
    if (selected.size >= MAX_INLINE_CITATION_GROUPS) break
    selected.add(occurrence)
  }
  return occurrences.filter((occurrence) => selected.has(occurrence))
}

function selectVisibleStructuredOccurrences<T extends { refs: LlmCitationRefRecord[] }>(occurrences: T[]): T[] {
  if (occurrences.length <= MAX_INLINE_CITATION_GROUPS) return occurrences
  const selected = new Set<T>()
  const coveredSources = new Set<string>()
  for (const occurrence of occurrences) {
    if (selected.size >= MAX_INLINE_CITATION_GROUPS) break
    const sources = new Set(occurrence.refs.map(citationSourceKey))
    if ([...sources].some((source) => !coveredSources.has(source))) {
      selected.add(occurrence)
      for (const source of sources) coveredSources.add(source)
    }
  }
  for (const occurrence of occurrences) {
    if (selected.size >= MAX_INLINE_CITATION_GROUPS) break
    selected.add(occurrence)
  }
  return occurrences.filter((occurrence) => selected.has(occurrence))
}

function legacyCitationSignature(occurrence: LegacyCitationOccurrence): string {
  return [...occurrence.protocolIds].sort().join('|')
}

function citationUiMergeTargetKey(ref: LlmCitationRefRecord): string | null {
  const locator = ref.locatorSnapshot
  if (!locator) return null
  if (locator.sourceKind === 'ARTICLE' || locator.sourceKind === 'SELECTION') {
    const articleId = locator.articleId?.trim()
    const stableKey = locator.stableLocatorKey?.trim()
    return articleId && stableKey ? `reader:${articleId}:${stableKey}` : null
  }
  if (locator.sourceKind === 'WEB_SEARCH' || locator.sourceKind === 'TOOL_RESULT') {
    const url = normalizedCitationUrl(locator.sourceUrl ?? ref.sourceUrl)
    return url ? `url:${url}` : null
  }
  return null
}

function citationSourceKey(ref: LlmCitationRefRecord): string {
  const locator = ref.locatorSnapshot
  if (!locator) return `context:${ref.contextRefId}`
  switch (locator.sourceKind) {
    case 'ARTICLE':
    case 'SELECTION': {
      const articleId = locator.articleId?.trim()
      if (articleId) return `article:${articleId}`
      const url = normalizedCitationUrl(locator.sourceUrl ?? ref.sourceUrl)
      return url ? `url:${url}` : `context:${ref.contextRefId}`
    }
    case 'WEB_SEARCH': {
      const url = normalizedCitationUrl(locator.sourceUrl ?? ref.sourceUrl)
      return url ? `web:${url}` : `context:${ref.contextRefId}`
    }
    case 'TOOL_RESULT': {
      const toolCallId = locator.toolCallId?.trim()
      if (toolCallId) return `tool-call:${toolCallId}`
      const toolSourceId = locator.toolSourceId?.trim()
      if (toolSourceId) return `tool-source:${toolSourceId}`
      const url = normalizedCitationUrl(locator.sourceUrl ?? ref.sourceUrl)
      return url ? `tool-url:${url}` : `context:${ref.contextRefId}`
    }
  }
}

function normalizedCitationUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  return normalized.replace(/#.*$/, '').replace(/\/+$/, '')
}

function trustedHttpCitationUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host
      ? normalized
      : null
  } catch {
    return null
  }
}

function distinctRefs(refs: LlmCitationRefRecord[]): LlmCitationRefRecord[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (seen.has(ref.id)) return false
    seen.add(ref.id)
    return true
  })
}

function isString(value: string | null): value is string {
  return value !== null
}
