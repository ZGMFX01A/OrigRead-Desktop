export interface CitationTransportAnnotation {
  canonicalInsertionOffset: number
  occurrenceOrdinal: number
  protocolIds: string[]
}

export interface CitationTransportParseResult {
  canonicalText: string
  annotations: CitationTransportAnnotation[]
  invalidProtocolIds: string[]
  invalidFragmentCount: number
  hasIncompleteTransport: boolean
}

type CitationTokenState = 'COMPLETE' | 'INCOMPLETE' | 'INVALID'

interface ParsedCitationToken {
  state: CitationTokenState
  protocolIds: string[]
  endExclusive: number
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

const CITATION_PUNCTUATION = new Set([',', '.', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？'])

/**
 * Parse OrigRead request-local Citation transport into canonical prose plus structured occurrences.
 * Only Citation-shaped [[E<number>...]] fragments are owned; arbitrary [[wiki]]/matrix syntax stays literal.
 * Inline code and CommonMark fenced code are protected so examples never become live citations.
 */
export function parseCitationTransport(
  transportText: string,
  allowedProtocolIds: ReadonlySet<string>,
  final = true
): CitationTransportParseResult {
  const normalized: string[] = []
  const annotations: CitationTransportAnnotation[] = []
  const pendingAnnotations: Array<{ pendingWhitespaceOffset: number; occurrenceOrdinal: number; protocolIds: string[] }> = []
  const pendingWhitespace: string[] = []
  const invalidIds = new Set<string>()
  let invalidFragmentCount = 0
  let activeFence: MarkdownFence | null = null
  let inlineDelimiterLength = 0
  let index = 0
  let stalled = false
  let normalizedLength = 0

  const resolvePendingAnnotations = (preservedWhitespace: number): void => {
    if (pendingAnnotations.length === 0) return
    for (const pending of pendingAnnotations) {
      annotations.push({
        canonicalInsertionOffset: normalizedLength + Math.min(pending.pendingWhitespaceOffset, preservedWhitespace),
        occurrenceOrdinal: pending.occurrenceOrdinal,
        protocolIds: pending.protocolIds
      })
    }
    pendingAnnotations.length = 0
    annotations.sort((a, b) => a.occurrenceOrdinal - b.occurrenceOrdinal)
  }

  const appendCanonicalChar = (character: string): void => {
    if (/\s/u.test(character)) {
      pendingWhitespace.push(character)
      return
    }
    let preservedWhitespace = pendingWhitespace.length
    if (CITATION_PUNCTUATION.has(character)) {
      while (preservedWhitespace > 0) {
        const value = pendingWhitespace[preservedWhitespace - 1]
        if (value !== ' ' && value !== '\t') break
        preservedWhitespace -= 1
      }
    }
    resolvePendingAnnotations(preservedWhitespace)
    for (let i = 0; i < preservedWhitespace; i += 1) {
      normalized.push(pendingWhitespace[i]!)
      normalizedLength += pendingWhitespace[i]!.length
    }
    pendingWhitespace.length = 0
    normalized.push(character)
    normalizedLength += character.length
  }

  const appendCanonicalRange = (start: number, endExclusive: number): void => {
    for (let cursor = start; cursor < endExclusive;) {
      const cp = transportText.codePointAt(cursor)
      if (cp === undefined) break
      const value = String.fromCodePoint(cp)
      appendCanonicalChar(value)
      cursor += value.length
    }
  }

  const addAnnotation = (protocolIds: string[]): void => {
    const occurrenceOrdinal = annotations.length + pendingAnnotations.length
    if (pendingWhitespace.length === 0) {
      annotations.push({ canonicalInsertionOffset: normalizedLength, occurrenceOrdinal, protocolIds })
    } else {
      pendingAnnotations.push({
        pendingWhitespaceOffset: pendingWhitespace.join('').length,
        occurrenceOrdinal,
        protocolIds
      })
    }
  }

  while (index < transportText.length) {
    if (!final && delimiterRunNeedsMoreInput(transportText, index, activeFence)) {
      stalled = true
      break
    }

    const fence = fenceDelimiterAt(transportText, index)
    if (inlineDelimiterLength === 0 && fence) {
      if (!activeFence) {
        if (!final && fenceOpeningNeedsLineEnd(transportText, index, fence)) {
          stalled = true
          break
        }
        if (canOpenFence(transportText, index, fence)) {
          activeFence = fence
          appendCanonicalRange(index, index + fence.length)
          index += fence.length
          continue
        }
      } else if (fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        if (!final && closingFenceNeedsMoreInput(transportText, index + fence.length)) {
          stalled = true
          break
        }
        if (isClosingFenceLine(transportText, index + fence.length)) {
          activeFence = null
          appendCanonicalRange(index, index + fence.length)
          index += fence.length
          continue
        }
      }
    }

    if (!activeFence && transportText[index] === '`') {
      const delimiterLength = repeatedCharLength(transportText, index, '`')
      if (inlineDelimiterLength === 0) inlineDelimiterLength = delimiterLength
      else if (delimiterLength === inlineDelimiterLength) inlineDelimiterLength = 0
      appendCanonicalRange(index, index + delimiterLength)
      index += delimiterLength
      continue
    }

    if (!activeFence && inlineDelimiterLength === 0) {
      const citationStart = isCitationStart(transportText, index)
      if (!citationStart && !final && isCitationPrefixAtEnd(transportText, index)) {
        stalled = true
        break
      }
      if (citationStart) {
        const token = parseTokenAt(transportText, index, final)
        if (token.state === 'COMPLETE') {
          const validIds = [...new Set(token.protocolIds.filter((id) => allowedProtocolIds.has(id)))]
          for (const id of token.protocolIds) if (!allowedProtocolIds.has(id)) invalidIds.add(id)
          if (validIds.length > 0) addAnnotation(validIds)
          else invalidFragmentCount += 1
          index = token.endExclusive
          continue
        }
        if (token.state === 'INCOMPLETE') {
          if (final) {
            invalidFragmentCount += 1
            index = transportText.length
          } else {
            stalled = true
          }
          break
        }
        invalidFragmentCount += 1
        index = Math.max(token.endExclusive, index + 2)
        continue
      }
    }

    const cp = transportText.codePointAt(index)
    if (cp === undefined) break
    const character = String.fromCodePoint(cp)
    appendCanonicalChar(character)
    index += character.length
  }

  // Snapshot semantics intentionally drop trailing whitespace. Occurrences that sat inside that
  // whitespace collapse to the current canonical end until later text decides where whitespace stays.
  const snapshotAnnotations = [
    ...annotations,
    ...pendingAnnotations.map((pending): CitationTransportAnnotation => ({
      canonicalInsertionOffset: normalizedLength,
      occurrenceOrdinal: pending.occurrenceOrdinal,
      protocolIds: pending.protocolIds
    }))
  ].sort((a, b) => a.occurrenceOrdinal - b.occurrenceOrdinal)

  return {
    canonicalText: normalized.join(''),
    annotations: snapshotAnnotations,
    invalidProtocolIds: [...invalidIds],
    invalidFragmentCount,
    hasIncompleteTransport: stalled
  }
}

function parseTokenAt(text: string, start: number, final: boolean): ParsedCitationToken {
  let cursor = start + 2
  const ids: string[] = []
  while (cursor < text.length) {
    if (text.startsWith(']]', cursor)) {
      return { state: ids.length > 0 ? 'COMPLETE' : 'INVALID', protocolIds: ids, endExclusive: cursor + 2 }
    }
    if (text[cursor] !== 'E') {
      const end = invalidTokenEnd(text, cursor, final)
      return end == null
        ? { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
        : { state: 'INVALID', protocolIds: ids, endExclusive: end }
    }
    const digitsStart = cursor + 1
    let digitsEnd = digitsStart
    while (digitsEnd < text.length && /\d/.test(text[digitsEnd]!)) digitsEnd += 1
    if (digitsEnd === digitsStart) {
      if (digitsEnd === text.length) return { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
      const end = invalidTokenEnd(text, digitsEnd, final)
      return end == null
        ? { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
        : { state: 'INVALID', protocolIds: ids, endExclusive: end }
    }
    ids.push(text.slice(cursor, digitsEnd))
    if (digitsEnd >= text.length) return { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
    if (text.startsWith(']]', digitsEnd)) return { state: 'COMPLETE', protocolIds: ids, endExclusive: digitsEnd + 2 }
    if (text.startsWith('][', digitsEnd)) {
      cursor = digitsEnd + 2
      continue
    }
    const end = invalidTokenEnd(text, digitsEnd, final)
    return end == null
      ? { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
      : { state: 'INVALID', protocolIds: ids, endExclusive: end }
  }
  return { state: 'INCOMPLETE', protocolIds: ids, endExclusive: text.length }
}

/** Malformed Citation transport is bounded by a close delimiter or line end, never arbitrary later prose. */
function invalidTokenEnd(text: string, from: number, final: boolean): number | null {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    if (text.startsWith(']]', cursor)) return cursor + 2
    if (text[cursor] === '\n') return cursor
  }
  return final ? text.length : null
}

function isCitationStart(text: string, index: number): boolean {
  return text.startsWith('[[E', index) && /\d/.test(text[index + 3] ?? '')
}

function isCitationPrefixAtEnd(text: string, index: number): boolean {
  const remaining = text.length - index
  if (remaining < 1 || remaining > 3) return false
  return '[[E'.slice(0, remaining) === text.slice(index)
}

function repeatedCharLength(text: string, start: number, character: string): number {
  let cursor = start
  while (cursor < text.length && text[cursor] === character) cursor += 1
  return cursor - start
}

function fenceDelimiterAt(text: string, index: number): MarkdownFence | null {
  const marker = text[index]
  if (marker !== '`' && marker !== '~') return null
  if (!hasValidFenceIndent(text, index)) return null
  const length = repeatedCharLength(text, index, marker)
  return length >= 3 ? { marker, length } : null
}

function hasValidFenceIndent(text: string, index: number): boolean {
  let spaces = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] !== '\n'; cursor -= 1) {
    if (text[cursor] !== ' ') return false
    spaces += 1
    if (spaces > 3) return false
  }
  return true
}

function canOpenFence(text: string, start: number, fence: MarkdownFence): boolean {
  if (fence.marker !== '`') return true
  const lineEnd = text.indexOf('\n', start + fence.length)
  const end = lineEnd >= 0 ? lineEnd : text.length
  return !text.slice(start + fence.length, end).includes('`')
}

function isClosingFenceLine(text: string, from: number): boolean {
  for (let cursor = from; cursor < text.length && text[cursor] !== '\n'; cursor += 1) {
    if (![' ', '\t', '\r'].includes(text[cursor]!)) return false
  }
  return true
}

function delimiterRunNeedsMoreInput(text: string, index: number, activeFence: MarkdownFence | null): boolean {
  const marker = text[index]
  if (marker !== '`' && marker !== '~') return false
  const relevant = marker === '`' || activeFence?.marker === marker || hasValidFenceIndent(text, index)
  if (!relevant) return false
  const run = repeatedCharLength(text, index, marker)
  return index + run === text.length
}

function fenceOpeningNeedsLineEnd(text: string, index: number, fence: MarkdownFence): boolean {
  return fence.marker === '`' && text.indexOf('\n', index + fence.length) < 0
}

function closingFenceNeedsMoreInput(text: string, from: number): boolean {
  return text.indexOf('\n', from) < 0
}
