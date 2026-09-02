import { describe, expect, it } from 'vitest'
import { DesktopDatabase } from '../database/database'
import { LlmChatRepository } from './chat-repository'
import {
  LLM_CITATION_SCHEMA_VERSION,
  LLM_EVIDENCE_SCHEMA_VERSION,
  type LlmCitationRefRecord,
  type LlmContextRefRecord,
  type LlmEvidenceBlockRecord,
  type LlmToolCallRecord
} from '../../shared/llm-chat'

describe('LlmChatRepository D2.6 persistence foundation', () => {
  it('freezes conversation, message, context, evidence and citation snapshots independently', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({
        id: 'conversation-1',
        title: '  Evidence   chat  ',
        providerId: 'provider-1',
        model: 'model-1',
        articleId: 'article-1',
        articleTitle: 'Original article',
        articleLink: 'https://example.com/article',
        now: 100
      })
      expect(conversation).toMatchObject({ id: 'conversation-1', title: 'Evidence chat', articleId: 'article-1' })

      repository.appendMessage(conversation.id, { id: 'user-1', role: 'USER', content: 'What changed?', now: 110 })
      const assistant = repository.appendMessage(conversation.id, {
        id: 'assistant-1', role: 'ASSISTANT', status: 'STREAMING', requestTask: 'ARTICLE_ANALYSIS', now: 120
      })

      repository.replaceConversationArticles(conversation.id, [{
        conversationId: conversation.id,
        articleId: 'article-2',
        title: 'Attached article',
        link: 'https://example.com/attached',
        originalContent: 'Frozen attached article body',
        summary: 'Frozen summary',
        position: 0,
        createdAt: 125
      }])

      const context = contextRef(assistant.id, conversation.id, 'context-ref-1', 'article:article-1', 130)
      repository.replaceContextRefsForAssistant(assistant.id, [context])
      const locator = {
        version: 1 as const,
        sourceKind: 'ARTICLE' as const,
        blockIndex: 2,
        headingPath: ['Results'],
        articleId: 'article-1',
        sourceUrl: 'https://example.com/article',
        normalizedHash: 'normalized-hash-1'
      }
      const evidence: LlmEvidenceBlockRecord = {
        id: 'evidence-block-1',
        contextRefId: context.id,
        stableLocatorKey: 'paragraph:2:normalized-hash-1',
        kind: 'PARAGRAPH',
        ordinal: 2,
        textSnapshot: 'Revenue increased by 20%.',
        normalizedSha256: 'normalized-hash-1',
        locator,
        schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION,
        createdAt: 131
      }
      repository.replaceEvidenceBlocks(context.id, [evidence])

      const citation: LlmCitationRefRecord = {
        id: 'citation-stable-uuid',
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        contextRefId: context.id,
        evidenceBlockId: evidence.id,
        targetKind: 'EVIDENCE_BLOCK',
        protocolId: 'E7',
        displayOrder: 2,
        quoteSnapshot: 'Revenue increased by 20%.',
        sourceUrl: 'https://example.com/article',
        locatorSnapshot: locator,
        schemaVersion: LLM_CITATION_SCHEMA_VERSION,
        createdAt: 132
      }
      repository.replaceCitationRefsForAssistant(assistant.id, [citation])

      expect(repository.getConversationArticles(conversation.id)).toEqual([
        expect.objectContaining({ articleId: 'article-2', originalContent: 'Frozen attached article body', position: 0 })
      ])
      expect(repository.getContextRefsForAssistant(assistant.id)).toEqual([
        expect.objectContaining({ id: 'context-ref-1', includedInPrompt: true, promptContentSnapshot: 'Prompt-visible article evidence' })
      ])
      expect(repository.getEvidenceBlocks(context.id)).toEqual([evidence])
      expect(repository.getCitationRefsForAssistant(assistant.id)).toEqual([citation])

      // Stable DB identity, provider-neutral protocol token and eventual visual order are distinct concepts.
      const restored = repository.getCitationRefsForAssistant(assistant.id)[0]!
      expect(restored.id).toBe('citation-stable-uuid')
      expect(restored.protocolId).toBe('E7')
      expect(restored.displayOrder).toBe(2)
    } finally {
      database.close()
    }
  })

  it('keeps regenerated history auditable while active history excludes superseded messages', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-branch', now: 10 })
      repository.appendMessage(conversation.id, { id: 'user-1', role: 'USER', content: 'Question', now: 20 })
      repository.appendMessage(conversation.id, { id: 'assistant-old', role: 'ASSISTANT', content: 'Old answer', now: 30 })
      repository.appendMessage(conversation.id, { id: 'assistant-new', role: 'ASSISTANT', content: 'New answer', now: 40 })

      expect(repository.setMessagesHistoryActive(['assistant-old', 'assistant-old'], false, 50)).toBe(1)
      expect(repository.getMessages(conversation.id).map((item) => [item.id, item.historyActive])).toEqual([
        ['user-1', true],
        ['assistant-old', false],
        ['assistant-new', true]
      ])
      expect(repository.getMessages(conversation.id, true).map((item) => item.id)).toEqual(['user-1', 'assistant-new'])
    } finally {
      database.close()
    }
  })

  it('keeps adjacent turn order stable when messages are requested in the same millisecond', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-same-ms', now: 10 })
      const user = repository.appendMessage(conversation.id, {
        id: 'zzzz-user', role: 'USER', content: 'Question', now: 20
      })
      const assistant = repository.appendMessage(conversation.id, {
        id: 'aaaa-assistant', role: 'ASSISTANT', status: 'STREAMING', now: 20
      })

      expect(user.createdAt).toBe(20)
      expect(assistant.createdAt).toBe(21)
      expect(repository.getMessages(conversation.id).map((message) => message.id)).toEqual([
        'zzzz-user',
        'aaaa-assistant'
      ])
    } finally {
      database.close()
    }
  })

  it('atomically starts regeneration from the latest active assistant and preserves the old answer', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-regenerate', title: 'Original title', now: 10 })
      repository.appendMessage(conversation.id, { id: 'user-1', role: 'USER', content: 'Question', now: 20 })
      repository.appendMessage(conversation.id, { id: 'assistant-old', role: 'ASSISTANT', content: 'Old answer', now: 30 })

      const branch = repository.appendRegeneratedAssistant(conversation.id, 'assistant-old', 'CHAT', 40)
      expect(branch.previous).toMatchObject({ id: 'assistant-old', historyActive: false })
      expect(branch.assistant).toMatchObject({ role: 'ASSISTANT', status: 'STREAMING', historyActive: true, requestTask: 'CHAT' })
      expect(repository.getMessages(conversation.id).map((item) => [item.id, item.historyActive, item.status])).toEqual([
        ['user-1', true, 'COMPLETE'],
        ['assistant-old', false, 'COMPLETE'],
        [branch.assistant.id, true, 'STREAMING']
      ])
      expect(() => repository.appendRegeneratedAssistant(conversation.id, 'assistant-old', 'CHAT', 50)).toThrow(/最后一条 Assistant/)

      expect(repository.updateConversationTitle(conversation.id, '  Renamed   chat  ', 60)).toMatchObject({ title: 'Renamed chat', updatedAt: 60 })
      expect(repository.deleteConversation(conversation.id)).toBe(true)
      expect(repository.deleteConversation(conversation.id)).toBe(false)
    } finally {
      database.close()
    }
  })

  it('recovers interrupted generation and tool execution without replaying side effects', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-recovery', now: 10 })
      const assistant = repository.appendMessage(conversation.id, {
        id: 'assistant-running', role: 'ASSISTANT', status: 'STREAMING', now: 20
      })
      repository.updateMessage({ ...assistant, webSearchStatus: 'TRIGGERED', updatedAt: 21 })
      const complete = repository.appendMessage(conversation.id, { id: 'assistant-complete', role: 'ASSISTANT', content: 'done', status: 'COMPLETE', now: 22 })
      const stopped = repository.appendMessage(conversation.id, { id: 'assistant-stopped', role: 'ASSISTANT', content: 'stopped', status: 'STOPPED', now: 23 })
      const failed = repository.appendMessage(conversation.id, { id: 'assistant-error', role: 'ASSISTANT', content: 'failed', status: 'ERROR', now: 24 })
      repository.appendToolCalls([
        toolCall(conversation.id, assistant.id, 'tool-running', 'RUNNING', 25),
        toolCall(conversation.id, assistant.id, 'tool-pending', 'PENDING_APPROVAL', 26),
        toolCall(conversation.id, complete.id, 'tool-complete', 'COMPLETE', 27),
        toolCall(conversation.id, stopped.id, 'tool-denied', 'DENIED', 28),
        toolCall(conversation.id, failed.id, 'tool-error', 'ERROR', 29)
      ])

      expect(repository.recoverInterruptedState(100)).toEqual({ messages: 1, toolCalls: 2 })
      expect(repository.getMessage(assistant.id)).toMatchObject({
        status: 'STOPPED', webSearchStatus: 'CANCELLED', finishReason: 'CANCELLED', updatedAt: 100
      })
      expect(repository.getMessage(complete.id)).toMatchObject({ status: 'COMPLETE', content: 'done' })
      expect(repository.getMessage(stopped.id)).toMatchObject({ status: 'STOPPED', content: 'stopped' })
      expect(repository.getMessage(failed.id)).toMatchObject({ status: 'ERROR', content: 'failed' })
      const toolCalls = repository.getToolCalls(conversation.id)
      expect(toolCalls.find((item) => item.id === 'tool-running')).toMatchObject({ status: 'ERROR', updatedAt: 100 })
      expect(toolCalls.find((item) => item.id === 'tool-running')?.errorMessage).toContain('未自动重放')
      expect(toolCalls.find((item) => item.id === 'tool-pending')).toMatchObject({ status: 'ERROR', updatedAt: 100 })
      expect(toolCalls.find((item) => item.id === 'tool-pending')?.errorMessage).toContain('审批已失效')
      expect(toolCalls.find((item) => item.id === 'tool-complete')).toMatchObject({ status: 'COMPLETE', resultContent: 'Tool result' })
      expect(toolCalls.find((item) => item.id === 'tool-denied')).toMatchObject({ status: 'DENIED' })
      expect(toolCalls.find((item) => item.id === 'tool-error')).toMatchObject({ status: 'ERROR', updatedAt: 29 })
      expect(repository.recoverInterruptedState(101)).toEqual({ messages: 0, toolCalls: 0 })
    } finally {
      database.close()
    }
  })

  it('rolls back request snapshot replacement when any new ContextRef is invalid', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-rollback', now: 10 })
      const assistant = repository.appendMessage(conversation.id, { id: 'assistant-rollback', role: 'ASSISTANT', now: 20 })
      const existing = contextRef(assistant.id, conversation.id, 'context-old', 'article:old', 30)
      repository.replaceContextRefsForAssistant(assistant.id, [existing])

      const firstNew = contextRef(assistant.id, conversation.id, 'context-new', 'article:new', 40)
      const invalid = contextRef('different-assistant', conversation.id, 'context-invalid', 'article:invalid', 41)
      expect(() => repository.replaceContextRefsForAssistant(assistant.id, [firstNew, invalid]))
        .toThrow('assistantMessageId 不一致')

      expect(repository.getContextRefsForAssistant(assistant.id).map((item) => item.id)).toEqual(['context-old'])
    } finally {
      database.close()
    }
  })

  it('rejects a citation that tries to bind one context to another context evidence block', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-integrity', now: 10 })
      const assistant = repository.appendMessage(conversation.id, { id: 'assistant-integrity', role: 'ASSISTANT', now: 20 })
      const contextA = contextRef(assistant.id, conversation.id, 'context-a', 'article:a', 30)
      const contextB = contextRef(assistant.id, conversation.id, 'context-b', 'article:b', 31)
      repository.replaceContextRefsForAssistant(assistant.id, [contextA, contextB])
      repository.replaceEvidenceBlocks(contextB.id, [{
        id: 'evidence-b', contextRefId: contextB.id, stableLocatorKey: 'p:0:b', kind: 'PARAGRAPH', ordinal: 0,
        textSnapshot: 'Evidence from B', normalizedSha256: 'hash-b',
        locator: { version: 1, sourceKind: 'ARTICLE', articleId: 'article-b', normalizedHash: 'hash-b' },
        schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION, createdAt: 32
      }])

      const forged: LlmCitationRefRecord = {
        id: 'citation-forged', conversationId: conversation.id, assistantMessageId: assistant.id,
        contextRefId: contextA.id, evidenceBlockId: 'evidence-b', targetKind: 'EVIDENCE_BLOCK', protocolId: 'E1',
        displayOrder: 1, quoteSnapshot: 'Evidence from B', sourceUrl: 'https://example.com/b', locatorSnapshot: null,
        schemaVersion: LLM_CITATION_SCHEMA_VERSION, createdAt: 33
      }
      expect(() => repository.replaceCitationRefsForAssistant(assistant.id, [forged])).toThrow()
      expect(repository.getCitationRefsForAssistant(assistant.id)).toEqual([])
    } finally {
      database.close()
    }
  })

  it('cascades all chat-owned request evidence when a conversation is deleted', () => {
    const database = new DesktopDatabase(':memory:')
    const repository = new LlmChatRepository(database.connection)
    try {
      const conversation = repository.createConversation({ id: 'conversation-delete', now: 10 })
      const assistant = repository.appendMessage(conversation.id, { id: 'assistant-delete', role: 'ASSISTANT', now: 20 })
      const context = contextRef(assistant.id, conversation.id, 'context-delete', 'article:delete', 30)
      repository.replaceContextRefsForAssistant(assistant.id, [context])
      repository.replaceEvidenceBlocks(context.id, [{
        id: 'evidence-delete', contextRefId: context.id, stableLocatorKey: 'p:0:delete', kind: 'PARAGRAPH', ordinal: 0,
        textSnapshot: 'Delete me', normalizedSha256: 'hash-delete',
        locator: { version: 1, sourceKind: 'ARTICLE', normalizedHash: 'hash-delete' },
        schemaVersion: LLM_EVIDENCE_SCHEMA_VERSION, createdAt: 31
      }])
      repository.replaceCitationRefsForAssistant(assistant.id, [{
        id: 'citation-delete', conversationId: conversation.id, assistantMessageId: assistant.id, contextRefId: context.id,
        evidenceBlockId: 'evidence-delete', targetKind: 'EVIDENCE_BLOCK', protocolId: 'E1', displayOrder: 1,
        quoteSnapshot: 'Delete me', sourceUrl: null, locatorSnapshot: null,
        schemaVersion: LLM_CITATION_SCHEMA_VERSION, createdAt: 32
      }])
      repository.appendToolCalls([toolCall(conversation.id, assistant.id, 'tool-delete', 'COMPLETE', 33)])

      repository.deleteConversation(conversation.id)
      for (const table of ['llm_messages', 'llm_tool_calls', 'llm_context_refs', 'llm_evidence_blocks', 'llm_citation_refs']) {
        expect(database.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
      }
    } finally {
      database.close()
    }
  })
})

function contextRef(
  assistantMessageId: string,
  conversationId: string,
  id: string,
  contextId: string,
  createdAt: number
): LlmContextRefRecord {
  return {
    id,
    conversationId,
    assistantMessageId,
    contextId,
    type: 'ARTICLE',
    title: 'Frozen article',
    sourceId: 'https://example.com/article',
    articleId: 'article-1',
    sourceUrl: 'https://example.com/article',
    contentSnapshot: 'Full frozen article evidence',
    promptContentSnapshot: 'Prompt-visible article evidence',
    contentSha256: `hash-${id}`,
    priority: 100,
    includedInPrompt: true,
    truncatedInPrompt: false,
    createdAt
  }
}

function toolCall(
  conversationId: string,
  assistantMessageId: string,
  id: string,
  status: LlmToolCallRecord['status'],
  createdAt: number
): LlmToolCallRecord {
  return {
    id,
    conversationId,
    assistantMessageId,
    providerCallId: `provider-${id}`,
    toolId: 'tool:test',
    apiName: 'test_tool',
    argumentsJson: '{}',
    status,
    resultContent: status === 'COMPLETE' ? 'Tool result' : null,
    errorMessage: null,
    createdAt,
    updatedAt: createdAt
  }
}
