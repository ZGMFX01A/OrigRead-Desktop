import type { LlmMessageRecord } from '../../shared/llm-chat'

export interface ReaderAiChatSearchResult {
  messageId: string
  role: 'USER' | 'ASSISTANT'
  snippet: string
}

export function displayChatAssistantContent(content: string): string {
  const citationOrder = new Map<string, number>()
  return content.replace(/\[\[(E\d+)\]\]/g, (_match, protocolId: string) => {
    let displayOrder = citationOrder.get(protocolId)
    if (!displayOrder) {
      displayOrder = citationOrder.size + 1
      citationOrder.set(protocolId, displayOrder)
    }
    return `[${displayOrder}]`
  })
}

export function searchReaderAiChatMessages(
  messages: readonly LlmMessageRecord[],
  query: string,
  maxResults = 100
): ReaderAiChatSearchResult[] {
  const needle = normalizeSearchText(query)
  if (!needle) return []

  const results: ReaderAiChatSearchResult[] = []
  for (const message of messages) {
    if (!message.historyActive || (message.role !== 'USER' && message.role !== 'ASSISTANT')) continue
    const visibleText = message.role === 'ASSISTANT'
      ? displayChatAssistantContent(message.content)
      : message.content
    const compact = compactSearchText(visibleText)
    const index = normalizeSearchText(compact).indexOf(needle)
    if (index < 0) continue

    results.push({
      messageId: message.id,
      role: message.role,
      snippet: buildSearchSnippet(compact, index, needle.length)
    })
    if (results.length >= maxResults) break
  }
  return results
}

function normalizeSearchText(value: string): string {
  return compactSearchText(value).toLocaleLowerCase()
}

function compactSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildSearchSnippet(value: string, matchIndex: number, matchLength: number): string {
  const before = 46
  const after = 78
  const start = Math.max(0, matchIndex - before)
  const end = Math.min(value.length, matchIndex + matchLength + after)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}
