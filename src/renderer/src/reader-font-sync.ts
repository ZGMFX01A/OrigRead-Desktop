import type { ReaderFontEntry } from '../../shared/reader-font'

export function isCustomReaderFontId(fontId: string | null | undefined): fontId is string {
  return typeof fontId === 'string' && fontId.startsWith('custom:')
}

interface MissingReaderFontOptions {
  fontId: string | null | undefined
  currentFonts: ReaderFontEntry[]
  lastCheckedMissingFontId: string | null
  listReaderFonts(): Promise<ReaderFontEntry[]>
  onFontsUpdated(fonts: ReaderFontEntry[]): void
  onFallbackToDefault(): Promise<void>
  onError(error: unknown): void
}

export async function resolveMissingCustomReaderFont({
  fontId, currentFonts, lastCheckedMissingFontId, listReaderFonts, onFontsUpdated, onFallbackToDefault, onError
}: MissingReaderFontOptions): Promise<{ nextCheckedMissingFontId: string | null; fetched: boolean; fellBack: boolean }> {
  if (!isCustomReaderFontId(fontId) || currentFonts.some((font) => font.id === fontId)) {
    return { nextCheckedMissingFontId: null, fetched: false, fellBack: false }
  }
  if (lastCheckedMissingFontId === fontId) return { nextCheckedMissingFontId: fontId, fetched: false, fellBack: false }
  try {
    const fonts = await listReaderFonts()
    onFontsUpdated(fonts)
    if (fonts.some((font) => font.id === fontId)) return { nextCheckedMissingFontId: null, fetched: true, fellBack: false }
    await onFallbackToDefault()
    return { nextCheckedMissingFontId: fontId, fetched: true, fellBack: true }
  } catch (error) {
    onError(error)
    // 失败也标记已检查，避免 IPC 错误触发重试风暴。
    return { nextCheckedMissingFontId: fontId, fetched: true, fellBack: false }
  }
}
