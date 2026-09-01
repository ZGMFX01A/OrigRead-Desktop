import type { AiProviderProfile } from '../../shared/ai'
import type { LlmReasoningPreference } from '../../shared/llm'
import type { AiSettingsRepository } from '../ai/ai-settings-repository'
import {
  applyAiProviderCapabilityOverride,
  resolveAiProviderCapability,
  type AiProviderCapability,
  type AiProviderCapabilityOverride
} from '../ai/ai-provider-capabilities'
import type { AiRuntimeConfig } from '../ai/openai-compatible-provider'
import { resolveLlmReasoningConfig, type ResolvedLlmReasoningConfig } from './reasoning-config'

/** Main-only adapter: secrets stay here and are never part of Renderer/shared settings models. */
export class OpenAiCompatibleLlmAdapter {
  constructor(private readonly settings: AiSettingsRepository) {}

  resolveProvider(requestedProviderId?: string | null): AiProviderProfile {
    const settings = this.settings.current()
    if (!settings.enabled) throw new Error('AI 功能尚未启用')
    const requested = requestedProviderId?.trim()
    const provider = requested
      ? settings.providers.find((item) => item.id === requested)
      : settings.providers.find((item) => item.id === settings.defaultProviderId)
        ?? settings.providers.find((item) => item.enabled)
    if (!provider) throw new Error('没有可用的 AI 服务')
    if (!provider.enabled) throw new Error('所选 AI 服务未启用')
    if (!provider.endpoint.trim()) throw new Error('所选 AI 服务地址为空')
    return provider
  }

  resolveModel(provider: AiProviderProfile, requestedModel?: string | null): string {
    const requested = requestedModel?.trim()
    const model = requested || provider.defaultModel.trim() || provider.models[0]?.trim() || ''
    if (!model) throw new Error('所选 AI 服务没有可用模型')
    if (requested && provider.models.length > 0 && !provider.models.includes(requested)) {
      throw new Error('所选模型不属于当前 AI Provider')
    }
    return model
  }

  capability(
    provider: AiProviderProfile,
    model: string,
    requestOverride?: AiProviderCapabilityOverride | null
  ): AiProviderCapability {
    return applyAiProviderCapabilityOverride(resolveAiProviderCapability(provider, model), requestOverride)
  }

  reasoning(capability: AiProviderCapability, preference: LlmReasoningPreference): ResolvedLlmReasoningConfig {
    return resolveLlmReasoningConfig(capability, preference)
  }

  runtimeConfig(
    provider: AiProviderProfile,
    model: string,
    capability: AiProviderCapability,
    reasoning: ResolvedLlmReasoningConfig
  ): AiRuntimeConfig {
    return {
      endpoint: provider.endpoint,
      model,
      apiKey: this.settings.getApiKey(provider.id),
      outputTokenLimitStyle: capability.outputTokenLimitStyle,
      strictStreamTermination: capability.strictStreamTermination,
      reasoningParameter: reasoning.providerParameter
    }
  }
}
