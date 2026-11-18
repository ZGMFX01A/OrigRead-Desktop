import { describe, expect, it, vi } from 'vitest'
import {
  LOCAL_AI_PRESETS,
  getLocalAiPreset,
  addLocalAiProviderFromPreset,
  type PresetCreatorApi
} from './local-ai-presets'
import { withLocalAiMessages } from './local-ai-messages'
import type { AiSettings } from '../../shared/ai'

function createFakeAiSettings(providerIds: string[]): AiSettings {
  return {
    enabled: true,
    defaultProviderId: providerIds[0] ?? '',
    outputLanguage: 'zh-CN',
    summaryLength: 'STANDARD',
    reasoningEffort: 'AUTO',
    providers: providerIds.map((id) => ({
      id,
      name: `Provider ${id}`,
      enabled: true,
      endpoint: 'https://api.openai.com/v1',
      defaultModel: '',
      models: [],
      streamingCapabilityOverride: 'AUTO',
      toolCallingCapabilityOverride: 'AUTO',
      reasoningCapabilityOverride: 'AUTO',
      outputTokenLimitStyle: 'AUTO',
      contextWindowTokens: 0,
      strictStreamTermination: false,
      hasApiKey: false,
      apiKeyLength: 0
    }))
  }
}

describe('local-ai-presets', () => {
  it('defines valid official local endpoints for Ollama and LM Studio', () => {
    const ollama = getLocalAiPreset('ollama')
    expect(ollama).toBeDefined()
    expect(ollama?.endpoint).toBe('http://localhost:11434/v1')
    expect(ollama?.name).toBe('Ollama')

    const lmStudio = getLocalAiPreset('lmstudio')
    expect(lmStudio).toBeDefined()
    expect(lmStudio?.endpoint).toBe('http://localhost:1234/v1')
    expect(lmStudio?.name).toBe('LM Studio')

    expect(getLocalAiPreset('non-existent')).toBeUndefined()
  })

  it('creates local provider from preset and sets name and endpoint without hardcoding model', async () => {
    const initialSettings = createFakeAiSettings(['existing-1'])
    const createdId = 'new-local-id'
    const addedSettings = createFakeAiSettings(['existing-1', createdId])
    const finalSettings = {
      ...addedSettings,
      providers: addedSettings.providers.map((p) =>
        p.id === createdId ? { ...p, name: 'Ollama', endpoint: 'http://localhost:11434/v1' } : p
      )
    }

    const api: PresetCreatorApi = {
      getAiSettings: vi.fn().mockResolvedValue(initialSettings),
      addAiProvider: vi.fn().mockResolvedValue(addedSettings),
      updateAiProvider: vi.fn().mockResolvedValue(finalSettings),
      removeAiProvider: vi.fn().mockResolvedValue(initialSettings)
    }

    const preset = getLocalAiPreset('ollama')!
    const result = await addLocalAiProviderFromPreset(preset, api)

    expect(api.getAiSettings).toHaveBeenCalled()
    expect(api.addAiProvider).toHaveBeenCalled()
    expect(api.updateAiProvider).toHaveBeenCalledWith({
      id: createdId,
      name: 'Ollama',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: '',
      models: []
    })
    expect(api.removeAiProvider).not.toHaveBeenCalled()
    expect(result.createdProviderId).toBe(createdId)
    expect(result.settings).toEqual(finalSettings)
  })

  it('does not overwrite or remove an existing provider when creation returns no new record', async () => {
    const initial = createFakeAiSettings(['existing-1'])
    const api: PresetCreatorApi = {
      getAiSettings: vi.fn().mockResolvedValue(initial),
      addAiProvider: vi.fn().mockResolvedValue(initial),
      updateAiProvider: vi.fn(),
      removeAiProvider: vi.fn()
    }
    await expect(addLocalAiProviderFromPreset(LOCAL_AI_PRESETS[0]!, api)).rejects.toThrow('Failed to create')
    expect(api.updateAiProvider).not.toHaveBeenCalled()
    expect(api.removeAiProvider).not.toHaveBeenCalled()
  })

  it('configures its appended provider rather than a concurrent addition', async () => {
    const initial = createFakeAiSettings(['existing-1'])
    const added = createFakeAiSettings(['existing-1', 'concurrent', 'own-new'])
    const api: PresetCreatorApi = {
      getAiSettings: vi.fn().mockResolvedValue(initial),
      addAiProvider: vi.fn().mockResolvedValue(added),
      updateAiProvider: vi.fn().mockResolvedValue(added),
      removeAiProvider: vi.fn()
    }
    const result = await addLocalAiProviderFromPreset(LOCAL_AI_PRESETS[0]!, api)
    expect(result.createdProviderId).toBe('own-new')
    expect(api.updateAiProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'own-new' }))
  })

  it('rolls back newly added provider if updateAiProvider fails, preventing cloud default leftovers', async () => {
    const initialSettings = createFakeAiSettings(['existing-1'])
    const createdId = 'temporary-id'
    const addedSettings = createFakeAiSettings(['existing-1', createdId])

    const api: PresetCreatorApi = {
      getAiSettings: vi.fn().mockResolvedValue(initialSettings),
      addAiProvider: vi.fn().mockResolvedValue(addedSettings),
      updateAiProvider: vi.fn().mockRejectedValue(new Error('Update failed')),
      removeAiProvider: vi.fn().mockResolvedValue(initialSettings)
    }

    const preset = getLocalAiPreset('lmstudio')!

    await expect(addLocalAiProviderFromPreset(preset, api)).rejects.toThrow('Update failed')

    expect(api.removeAiProvider).toHaveBeenCalledWith(createdId)
  })
})

describe('withLocalAiMessages', () => {
  it('uses localized messages for supported locales and falls back to English only for unknown locales', () => {
    const baseResources = {
      zh: { translation: { existing: '已有中文' } },
      en: { translation: { existing: 'Existing English' } },
      ja: { translation: { existing: '既存' } },
      xx: { translation: { existing: 'Custom' } }
    }

    const wrapped = withLocalAiMessages(baseResources)

    expect((wrapped.zh.translation as Record<string, string>).addLocalAiProviderOllama).toBe('添加 Ollama 本地服务')
    expect((wrapped.zh.translation as Record<string, string>).translationAiNoticeTitle).toBe('关于翻译服务与 AI 模型')

    expect((wrapped.en.translation as Record<string, string>).addLocalAiProviderOllama).toBe('Add Ollama local service')
    expect((wrapped.en.translation as Record<string, string>).translationAiNoticeTitle).toBe('About Translation Services & AI Models')

    expect((wrapped.ja.translation as Record<string, string>).addLocalAiProviderOllama).toBe('Ollamaのローカルサービスを追加')
    expect(wrapped.ja.translation.existing).toBe('既存')
    expect((wrapped.xx.translation as Record<string, string>).addLocalAiProviderOllama).toBe('Add Ollama local service')
  })
})
