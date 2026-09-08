import type {
  LlmCitationAnnotationRecord,
  LlmCitationAnnotationRefRecord,
  LlmCitationRefRecord,
  LlmContextRefRecord,
  LlmConversationArticleRecord,
  LlmConversationRecord,
  LlmEvidenceBlockRecord,
  LlmMessageRecord,
  LlmToolCallStatus,
  LlmUnifiedFinishReason
} from './llm-chat'
import type { LlmReasoningPreference } from './llm'
import type { LlmToolRisk, LlmToolSource } from './llm-tool'
import type { WebSearchMode, WebSearchRequestStatus } from './web-search'

export type LlmIpcErrorCode =
  | 'CANCELLED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'TOOL_ERROR'
  | 'INTERNAL_ERROR'

/** Safe Renderer-facing error. Never add stack, prompt, request headers or secrets here. */
export interface LlmSerializedError {
  code: LlmIpcErrorCode
  message: string
  retryable: boolean
}

export interface LlmExecutionEventBase {
  requestId: string
  conversationId: string
  assistantMessageId: string
  sequence: number
  emittedAt: number
}

export type LlmExecutionEvent =
  | (LlmExecutionEventBase & { type: 'STARTED' })
  | (LlmExecutionEventBase & {
      type: 'WEB_SEARCH_STATE'
      status: WebSearchRequestStatus
      query: string | null
      providerName: string | null
      resultCount: number | null
      errorMessage: string | null
    })
  | (LlmExecutionEventBase & { type: 'REASONING_DELTA'; delta: string })
  | (LlmExecutionEventBase & { type: 'CONTENT_DELTA'; delta: string })
  | (LlmExecutionEventBase & { type: 'TOOL_STATE'; toolCallId: string; status: string })
  | (LlmExecutionEventBase & { type: 'TERMINAL'; finishReason: LlmUnifiedFinishReason })
  | (LlmExecutionEventBase & { type: 'ERROR'; error: LlmSerializedError })

export interface LlmExecutionIdentity {
  requestId: string
  conversationId: string
  assistantMessageId: string
}

export interface LlmCancelExecutionResult {
  requestId: string
  cancelled: boolean
}

export interface LlmCreateConversationRequest {
  title?: string
  providerId?: string | null
  model?: string | null
  skillId?: string | null
  articleId?: string | null
  articleTitle?: string | null
  articleLink?: string | null
}

export interface LlmUpdateConversationRequest {
  conversationId: string
  title?: string
  providerId?: string | null
  model?: string | null
}

export interface LlmArticleContextCandidate {
  articleId: string
  title: string
  link: string | null
  feedName: string | null
  publishedAt: number | null
}

export interface LlmReplaceConversationArticlesRequest {
  conversationId: string
  articleIds: string[]
}

export interface LlmDeleteConversationResult {
  conversationId: string
  deleted: boolean
}

export interface LlmAppendUserMessageRequest {
  conversationId: string
  content: string
  requestTask?: 'CHAT' | 'ARTICLE_ANALYSIS'
}

/** IPC-safe profile shape; Set is normalized in Main instead of crossing the bridge. */
export interface LlmStartExecutionProfile {
  task?: 'CHAT' | 'ARTICLE_ANALYSIS'
  providerId?: string | null
  model?: string | null
  reasoning?: LlmReasoningPreference
  skillId?: string | null
  customInstructions?: string | null
  enabledToolIds?: string[]
  contextMaxTokens?: number
  /** FORCE is one-shot. When omitted Main uses the persistent OFF/AUTO Web Search setting. */
  webSearchMode?: WebSearchMode
}

/**
 * Request-local Reader state that is not recoverable from the Conversation row alone.
 * The raw article itself remains Main-owned and is rebuilt from ReaderContentService.
 */
export interface LlmReaderContextSnapshot {
  articleId: string
  /** One-shot text selected from the canonical original Reader article. */
  selectedText?: string | null
}

export interface LlmStartExecutionRequest {
  requestId: string
  conversationId: string
  regenerateAssistantMessageId?: string
  readerContext?: LlmReaderContextSnapshot
  /** One-shot Main-owned TOOL_RESULT contexts created by explicit manual tool execution. */
  manualToolContextIds?: string[]
  profile?: LlmStartExecutionProfile
}

export interface LlmAssistantEvidenceSnapshot {
  contextRefs: LlmContextRefRecord[]
  evidenceBlocks: LlmEvidenceBlockRecord[]
  citations: LlmCitationRefRecord[]
  citationAnnotations: LlmCitationAnnotationRecord[]
  citationAnnotationRefs: LlmCitationAnnotationRefRecord[]
}

export interface LlmRestorableCitationSnapshot {
  message: LlmMessageRecord
  evidence: LlmAssistantEvidenceSnapshot
}

export type LlmToolApprovalDecision = 'APPROVE' | 'DENY'

export interface LlmToolActivityView {
  toolCallId: string
  assistantMessageId: string
  toolId: string
  name: string
  description: string
  source: LlmToolSource
  sourceId: string | null
  risk: LlmToolRisk
  status: LlmToolCallStatus
  argumentsPreview: string
  argumentsTruncated: boolean
  resultPreview: string | null
  errorMessage: string | null
}

export interface LlmResolveToolApprovalResult {
  toolCallId: string
  accepted: boolean
}

export interface LlmManualToolView {
  id: string
  name: string
  description: string
  sourceId: string | null
  risk: LlmToolRisk
  inputSchema: Record<string, unknown>
}

export interface LlmExecuteManualToolRequest {
  conversationId: string
  toolId: string
  argumentsJson: string
  /** Required for SENSITIVE/WRITE; represents the user's explicit one-shot confirmation. */
  confirmed: boolean
}

export interface LlmManualToolContextView {
  contextId: string
  conversationId: string
  toolId: string
  name: string
  risk: LlmToolRisk
  resultPreview: string
  resultTruncated: boolean
  createdAt: number
}

export interface LlmChatDataApi {
  listLlmConversations(articleId?: string | null): Promise<LlmConversationRecord[]>
  createLlmConversation(request: LlmCreateConversationRequest): Promise<LlmConversationRecord>
  updateLlmConversation(request: LlmUpdateConversationRequest): Promise<LlmConversationRecord>
  deleteLlmConversation(conversationId: string): Promise<LlmDeleteConversationResult>
  listLlmArticleContextCandidates(query?: string): Promise<LlmArticleContextCandidate[]>
  getLlmConversationArticles(conversationId: string): Promise<LlmConversationArticleRecord[]>
  replaceLlmConversationArticles(request: LlmReplaceConversationArticlesRequest): Promise<LlmConversationArticleRecord[]>
  getLlmMessages(conversationId: string): Promise<LlmMessageRecord[]>
  appendLlmUserMessage(request: LlmAppendUserMessageRequest): Promise<LlmMessageRecord>
  getLlmToolActivity(conversationId: string): Promise<LlmToolActivityView[]>
  resolveLlmToolApproval(toolCallId: string, decision: LlmToolApprovalDecision): Promise<LlmResolveToolApprovalResult>
  listLlmManualTools(): Promise<LlmManualToolView[]>
  executeLlmManualTool(request: LlmExecuteManualToolRequest): Promise<LlmManualToolContextView>
  discardLlmManualToolContext(contextId: string): Promise<boolean>
  getLlmAssistantEvidence(assistantMessageId: string): Promise<LlmAssistantEvidenceSnapshot>
  getLlmRestorableCitation(articleId: string): Promise<LlmRestorableCitationSnapshot | null>
  startLlmExecution(request: LlmStartExecutionRequest): Promise<LlmExecutionIdentity>
  cancelLlmExecution(requestId: string): Promise<LlmCancelExecutionResult>
  onLlmExecutionEvent(listener: (event: LlmExecutionEvent) => void): () => void
}
