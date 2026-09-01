import { describe, expect, it } from 'vitest'
import type { LlmMessageRecord } from '../../shared/llm-chat'
import { displayChatAssistantContent, searchReaderAiChatMessages } from './reader-ai-chat-search'

function message(id: string, role: 'USER' | 'ASSISTANT', content: string, historyActive = true): LlmMessageRecord {
  return {
    id,
    conversationId: 'conversation-1',
    role,
    content,
    requestTask: 'CHAT',
    providerId: null,
    model: null,
    reasoning: null,
    status: 'COMPLETE',
    errorMessage: null,
    historyActive,
    webSearchStatus: null,
    webSearchQuery: null,
    webSearchProviderName: null,
    webSearchResultCount: null,
    webSearchErrorMessage: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
    tokenUsageEstimated: false,
    finishReason: 'STOP',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('Reader AI current-chat search', () => {
  it('searches only visible active USER/ASSISTANT messages and returns compact snippets', () => {
    const results = searchReaderAiChatMessages([
      message('u1', 'USER', 'Why did revenue increase?'),
      message('a1', 'ASSISTANT', 'Revenue increased because subscriptions grew.'),
      message('a-old', 'ASSISTANT', 'Revenue old branch', false)
    ], 'revenue')

    expect(results).toEqual([
      { messageId: 'u1', role: 'USER', snippet: 'Why did revenue increase?' },
      { messageId: 'a1', role: 'ASSISTANT', snippet: 'Revenue increased because subscriptions grew.' }
    ])
  })

  it('uses user-visible citation numbers instead of leaking evidence protocol ids', () => {
    expect(displayChatAssistantContent('First [[E7]], same [[E7]], next [[E2]].')).toBe('First [1], same [1], next [2].')
    expect(searchReaderAiChatMessages([
      message('a1', 'ASSISTANT', 'Revenue rose [[E7]].')
    ], 'revenue')[0]?.snippet).toBe('Revenue rose [1].')
  })
})
