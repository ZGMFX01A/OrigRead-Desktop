import type { DesktopLanguage } from './locale'

export type DesktopLanguagePreference = 'system' | DesktopLanguage
export type AiSummaryPlacement = 'replace' | 'left' | 'right' | 'top' | 'bottom'
export type ThemePreference = 'system' | 'light' | 'dark'
export type ReaderBackgroundPreference = 'theme' | 'paper' | 'warm' | 'sepia' | 'mint' | 'custom'

export const SYNC_INTERVAL_OPTIONS = [0, 15, 30, 60, 120, 180, 360, 720, 1440] as const
export type SyncIntervalMinutes = typeof SYNC_INTERVAL_OPTIONS[number]

export interface DesktopSettings {
  language: DesktopLanguagePreference
  theme: ThemePreference
  workspaceCollapsed: boolean
  workspaceWidth: number
  readerFontSize: number
  readerFontId: string
  readerLineHeight: number
  readerContentWidth: number
  readerBackground: ReaderBackgroundPreference
  readerBackgroundCustom: string
  ttsVoiceURI: string
  aiSummaryPlacement: AiSummaryPlacement
  aiSummaryPanelSize: number
  readingShareConfigured: boolean
  readingShareIncludeTitle: boolean
  readingShareIncludeBody: boolean
  readingShareIncludeTranslation: boolean
  readingShareIncludeSummary: boolean
  syncIntervalMinutes: SyncIntervalMinutes
  syncOnStart: boolean
  autoCheckUpdates: boolean
}

export type DesktopSettingsPatch = Partial<DesktopSettings>

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  language: 'system',
  theme: 'system',
  workspaceCollapsed: false,
  workspaceWidth: 420,
  readerFontSize: 17,
  readerFontId: 'system',
  readerLineHeight: 1.85,
  readerContentWidth: 760,
  readerBackground: 'theme',
  readerBackgroundCustom: '#eef7ee',
  ttsVoiceURI: '',
  aiSummaryPlacement: 'replace',
  aiSummaryPanelSize: 360,
  readingShareConfigured: false,
  readingShareIncludeTitle: true,
  readingShareIncludeBody: false,
  readingShareIncludeTranslation: false,
  readingShareIncludeSummary: false,
  syncIntervalMinutes: 30,
  syncOnStart: false,
  autoCheckUpdates: true
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const input = isRecord(value) ? value : {}
  return {
    language: normalizeLanguage(input.language),
    theme: normalizeTheme(input.theme),
    workspaceCollapsed: input.workspaceCollapsed === true,
    workspaceWidth: normalizeWorkspaceWidth(input.workspaceWidth),
    readerFontSize: normalizeReaderFontSize(input.readerFontSize),
    readerFontId: normalizeStringSetting(input.readerFontId, DEFAULT_DESKTOP_SETTINGS.readerFontId, 500),
    readerLineHeight: normalizeReaderLineHeight(input.readerLineHeight),
    readerContentWidth: normalizeReaderContentWidth(input.readerContentWidth),
    readerBackground: normalizeReaderBackground(input.readerBackground),
    readerBackgroundCustom: normalizeHexColor(input.readerBackgroundCustom, DEFAULT_DESKTOP_SETTINGS.readerBackgroundCustom),
    ttsVoiceURI: normalizeStringSetting(input.ttsVoiceURI, '', 2_000),
    aiSummaryPlacement: normalizeAiSummaryPlacement(input.aiSummaryPlacement),
    aiSummaryPanelSize: normalizeAiSummaryPanelSize(input.aiSummaryPanelSize),
    readingShareConfigured: input.readingShareConfigured === true,
    readingShareIncludeTitle: input.readingShareIncludeTitle === undefined ? true : input.readingShareIncludeTitle === true,
    readingShareIncludeBody: input.readingShareIncludeBody === true,
    readingShareIncludeTranslation: input.readingShareIncludeTranslation === true,
    readingShareIncludeSummary: input.readingShareIncludeSummary === true,
    syncIntervalMinutes: normalizeSyncInterval(input.syncIntervalMinutes),
    syncOnStart: input.syncOnStart === true,
    autoCheckUpdates: input.autoCheckUpdates === undefined ? true : input.autoCheckUpdates === true
  }
}

export function normalizeDesktopSettingsPatch(value: unknown): DesktopSettingsPatch {
  if (!isRecord(value)) throw new TypeError('Settings patch must be an object')

  const patch: DesktopSettingsPatch = {}
  if ('language' in value) patch.language = normalizeLanguage(value.language)
  if ('theme' in value) patch.theme = normalizeTheme(value.theme)
  if ('workspaceCollapsed' in value) {
    if (typeof value.workspaceCollapsed !== 'boolean') {
      throw new TypeError('workspaceCollapsed must be a boolean')
    }
    patch.workspaceCollapsed = value.workspaceCollapsed
  }
  if ('workspaceWidth' in value) patch.workspaceWidth = normalizeWorkspaceWidth(value.workspaceWidth)
  if ('readerFontSize' in value) patch.readerFontSize = normalizeReaderFontSize(value.readerFontSize)
  if ('readerFontId' in value) patch.readerFontId = normalizeStringSetting(value.readerFontId, DEFAULT_DESKTOP_SETTINGS.readerFontId, 500)
  if ('readerLineHeight' in value) patch.readerLineHeight = normalizeReaderLineHeight(value.readerLineHeight)
  if ('readerContentWidth' in value) patch.readerContentWidth = normalizeReaderContentWidth(value.readerContentWidth)
  if ('readerBackground' in value) patch.readerBackground = normalizeReaderBackground(value.readerBackground)
  if ('readerBackgroundCustom' in value) patch.readerBackgroundCustom = normalizeHexColor(value.readerBackgroundCustom, DEFAULT_DESKTOP_SETTINGS.readerBackgroundCustom)
  if ('ttsVoiceURI' in value) patch.ttsVoiceURI = normalizeStringSetting(value.ttsVoiceURI, '', 2_000)
  if ('aiSummaryPlacement' in value) patch.aiSummaryPlacement = normalizeAiSummaryPlacement(value.aiSummaryPlacement)
  if ('aiSummaryPanelSize' in value) patch.aiSummaryPanelSize = normalizeAiSummaryPanelSize(value.aiSummaryPanelSize)
  if ('readingShareConfigured' in value) {
    if (typeof value.readingShareConfigured !== 'boolean') throw new TypeError('readingShareConfigured must be a boolean')
    patch.readingShareConfigured = value.readingShareConfigured
  }
  if ('readingShareIncludeTitle' in value) {
    if (typeof value.readingShareIncludeTitle !== 'boolean') throw new TypeError('readingShareIncludeTitle must be a boolean')
    patch.readingShareIncludeTitle = value.readingShareIncludeTitle
  }
  if ('readingShareIncludeBody' in value) {
    if (typeof value.readingShareIncludeBody !== 'boolean') throw new TypeError('readingShareIncludeBody must be a boolean')
    patch.readingShareIncludeBody = value.readingShareIncludeBody
  }
  if ('readingShareIncludeTranslation' in value) {
    if (typeof value.readingShareIncludeTranslation !== 'boolean') throw new TypeError('readingShareIncludeTranslation must be a boolean')
    patch.readingShareIncludeTranslation = value.readingShareIncludeTranslation
  }
  if ('readingShareIncludeSummary' in value) {
    if (typeof value.readingShareIncludeSummary !== 'boolean') throw new TypeError('readingShareIncludeSummary must be a boolean')
    patch.readingShareIncludeSummary = value.readingShareIncludeSummary
  }
  if ('syncIntervalMinutes' in value) {
    if (!isSyncInterval(value.syncIntervalMinutes)) {
      throw new TypeError('syncIntervalMinutes must be a supported interval')
    }
    patch.syncIntervalMinutes = value.syncIntervalMinutes
  }
  if ('syncOnStart' in value) {
    if (typeof value.syncOnStart !== 'boolean') throw new TypeError('syncOnStart must be a boolean')
    patch.syncOnStart = value.syncOnStart
  }
  if ('autoCheckUpdates' in value) {
    if (typeof value.autoCheckUpdates !== 'boolean') throw new TypeError('autoCheckUpdates must be a boolean')
    patch.autoCheckUpdates = value.autoCheckUpdates
  }
  return patch
}

function normalizeLanguage(value: unknown): DesktopLanguagePreference {
  return value === 'zh' || value === 'en' || value === 'system' ? value : 'system'
}

function normalizeTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_DESKTOP_SETTINGS.theme
}

function normalizeReaderBackground(value: unknown): ReaderBackgroundPreference {
  return value === 'paper' || value === 'warm' || value === 'sepia' || value === 'mint' || value === 'custom' || value === 'theme'
    ? value
    : DEFAULT_DESKTOP_SETTINGS.readerBackground
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback
}

function normalizeWorkspaceWidth(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DESKTOP_SETTINGS.workspaceWidth
  return Math.round(Math.min(Math.max(numberValue, 320), 560))
}

function normalizeReaderFontSize(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DESKTOP_SETTINGS.readerFontSize
  return Math.round(Math.min(Math.max(numberValue, 14), 22))
}

function normalizeReaderLineHeight(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DESKTOP_SETTINGS.readerLineHeight
  return Math.round(Math.min(Math.max(numberValue, 1.5), 2.2) * 100) / 100
}

function normalizeReaderContentWidth(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DESKTOP_SETTINGS.readerContentWidth
  return Math.round(Math.min(Math.max(numberValue, 600), 1000))
}

function normalizeAiSummaryPlacement(value: unknown): AiSummaryPlacement {
  return value === 'replace' || value === 'left' || value === 'right' || value === 'top' || value === 'bottom'
    ? value
    : DEFAULT_DESKTOP_SETTINGS.aiSummaryPlacement
}

function normalizeAiSummaryPanelSize(value: unknown): number {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_DESKTOP_SETTINGS.aiSummaryPanelSize
  return Math.round(Math.min(Math.max(numberValue, 220), 640))
}

function normalizeStringSetting(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.length <= maxLength ? value : fallback
}

function normalizeSyncInterval(value: unknown): SyncIntervalMinutes {
  return isSyncInterval(value) ? value : DEFAULT_DESKTOP_SETTINGS.syncIntervalMinutes
}

function isSyncInterval(value: unknown): value is SyncIntervalMinutes {
  return typeof value === 'number' && SYNC_INTERVAL_OPTIONS.includes(value as SyncIntervalMinutes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

