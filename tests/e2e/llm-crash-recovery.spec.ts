import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { DesktopDatabase } from '../../src/main/database/database'
import { LlmChatRepository } from '../../src/main/llm/chat-repository'
import type { LlmToolCallRecord } from '../../src/shared/llm-chat'
import { launchOrigReadWithUserData } from './electron-test-app'

test('startup recovers persisted streaming, search, approval, and running tool states without replay', async () => {
  const root = join(process.cwd(), 'test-results')
  await mkdir(root, { recursive: true })
  const userDataDir = await mkdtemp(join(root, 'crash-recovery-'))
  const databasePath = join(userDataDir, 'origread.db')

  const database = new DesktopDatabase(databasePath)
  const repository = new LlmChatRepository(database.connection)
  const conversation = repository.createConversation({ id: 'crash-conversation', title: 'Crash recovery', now: 10 })
  repository.appendMessage(conversation.id, { id: 'user-1', role: 'USER', content: 'Question before crash', now: 20 })
  const assistant = repository.appendMessage(conversation.id, {
    id: 'assistant-crashed', role: 'ASSISTANT', content: 'partial answer', status: 'STREAMING', now: 30
  })
  repository.updateMessage({
    ...assistant,
    content: 'partial answer',
    reasoning: 'partial reasoning',
    webSearchStatus: 'TRIGGERED',
    webSearchQuery: 'query before crash',
    updatedAt: 31
  })
  repository.appendToolCalls([
    toolCall(conversation.id, assistant.id, 'tool-awaiting-approval', 'PENDING_APPROVAL', 32),
    toolCall(conversation.id, assistant.id, 'tool-running', 'RUNNING', 33)
  ])
  database.close()

  const testApp = await launchOrigReadWithUserData(userDataDir)
  try {
    const page = await testApp.app.firstWindow()
    await expect(page.locator('.app-shell')).toBeVisible()

    const recovered = await page.evaluate(async () => ({
      messages: await window.origread.getLlmMessages('crash-conversation'),
      tools: await window.origread.getLlmToolActivity('crash-conversation')
    }))
    const recoveredAssistant = recovered.messages.find((message) => message.id === 'assistant-crashed')
    expect(recoveredAssistant).toMatchObject({
      status: 'STOPPED',
      content: 'partial answer',
      reasoning: 'partial reasoning',
      webSearchStatus: 'CANCELLED',
      finishReason: 'CANCELLED'
    })
    expect(recovered.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolCallId: 'tool-awaiting-approval', status: 'ERROR' }),
      expect.objectContaining({ toolCallId: 'tool-running', status: 'ERROR' })
    ]))
    expect(recovered.tools.find((tool) => tool.toolCallId === 'tool-awaiting-approval')?.errorMessage).toContain('审批已失效')
    expect(recovered.tools.find((tool) => tool.toolCallId === 'tool-running')?.errorMessage).toContain('未自动重放')
  } finally {
    await testApp.close()
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 80 })
  }
})

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
    toolId: `mcp:${id}`,
    apiName: id,
    argumentsJson: '{}',
    status,
    resultContent: null,
    errorMessage: null,
    createdAt,
    updatedAt: createdAt
  }
}
