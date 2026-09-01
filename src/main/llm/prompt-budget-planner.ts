import type { AiChatMessage, AiChatToolDefinition } from '../ai/openai-compatible-provider'
import type { LlmExecutionPlan } from './execution-runtime'
import { estimateLlmTokens } from './context-composer'

const MESSAGE_OVERHEAD_TOKENS = 6
const TOOL_SCHEMA_OVERHEAD_TOKENS = 12
const OUTPUT_RESERVE_DIVISOR = 8
const MIN_OUTPUT_RESERVE_TOKENS = 1_024
const MAX_OUTPUT_RESERVE_TOKENS = 8_192

export interface LlmPromptBudgetSnapshot {
  promptTokens: number
  outputReserveTokens: number
  requiredTokens: number
}

/** Android-aligned total request budget gate. It never silently breaks tool-call topology. */
export function validateLlmPromptBudget(
  plan: LlmExecutionPlan,
  messages: readonly AiChatMessage[],
  tools: readonly AiChatToolDefinition[]
): LlmPromptBudgetSnapshot {
  const historyTokens = messages.reduce((total, message) => {
    const toolCallTokens = (message.toolCalls ?? []).reduce((sum, call) =>
      sum + estimateLlmTokens(call.id) + estimateLlmTokens(call.name) + estimateLlmTokens(call.argumentsJson), 0)
    return total
      + estimateLlmTokens(message.content)
      + MESSAGE_OVERHEAD_TOKENS
      + toolCallTokens
      + (message.toolCallId ? estimateLlmTokens(message.toolCallId) : 0)
  }, 0)
  const toolSchemaTokens = plan.automaticToolCalling
    ? tools.reduce((total, tool) => total
        + estimateLlmTokens(tool.name)
        + estimateLlmTokens(tool.description)
        + estimateLlmTokens(JSON.stringify(tool.parameters))
        + TOOL_SCHEMA_OVERHEAD_TOKENS, 0)
    : 0
  const promptTokens = historyTokens + toolSchemaTokens
  const outputReserveTokens = clamp(
    Math.floor(plan.capability.contextWindowTokens / OUTPUT_RESERVE_DIVISOR),
    MIN_OUTPUT_RESERVE_TOKENS,
    MAX_OUTPUT_RESERVE_TOKENS
  )
  const requiredTokens = promptTokens + outputReserveTokens
  if (requiredTokens > plan.capability.contextWindowTokens) {
    throw new Error(
      `请求超过模型上下文窗口：Prompt 约 ${promptTokens} tokens，输出预留 ${outputReserveTokens} tokens，窗口 ${plan.capability.contextWindowTokens} tokens。完整 Tool 历史无法安全裁剪，请减少会话历史、Context、Skill/Custom Instructions 或 Tool。`
    )
  }
  return { promptTokens, outputReserveTokens, requiredTokens }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
