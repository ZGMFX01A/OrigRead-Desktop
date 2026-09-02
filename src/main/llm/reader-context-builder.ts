import type { LlmContextRefRecord, LlmConversationRecord } from '../../shared/llm-chat'
import type { LlmContextItem } from '../../shared/llm-context'
import type { LlmReaderContextSnapshot } from '../../shared/llm-ipc'
import { SELECTED_TEXT_CONTEXT_PRIORITY } from './context-priority'

const MAX_ARTICLE_ID_CHARS = 500
const MAX_SELECTION_CHARS = 50_000

export function validateLlmReaderContextSnapshot(value: unknown): LlmReaderContextSnapshot {
  if (!isRecord(value)) throw new TypeError('readerContext must be an object')
  const allowed = new Set(['articleId', 'selectedText'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`Unsupported readerContext field: ${key}`)

  const articleId = boundedText(value.articleId, 'readerContext.articleId', MAX_ARTICLE_ID_CHARS).trim()
  if (!articleId) throw new TypeError('readerContext.articleId 不能为空')
  const result: LlmReaderContextSnapshot = { articleId }

  if (value.selectedText !== undefined) {
    result.selectedText = value.selectedText === null
      ? null
      : boundedText(value.selectedText, 'readerContext.selectedText', MAX_SELECTION_CHARS)
  }
  return result
}

/**
 * Build request-local Reader context. The canonical raw ARTICLE remains Main-owned and
 * is the only automatic factual source; derived Summary/Translation artifacts are never
 * re-fed into normal chat by default.
 */
export function buildReaderStateContextItems(
  conversation: LlmConversationRecord,
  snapshot: LlmReaderContextSnapshot | undefined
): LlmContextItem[] {
  if (!snapshot) return []
  if (!conversation.articleId || snapshot.articleId !== conversation.articleId) {
    throw new Error('Reader Context 与当前会话文章不一致')
  }

  const articleId = conversation.articleId
  const sourceId = conversation.articleLink
  const items: LlmContextItem[] = []
  const selectedText = snapshot.selectedText?.trim() ?? ''
  if (selectedText) {
    items.push({
      id: `article:${articleId}:selection`,
      type: 'SELECTED_TEXT',
      content: selectedText,
      title: conversation.articleTitle,
      sourceId,
      internalArticleId: articleId,
      priority: SELECTED_TEXT_CONTEXT_PRIORITY
    })
  }
  return items
}

/** Regenerate must reuse the selection that belonged to the answer being regenerated. */
export function buildRegeneratedReaderSelectionContextItems(
  conversation: LlmConversationRecord,
  previousContextRefs: readonly LlmContextRefRecord[]
): LlmContextItem[] {
  if (!conversation.articleId) return []
  const selection = previousContextRefs.find((ref) =>
    ref.type === 'SELECTED_TEXT'
    && ref.articleId === conversation.articleId
    && ref.contentSnapshot.trim()
  )
  if (!selection) return []
  return [{
    id: `article:${conversation.articleId}:selection`,
    type: 'SELECTED_TEXT',
    content: selection.contentSnapshot,
    title: conversation.articleTitle,
    sourceId: conversation.articleLink,
    internalArticleId: conversation.articleId,
    priority: SELECTED_TEXT_CONTEXT_PRIORITY
  }]
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (value.length > maxLength) throw new TypeError(`${label} is too long`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
