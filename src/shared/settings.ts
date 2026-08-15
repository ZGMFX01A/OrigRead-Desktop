import type { DesktopLanguage } from './locale'

export type DesktopLanguagePreference = 'system' | DesktopLanguage
export type AiSummaryPlacement = 'replace' | 'left' | 'right' | 'top' | 'bottom'

export const SYNC_INTERVAL_OPTIONS = [0, 15, 30, 60, 120, 180, 360, 720, 1440] as const
export type SyncIntervalMinutes = typeof SYNC_INTERVAL_OPTIONS[number]

export interface DesktopSettings {
  language: DesktopLanguagePreference
  workspaceCollapsed: boolean
  workspaceWidth: number
  readerFontSize: number
  readerFontId: string
  readerLineHeight: number
  readerContentWidth: number
  ttsVoiceURI: string
  aiSummaryPlacement: AiSummaryPlacement
  aiSummaryPanelSize: number
  syncIntervalMinutes: SyncIntervalMinutes
  syncOnStart: boolean
}

export type DesktopSettingsPatch = Partial<DesktopSettings>

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  language: 'system',
  workspaceCollapsed: false,
  workspaceWidth: 420,
  readerFontSize: 17,
  readerFontId: 'system',
  readerLineHeight: 1.85,
  readerContentWidth: 760,
  ttsVoiceURI: '',
  aiSummaryPlacement: 'replace',
  aiSummaryPanelSize: 360,
  syncIntervalMinutes: 30,
  syncOnStart: false
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const input = isRecord(value) ? value : {}
  return {
    language: normalizeLanguage(input.language),
    workspaceCollapsed: input.workspaceCollapsed === true,
    workspaceWidth: normalizeWorkspaceWidth(input.workspaceWidth),
    readerFontSize: normalizeReaderFontSize(input.readerFontSize),
    readerFontId: normalizeStringSetting(input.readerFontId, DEFAULT_DESKTOP_SETTINGS.readerFontId, 500),
    readerLineHeight: normalizeReaderLineHeight(input.readerLineHeight),
    readerContentWidth: normalizeReaderContentWidth(input.readerContentWidth),
    ttsVoiceURI: normalizeStringSetting(input.ttsVoiceURI, '', 2_000),
    aiSummaryPlacement: normalizeAiSummaryPlacement(input.aiSummaryPlacement),
    aiSummaryPanelSize: normalizeAiSummaryPanelSize(input.aiSummaryPanelSize),
    syncIntervalMinutes: normalizeSyncInterval(input.syncIntervalMinutes),
    syncOnStart: input.syncOnStart === true
  }
}

export function normalizeDesktopSettingsPatch(value: unknown): DesktopSettingsPatch {
  if (!isRecord(value)) throw new TypeError('Settings patch must be an object')

  const patch: DesktopSettingsPatch = {}
  if ('language' in value) patch.language = normalizeLanguage(value.language)
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
  if ('ttsVoiceURI' in value) patch.ttsVoiceURI = normalizeStringSetting(value.ttsVoiceURI, '', 2_000)
  if ('aiSummaryPlacement' in value) patch.aiSummaryPlacement = normalizeAiSummaryPlacement(value.aiSummaryPlacement)
  if ('aiSummaryPanelSize' in value) patch.aiSummaryPanelSize = normalizeAiSummaryPanelSize(value.aiSummaryPanelSize)
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
  return patch
}

function normalizeLanguage(value: unknown): DesktopLanguagePreference {
  return value === 'zh' || value === 'en' || value === 'system' ? value : 'system'
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

