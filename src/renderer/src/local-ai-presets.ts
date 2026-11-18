import type { AiProviderPatch, AiSettings } from '../../shared/ai'

/**
 * 本地 AI 服务预设定义
 * 包含官方推荐的默认 OpenAI 兼容本地端点
 */
export interface LocalAiPreset {
  id: string
  name: string
  endpoint: string
  descriptionKey?: string
}

export const LOCAL_AI_PRESETS: readonly LocalAiPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    descriptionKey: 'addLocalAiProviderOllama'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    endpoint: 'http://localhost:1234/v1',
    descriptionKey: 'addLocalAiProviderLmStudio'
  }
] as const

export function getLocalAiPreset(presetId: string): LocalAiPreset | undefined {
  return LOCAL_AI_PRESETS.find((preset) => preset.id === presetId)
}

export interface PresetCreatorApi {
  getAiSettings(): Promise<AiSettings>
  addAiProvider(): Promise<AiSettings>
  updateAiProvider(patch: AiProviderPatch): Promise<AiSettings>
  removeAiProvider(id: string): Promise<AiSettings>
}

/**
 * 基于预设快速创建本地 AI 服务
 * 复用现有的 addAiProvider 与 updateAiProvider 接口
 * 若后续更新配置失败，自动执行回滚删除，避免误留默认云端配置
 */
export async function addLocalAiProviderFromPreset(
  preset: LocalAiPreset,
  api: PresetCreatorApi
): Promise<{ settings: AiSettings; createdProviderId: string }> {
  const current = await api.getAiSettings()
  const existingIds = new Set(current.providers.map((p) => p.id))
  const added = await api.addAiProvider()
  // addAiProvider appends its own record atomically; another addition may have
  // appeared since getAiSettings, so the first unfamiliar ID is not ownership.
  const created = added.providers.at(-1)
  if (!created || existingIds.has(created.id)) {
    throw new Error('Failed to create AI provider')
  }

  try {
    const updated = await api.updateAiProvider({
      id: created.id,
      name: preset.name,
      endpoint: preset.endpoint,
      defaultModel: '',
      models: []
    })
    return {
      settings: updated,
      createdProviderId: created.id
    }
  } catch (error) {
    // 处理失败避免误把默认云端配置当成本地创建成功
    try {
      await api.removeAiProvider(created.id)
    } catch {
      // 忽略回滚阶段的次级失败
    }
    throw error
  }
}
