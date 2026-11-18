import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { withGroupMessages } from './group-messages'
import { formatGroupOperationError } from './group-operation-error'

const locales = ['zh', 'en', 'es', 'pt-BR', 'de', 'fr', 'ja'] as const
const resources = withGroupMessages(Object.fromEntries(locales.map(language => [language, { translation: {} }])))

async function translator(language: string) {
  const i18n = createInstance()
  await i18n.init({ resources, lng: language, fallbackLng: false, interpolation: { escapeValue: false } })
  return i18n.getFixedT(language)
}

describe('localized group errors across the Electron boundary', () => {
  it.each(locales)('uses the %s resource for wrapped duplicate-name errors', async language => {
    const t = await translator(language)
    const error = new Error("Error invoking remote method 'library:move-group': Error: 同一层级下已存在同名分组")
    const result = formatGroupOperationError(error, t)
    expect(result).toBe(t('groupNameExists'))
    expect(result).not.toBe('groupNameExists')
    if (!['zh', 'ja'].includes(language)) expect(result).not.toMatch(/[\u4e00-\u9fff]/)
    if (language !== 'en') expect(result).not.toBe('A group with this name already exists at this level')
  })

  it('interpolates depth and retains remote sync diagnostics without implying rename failure', async () => {
    const t = await translator('fr')
    expect(formatGroupOperationError('分组层级深度超过最大限制 (32)', t)).toBe('La hiérarchie ne peut pas dépasser 32 niveaux')
    const warning = formatGroupOperationError('分组重命名远端已成功，但后续同步失败：HTTP 503: Service unavailable', t)
    expect(warning).toContain('a été renommé')
    expect(warning).toContain('HTTP 503: Service unavailable')
    expect(warning).not.toContain('{{')
  })

  it('leaves unknown diagnostics unchanged rather than translating matching substrings', async () => {
    const t = await translator('es')
    const diagnostic = 'Upstream response: 分组名称已存在 (server-specific detail)'
    expect(formatGroupOperationError(new Error(diagnostic), t)).toBe(diagnostic)
    expect(formatGroupOperationError(new Error('constructor'), t)).toBe('constructor')
  })
})
