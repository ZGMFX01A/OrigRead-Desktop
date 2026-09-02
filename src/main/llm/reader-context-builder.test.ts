import { describe, expect, it } from 'vitest'
import type { LlmContextRefRecord, LlmConversationRecord } from '../../shared/llm-chat'
import {
  buildReaderStateContextItems,
  buildRegeneratedReaderSelectionContextItems,
  validateLlmReaderContextSnapshot
} from './reader-context-builder'

const conversation: LlmConversationRecord = {
  id: 'conversation-1',
  title: 'Reader chat',
  providerId: null,
  model: null,
  skillId: null,
  articleId: 'article-1',
  articleTitle: 'Source article',
  articleLink: 'https://example.com/article',
  createdAt: 1,
  updatedAt: 1
}

describe('Reader current context', () => {
  it('projects only the explicit original-text selection; derived artifacts are not automatic factual context', () => {
    const snapshot = validateLlmReaderContextSnapshot({
      articleId: 'article-1',
      selectedText: 'Selected evidence'
    })

    const items = buildReaderStateContextItems(conversation, snapshot)
    expect(items.map((item) => [item.type, item.priority])).toEqual([['SELECTED_TEXT', 16000]])
    expect(items[0]).toMatchObject({
      content: 'Selected evidence',
      internalArticleId: 'article-1',
      sourceId: 'https://example.com/article'
    })
  })

  it('rejects summary and translation payloads so Renderer cannot accidentally re-feed transformed text', () => {
    expect(() => validateLlmReaderContextSnapshot({ articleId: 'article-1', summaryMarkdown: 'derived' }))
      .toThrow(/Unsupported readerContext field/)
    expect(() => validateLlmReaderContextSnapshot({ articleId: 'article-1', translation: { translatedContent: 'derived' } }))
      .toThrow(/Unsupported readerContext field/)
  })

  it('rejects stale Reader state from a different article before execution', () => {
    expect(() => buildReaderStateContextItems(conversation, { articleId: 'article-2', selectedText: 'stale' }))
      .toThrow(/文章不一致/)
  })

  it('reuses the previous answer selection for Regenerate instead of consuming a new UI selection', () => {
    const refs: LlmContextRefRecord[] = [{
      id: 'ref-selection',
      conversationId: conversation.id,
      assistantMessageId: 'assistant-old',
      contextId: 'article:article-1:selection',
      type: 'SELECTED_TEXT',
      title: 'Source article',
      sourceId: 'https://example.com/article',
      articleId: 'article-1',
      sourceUrl: 'https://example.com/article',
      contentSnapshot: 'Original selected evidence',
      promptContentSnapshot: 'Original selected evidence',
      contentSha256: 'hash',
      priority: 16000,
      includedInPrompt: true,
      truncatedInPrompt: false,
      createdAt: 1
    }]
    expect(buildRegeneratedReaderSelectionContextItems(conversation, refs)).toEqual([
      expect.objectContaining({ type: 'SELECTED_TEXT', content: 'Original selected evidence', priority: 16000 })
    ])
  })

  it('rejects unknown fields instead of silently accepting Renderer payload expansion', () => {
    expect(() => validateLlmReaderContextSnapshot({ articleId: 'article-1', rawPrompt: 'do not accept' }))
      .toThrow(/Unsupported readerContext field/)
  })
})
