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

const MAX_MALFORMED_TOKEN_CHARS = 32
const MAX_PENDING_INLINE_CHARS = 256

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
  let justStrippedCitation = false
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
    if (justStrippedCitation && CITATION_PUNCTUATION.has(character)) {
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
    justStrippedCitation = false
  }

  const appendProtectedRange = (start: number, endExclusive: number): void => {
    resolvePendingAnnotations(pendingWhitespace.length)
    const value = pendingWhitespace.join('') + transportText.slice(start, endExclusive)
    normalized.push(value)
    normalizedLength += value.length
    pendingWhitespace.length = 0
    justStrippedCitation = false
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
          appendProtectedRange(index, index + fence.length)
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
          appendProtectedRange(index, index + fence.length)
          index += fence.length
          continue
        }
      }
    }

    if (!activeFence && transportText[index] === '`') {
      const delimiterLength = repeatedCharLength(transportText, index, '`')
      if (inlineDelimiterLength === 0) {
        if (hasInlineCloser(transportText, index, delimiterLength)) {
          inlineDelimiterLength = delimiterLength
        } else if (!final && !/\r?\n\r?\n/u.test(transportText.slice(index)) && transportText.length - index <= MAX_PENDING_INLINE_CHARS) {
          stalled = true
          break
        }
      } else if (delimiterLength === inlineDelimiterLength) inlineDelimiterLength = 0
      appendProtectedRange(index, index + delimiterLength)
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
        const token = parseTokenAt(transportText, index)
        if (token.state === 'COMPLETE') {
          const validIds = [...new Set(token.protocolIds.filter((id) => allowedProtocolIds.has(id)))]
          for (const id of token.protocolIds) if (!allowedProtocolIds.has(id)) invalidIds.add(id)
          if (validIds.length > 0) addAnnotation(validIds)
          else invalidFragmentCount += 1
          justStrippedCitation = true
          index = token.endExclusive
          continue
        }
        const malformedEnd = malformedTokenEnd(transportText, index)
        if (malformedEnd !== null) {
          invalidFragmentCount += 1
          justStrippedCitation = true
          index = malformedEnd
          continue
        }
        if (isLegalTokenPrefix(transportText.slice(index))) {
          if (!final) {
            stalled = true
            break
          }
          invalidFragmentCount += 1
          justStrippedCitation = true
          index = transportText.length
          continue
        }
        // A non-protocol suffix is literal; keep scanning for later citations.
      }
    }

    const cp = transportText.codePointAt(index)
    if (cp === undefined) break
    const character = String.fromCodePoint(cp)
    if (activeFence !== null || inlineDelimiterLength > 0) appendProtectedRange(index, index + character.length)
    else appendCanonicalChar(character)
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

function parseTokenAt(text: string, start: number): ParsedCitationToken {
  const match = /^\[\[(E\d+(?:(?:\]\[|, *)E\d+)*)\]\]/u.exec(text.slice(start))
  if (!match) return { state: 'INVALID', protocolIds: [], endExclusive: start }
  return {
    state: 'COMPLETE',
    protocolIds: match[1]!.match(/E\d+/gu)!,
    endExclusive: start + match[0].length
  }
}

/** Only short, closed protocol-shaped mistakes are owned; prose stays literal. */
function malformedTokenEnd(text: string, start: number): number | null {
  const window = text.slice(start, start + MAX_MALFORMED_TOKEN_CHARS)
  const close = window.indexOf(']]')
  if (close < 0) return null
  const fragment = window.slice(0, close + 2)
  if (/[\r\n]/u.test(fragment)) return null
  // Require a digit or protocol delimiter after E so English wiki text stays literal.
  // Allow a single malformed member, but never multiple prose words or nested tokens.
  if (!/^\[\[E(?=\d|\]\[|\]\])[\dA-Za-z]*(?:(?:, *|\]\[)E?[\dA-Za-z]*)*\]\]$/u.test(fragment)) return null
  return start + fragment.length
}

function isLegalTokenPrefix(suffix: string): boolean {
  return suffix.length <= MAX_MALFORMED_TOKEN_CHARS &&
    /^\[\[E(?:\d+(?:(?:\]\[|, *)E\d+)*(?:\]|\]\[E?|, *E?)?|)$/u.test(suffix)
}

function hasInlineCloser(text: string, start: number, length: number): boolean {
  const paragraphEnd = /\r?\n\r?\n/u.exec(text.slice(start))
  const end = paragraphEnd ? start + paragraphEnd.index : text.length
  for (let cursor = start + length; cursor < end;) {
    if (text[cursor] !== '`') { cursor += 1; continue }
    const run = repeatedCharLength(text, cursor, '`')
    if (run === length) return true
    cursor += run
  }
  return false
}

function isCitationStart(text: string, index: number): boolean {
  return text.startsWith('[[E', index)
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
