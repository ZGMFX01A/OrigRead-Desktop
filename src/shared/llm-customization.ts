export interface LlmCustomizationSettings {
  skillsEnabled: boolean
  customInstructions: string
}

export type LlmCustomizationSettingsPatch = Partial<LlmCustomizationSettings>

export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 8_000

export const DEFAULT_LLM_CUSTOMIZATION_SETTINGS: LlmCustomizationSettings = Object.freeze({
  skillsEnabled: true,
  customInstructions: ''
})

export function normalizeLlmCustomizationSettings(value: unknown): LlmCustomizationSettings {
  const record = value && typeof value === 'object' ? value as Partial<LlmCustomizationSettings> : {}
  return {
    skillsEnabled: record.skillsEnabled !== false,
    customInstructions: normalizeCustomInstructions(record.customInstructions)
  }
}

export function normalizeLlmCustomizationSettingsPatch(value: unknown): LlmCustomizationSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('LLM customization settings patch must be an object')
  const record = value as Record<string, unknown>
  const allowed = new Set(['skillsEnabled', 'customInstructions'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new TypeError(`Unsupported LLM customization field: ${key}`)
  const patch: LlmCustomizationSettingsPatch = {}
  if ('skillsEnabled' in record) {
    if (typeof record.skillsEnabled !== 'boolean') throw new TypeError('skillsEnabled must be boolean')
    patch.skillsEnabled = record.skillsEnabled
  }
  if ('customInstructions' in record) {
    if (typeof record.customInstructions !== 'string') throw new TypeError('customInstructions must be string')
    if (record.customInstructions.trim().length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
      throw new TypeError(`customInstructions exceeds ${MAX_CUSTOM_INSTRUCTIONS_LENGTH} characters`)
    }
    patch.customInstructions = normalizeCustomInstructions(record.customInstructions)
  }
  return patch
}

function normalizeCustomInstructions(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH) : ''
}
