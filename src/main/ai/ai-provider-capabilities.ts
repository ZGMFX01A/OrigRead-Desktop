import type {
  AiCapabilityOverrideMode,
  AiOutputTokenLimitStyle,
  AiProviderProfile
} from '../../shared/ai'
import { DEFAULT_AI_CONTEXT_WINDOW_TOKENS } from '../../shared/ai'
import type { LlmReasoningEffort, ProviderReasoningParameter, ReasoningParameterStyle } from '../../shared/llm'

export type ResolvedAiOutputTokenLimitStyle = Exclude<AiOutputTokenLimitStyle, 'AUTO'>

export interface AiProviderCapability {
  supportsStreaming: boolean
  supportsToolCalling: boolean
  supportsNativeWebSearch: boolean
  supportedReasoningEfforts: ReadonlySet<LlmReasoningEffort>
  reasoningParameterStyle: ReasoningParameterStyle
  supportsReasoningOutput: boolean
  /** Future adapter seams. Keep false until the current request adapter can actually carry them. */
  supportsImageInput: boolean
  supportsFileInput: boolean
  supportsStructuredOutput: boolean
  contextWindowTokens: number
  outputTokenLimitStyle: ResolvedAiOutputTokenLimitStyle
  strictStreamTermination: boolean
}

/** Request-level restrictions/capability injection. Undefined fields preserve provider/model resolution. */
export interface AiProviderCapabilityOverride {
  supportsStreaming?: boolean
  supportsToolCalling?: boolean
  supportsNativeWebSearch?: boolean
  supportedReasoningEfforts?: ReadonlySet<LlmReasoningEffort>
  reasoningParameterStyle?: ReasoningParameterStyle
  supportsReasoningOutput?: boolean
  supportsImageInput?: boolean
  supportsFileInput?: boolean
  supportsStructuredOutput?: boolean
  contextWindowTokens?: number
  outputTokenLimitStyle?: ResolvedAiOutputTokenLimitStyle
  strictStreamTermination?: boolean
}

/**
 * 与 Android 保持同一 AUTO 语义：只有官方 OpenAI 的 reasoning 系列自动改用
 * max_completion_tokens；自建兼容网关即使复用同名模型也继续走兼容面更广的 max_tokens。
 */
export function resolveAiOutputTokenLimitStyle(
  endpoint: string,
  model: string,
  configuredStyle: AiOutputTokenLimitStyle = 'AUTO'
): ResolvedAiOutputTokenLimitStyle {
  if (configuredStyle === 'MAX_TOKENS' || configuredStyle === 'MAX_COMPLETION_TOKENS') return configuredStyle
  const officialOpenAi = endpointHost(endpoint) === 'api.openai.com'
  const normalizedModel = model.trim().toLowerCase()
  const reasoningModel = ['o1', 'o3', 'o4', 'gpt-5'].some((prefix) => normalizedModel.startsWith(prefix))
  return officialOpenAi && reasoningModel ? 'MAX_COMPLETION_TOKENS' : 'MAX_TOKENS'
}

/**
 * Provider 名称只用于展示，绝不参与 capability 判断。
 * 未知 OpenAI-compatible 服务采用保守基线：默认支持流式，但不假定支持 tools/reasoning。
 */
export function resolveAiProviderCapability(provider: AiProviderProfile, model: string): AiProviderCapability {
  const host = endpointHost(provider.endpoint)
  const normalizedModel = model.trim().toLowerCase()

  let supportsStreaming = true
  let supportsToolCalling = false
  let supportedReasoningEfforts = new Set<LlmReasoningEffort>()
  let reasoningParameterStyle: ReasoningParameterStyle = 'NONE'
  let supportsReasoningOutput = false

  if (host === 'api.openai.com') {
    supportsToolCalling = normalizedModel.startsWith('gpt-') || normalizedModel.startsWith('o3') || normalizedModel.startsWith('o4')
    supportedReasoningEfforts = openAiReasoningEfforts(normalizedModel)
    reasoningParameterStyle = supportedReasoningEfforts.size > 0 ? 'OPENAI_REASONING_EFFORT' : 'NONE'
    // 官方 OpenAI API 不默认承诺暴露可展示的隐藏 reasoning 文本。
    supportsReasoningOutput = false
  } else if (host === 'api.deepseek.com') {
    // 2026-07 起官方 API 已切到 V4 双模式；V4 thinking 支持 reasoning_content + tools。
    // 旧 deepseek-chat / deepseek-reasoner 已退役，不再把旧名字当成当前能力依据。
    if (isDeepSeekV4Model(normalizedModel)) {
      supportsToolCalling = true
      supportedReasoningEfforts = new Set(['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAXIMUM'])
      reasoningParameterStyle = 'OPENAI_REASONING_EFFORT'
      supportsReasoningOutput = true
    }
  }

  supportsStreaming = applyBooleanOverride(supportsStreaming, provider.streamingCapabilityOverride)
  supportsToolCalling = applyBooleanOverride(supportsToolCalling, provider.toolCallingCapabilityOverride)
  const reasoningOverride = overrideBoolean(provider.reasoningCapabilityOverride)
  if (reasoningOverride !== null) {
    supportsReasoningOutput = reasoningOverride
    supportedReasoningEfforts = reasoningOverride ? new Set(['LOW', 'MEDIUM', 'HIGH']) : new Set()
    reasoningParameterStyle = reasoningOverride ? 'OPENAI_REASONING_EFFORT' : 'NONE'
  }

  return {
    supportsStreaming,
    supportsToolCalling,
    supportsNativeWebSearch: false,
    supportedReasoningEfforts,
    reasoningParameterStyle,
    supportsReasoningOutput,
    supportsImageInput: false,
    supportsFileInput: false,
    supportsStructuredOutput: false,
    contextWindowTokens: Number.isFinite(provider.contextWindowTokens) ? provider.contextWindowTokens : DEFAULT_AI_CONTEXT_WINDOW_TOKENS,
    outputTokenLimitStyle: resolveAiOutputTokenLimitStyle(provider.endpoint, model, provider.outputTokenLimitStyle),
    strictStreamTermination: provider.strictStreamTermination !== false
  }
}

/** Provider settings resolve first; one execution may only restrict/override the resulting capability last. */
export function applyAiProviderCapabilityOverride(
  base: AiProviderCapability,
  override?: AiProviderCapabilityOverride | null
): AiProviderCapability {
  if (!override) return base
  return {
    supportsStreaming: override.supportsStreaming ?? base.supportsStreaming,
    supportsToolCalling: override.supportsToolCalling ?? base.supportsToolCalling,
    supportsNativeWebSearch: override.supportsNativeWebSearch ?? base.supportsNativeWebSearch,
    supportedReasoningEfforts: override.supportedReasoningEfforts ?? base.supportedReasoningEfforts,
    reasoningParameterStyle: override.reasoningParameterStyle ?? base.reasoningParameterStyle,
    supportsReasoningOutput: override.supportsReasoningOutput ?? base.supportsReasoningOutput,
    supportsImageInput: override.supportsImageInput ?? base.supportsImageInput,
    supportsFileInput: override.supportsFileInput ?? base.supportsFileInput,
    supportsStructuredOutput: override.supportsStructuredOutput ?? base.supportsStructuredOutput,
    contextWindowTokens: override.contextWindowTokens ?? base.contextWindowTokens,
    outputTokenLimitStyle: override.outputTokenLimitStyle ?? base.outputTokenLimitStyle,
    strictStreamTermination: override.strictStreamTermination ?? base.strictStreamTermination
  }
}

export function resolveProviderReasoningParameter(
  capability: AiProviderCapability,
  requested: LlmReasoningEffort
): ProviderReasoningParameter | null {
  if (requested === 'AUTO' || !capability.supportedReasoningEfforts.has(requested)) return null
  if (capability.reasoningParameterStyle !== 'OPENAI_REASONING_EFFORT') return null
  const value = reasoningEffortWireValue(requested)
  return value ? { key: 'reasoning_effort', value } : null
}

function applyBooleanOverride(base: boolean, override: AiCapabilityOverrideMode): boolean {
  if (override === 'ENABLED') return true
  if (override === 'DISABLED') return false
  return base
}

function overrideBoolean(override: AiCapabilityOverrideMode): boolean | null {
  if (override === 'ENABLED') return true
  if (override === 'DISABLED') return false
  return null
}

function openAiReasoningEfforts(model: string): Set<LlmReasoningEffort> {
  if (model.startsWith('gpt-5.6')) return new Set(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAXIMUM'])
  if (model.startsWith('gpt-5.3-codex')) return new Set(['LOW', 'MEDIUM', 'HIGH', 'XHIGH'])
  if (['gpt-5.2', 'gpt-5.4', 'gpt-5.5'].some((prefix) => model.startsWith(prefix))) {
    return new Set(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'])
  }
  if (model.startsWith('gpt-5.1')) return new Set(['NONE', 'LOW', 'MEDIUM', 'HIGH'])
  if (model === 'gpt-5' || model.startsWith('gpt-5-') || model.startsWith('gpt-5-mini') || model.startsWith('gpt-5-nano')) {
    return new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])
  }
  if (model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return new Set(['LOW', 'MEDIUM', 'HIGH'])
  }
  return new Set()
}

function isDeepSeekV4Model(model: string): boolean {
  return model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash' || model.startsWith('deepseek-v4-flash-vision')
}

function reasoningEffortWireValue(effort: LlmReasoningEffort): ProviderReasoningParameter['value'] | null {
  if (effort === 'NONE') return 'none'
  if (effort === 'MINIMAL') return 'minimal'
  if (effort === 'LOW') return 'low'
  if (effort === 'MEDIUM') return 'medium'
  if (effort === 'HIGH') return 'high'
  if (effort === 'XHIGH') return 'xhigh'
  if (effort === 'MAXIMUM') return 'max'
  return null
}

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint.trim()).hostname.toLowerCase() } catch { return '' }
}
